import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  shell,
  dialog,
  systemPreferences,
} from 'electron';
import { defaultDataDir, expandPath, loadConfig } from '@cofounderos/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const workspaceRoot = resolveRuntimeWorkspaceRoot();
if (app.isPackaged && !process.env.COFOUNDEROS_DATA_DIR) {
  process.env.COFOUNDEROS_USE_PLATFORM_DATA_DIR ??= '1';
}
const dataDir = defaultDataDir();
const configPath = path.join(dataDir, 'config.yaml');
const markdownExportDir = path.join(dataDir, 'export/markdown');
const windowStatePath = path.join(dataDir, 'desktop-window.json');
const rendererDevUrl = process.env.COFOUNDEROS_RENDERER_URL;

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 860, height: 760 };

function loadWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(windowStatePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    const width = typeof parsed.width === 'number' && parsed.width > 400 ? parsed.width : DEFAULT_WINDOW_STATE.width;
    const height = typeof parsed.height === 'number' && parsed.height > 300 ? parsed.height : DEFAULT_WINDOW_STATE.height;
    const out: WindowState = { width, height };
    if (typeof parsed.x === 'number' && Number.isFinite(parsed.x)) out.x = parsed.x;
    if (typeof parsed.y === 'number' && Number.isFinite(parsed.y)) out.y = parsed.y;
    if (parsed.maximized === true) out.maximized = true;
    return out;
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const state: WindowState = win.isMaximized()
      ? { ...DEFAULT_WINDOW_STATE, maximized: true }
      : (() => {
          const [width, height] = win.getSize();
          const [x, y] = win.getPosition();
          return { width, height, x, y };
        })();
    fs.mkdirSync(path.dirname(windowStatePath), { recursive: true });
    fs.writeFileSync(windowStatePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    appendLog(`Failed to persist window state: ${String(err)}`);
  }
}

let tray: Tray | null = null;
let statusWindow: BrowserWindow | null = null;
let managedRuntime: RuntimeServiceClient | null = null;
let statusItemHelper: ChildProcess | null = null;
let lastLogs: string[] = [];
let lastOverview: RuntimeOverview | null = null;

const useMacAccessoryMode =
  process.platform === 'darwin' && process.env.COFOUNDEROS_DESKTOP_SHOW_DOCK !== '1';

type RuntimeOverview = {
  status: string;
  configPath: string;
  dataDir: string;
  storageRoot: string;
  capture: {
    running: boolean;
    paused: boolean;
    eventsToday: number;
    eventsLastHour?: number;
  };
  storage: {
    totalEvents: number;
    totalAssetBytes: number;
  };
  index: {
    strategy?: string;
    rootPath?: string;
    pageCount: number;
    eventsCovered: number;
    categories?: Array<{
      name: string;
      pageCount: number;
      summaryPath?: string;
      lastUpdated: string | null;
      recentPages?: Array<{
        path: string;
        title: string;
        summary: string | null;
        lastUpdated: string;
      }>;
    }>;
  };
  indexing: {
    running: boolean;
    currentJob: string | null;
    startedAt: string | null;
    lastCompletedAt: string | null;
  };
  model: {
    name: string;
    ready: boolean;
  };
  exports: Array<{
    name: string;
    running: boolean;
    lastSync?: string | null;
    pendingUpdates?: number;
    errorCount?: number;
  }>;
};

type MenuBarCaptureState = 'capturing' | 'paused' | 'stopped';

type MenuBarIndicator = {
  state: MenuBarCaptureState;
  label: string;
};

type RuntimeDoctorCheck = {
  area: string;
  status: string;
  message: string;
  detail?: string;
  action?: string;
};

type RuntimeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

type RuntimeEvent = {
  id: number;
  event: string;
  payload: unknown;
};

class RuntimeServiceClient {
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }>();

  constructor() {
    const servicePath = path.join(here, 'runtime-service.js');
    const command = app.isPackaged
      ? process.execPath
      : process.env.COFUNDEROS_NODE ?? 'node';
    const args = [servicePath];
    const env = {
      ...process.env,
      COFOUNDEROS_RESOURCE_ROOT: workspaceRoot,
      ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
    this.child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => appendLog(chunk.trimEnd()));
    this.child.on('error', (err) => this.rejectAll(err));
    this.child.on('exit', (code, signal) => {
      const err = new Error(`runtime service exited (code=${code}, signal=${signal})`);
      this.rejectAll(err);
      if (managedRuntime === this) managedRuntime = null;
      applyMenuBarIndicator({ state: 'stopped', label: 'CofounderOS — stopped' });
      void refreshTray();
      if (statusWindow) void renderStatusWindow();
    });
    this.on('bootstrap-progress', (payload) => {
      statusWindow?.webContents.send('cofounderos:bootstrap-progress', payload);
    });
    this.on('overview', (payload) => {
      lastOverview = payload as RuntimeOverview;
      applyMenuBarIndicator(getMenuBarIndicator(lastOverview));
      statusWindow?.webContents.send('cofounderos:overview', payload);
    });

    const rl = readline.createInterface({
      input: this.child.stdout!,
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => this.handleLine(line));
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.child.stdin?.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  on(event: string, callback: (payload: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(callback);
    this.listeners.set(event, listeners);
  }

  close(): void {
    this.child.kill('SIGTERM');
    this.rejectAll(new Error('runtime service closed'));
  }

  private handleLine(line: string): void {
    let response: RuntimeResponse | RuntimeEvent;
    try {
      response = JSON.parse(line) as RuntimeResponse | RuntimeEvent;
    } catch {
      appendLog(`[runtime stdout] ${line}`);
      return;
    }
    if ('event' in response) {
      for (const listener of this.listeners.get(response.event) ?? []) {
        listener(response.payload);
      }
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error));
  }

  private rejectAll(err: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

app.setName('CofounderOS');
if (process.platform === 'darwin') {
  // Influences the application menu title shown when the app is in
  // foreground (regular activation policy). Without this, macOS falls
  // back to the bundle's CFBundleName which is "Electron" in dev builds.
  try {
    app.setAboutPanelOptions({ applicationName: 'CofounderOS' });
  } catch {
    // setAboutPanelOptions is best-effort.
  }
}

app.whenReady().then(async () => {
  registerRuntimeIpc();
  applyBrandDockIcon();
  if (useMacAccessoryMode) {
    // Run as a proper menu-bar/accessory app. In regular foreground
    // mode Electron gets normal app menus ("Electron", "File", "Edit"...)
    // and the status item can fail to present visibly when launched from
    // the unbundled dev binary on Sequoia.
    enterMacAccessoryMode();
  }
  if (process.platform === 'darwin') {
    if (!startNativeStatusItem()) {
      createElectronTrayFallback();
    }
  } else {
    createElectronTrayFallback();
  }
  await startDaemonIfNeeded();
  if (process.env.COFOUNDEROS_DESKTOP_SHOW_ON_START !== '0') {
    await showStatusWindow();
  }
});

app.on('window-all-closed', () => {
  // Keep the tray process alive after the status window closes.
});

app.on('before-quit', () => {
  if (statusItemHelper && !statusItemHelper.killed) {
    statusItemHelper.kill('SIGTERM');
  }
  if (managedRuntime) {
    managedRuntime.close();
  }
});

function createElectronTrayFallback(): void {
  try {
    tray = new Tray(makeTrayImage());
    applyMenuBarIndicator(getMenuBarIndicator(lastOverview));
    appendLog('Electron tray fallback created');
    void refreshTray();
    // Keep the tray menu's "N today" line live without hammering the
    // runtime; 15s is plenty for an at-a-glance count and well below
    // any user-noticeable staleness on a context menu open.
    const trayRefreshTimer = setInterval(() => {
      void refreshTray();
    }, 15000);
    app.once('before-quit', () => clearInterval(trayRefreshTimer));
    tray.on('click', () => {
      void showStatusWindow();
    });
  } catch (err) {
    appendLog(`Tray icon failed to create: ${String(err)}`);
    void dialog.showErrorBox(
      'CofounderOS tray failed to load',
      `${String(err)}\n\nThe app will still run; use the status window to control it.`,
    );
  }
}

function startNativeStatusItem(): boolean {
  const helperPath = path.resolve(here, 'native/cofounderos-status-item');
  try {
    const helper = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    statusItemHelper = helper;
    helper.stdout?.setEncoding('utf8');
    helper.stderr?.setEncoding('utf8');
    helper.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        appendLog(`[status-item] ${line}`);
        try {
          const msg = JSON.parse(line) as { kind?: string };
          if (msg.kind === 'show-status') void showStatusWindow();
          if (msg.kind === 'quit') app.quit();
          if (msg.kind === 'ready') {
            appendLog('Native macOS status item ready');
            applyMenuBarIndicator(getMenuBarIndicator(lastOverview));
          }
        } catch {
          // Non-JSON stdout is just diagnostic output.
        }
      }
    });
    helper.stderr?.on('data', (chunk: string) => {
      appendLog(`[status-item stderr] ${chunk.trimEnd()}`);
    });
    helper.on('exit', (code, signal) => {
      appendLog(`Native status item exited (code=${code}, signal=${signal})`);
      if (statusItemHelper === helper) statusItemHelper = null;
    });
    helper.on('error', (err) => {
      appendLog(`Native status item failed to start: ${String(err)}`);
      if (statusItemHelper === helper) statusItemHelper = null;
    });
    appendLog(`Starting native macOS status item: ${helperPath}`);
    applyMenuBarIndicator(getMenuBarIndicator(lastOverview));
    return true;
  } catch (err) {
    appendLog(`Native status item unavailable: ${String(err)}`);
    statusItemHelper = null;
    return false;
  }
}

function getMenuBarIndicator(
  overview: RuntimeOverview | null,
  healthOk = overview?.status === 'running',
  labelOverride?: string,
): MenuBarIndicator {
  if (!healthOk) {
    return { state: 'stopped', label: labelOverride ?? 'CofounderOS — stopped' };
  }
  if (overview?.capture.running && !overview.capture.paused) {
    const eventsToday = overview.capture.eventsToday ?? 0;
    return {
      state: 'capturing',
      label: labelOverride ?? `CofounderOS — capturing (${eventsToday} today)`,
    };
  }
  if (overview?.capture.running && overview.capture.paused) {
    return { state: 'paused', label: labelOverride ?? 'CofounderOS — capture paused' };
  }
  return { state: 'stopped', label: labelOverride ?? 'CofounderOS — idle' };
}

function applyMenuBarIndicator(indicator: MenuBarIndicator): void {
  if (tray) {
    if (process.platform === 'darwin') tray.setTitle(makeTrayTitle(indicator.state));
    tray.setToolTip(indicator.label);
  }
  if (!statusItemHelper || statusItemHelper.killed || !statusItemHelper.stdin?.writable) return;
  statusItemHelper.stdin.write(
    `${JSON.stringify({ kind: 'set-state', state: indicator.state, label: indicator.label })}\n`,
    (err) => {
      if (err) appendLog(`Native status item update failed: ${String(err)}`);
    },
  );
}

function makeTrayTitle(state: MenuBarCaptureState): string {
  switch (state) {
    case 'capturing':
      return ' CO CAP';
    case 'paused':
      return ' CO PAUSE';
    case 'stopped':
      return ' CO STOP';
  }
}

async function refreshTray(): Promise<void> {
  if (!tray) return;
  const health = await getHealth();
  // Prefer the cached push'd overview to avoid round-tripping the runtime
  // on every tray refresh tick. Falls back to an explicit call when
  // there's no cached value yet (e.g. cold start).
  const overview =
    lastOverview ??
    (managedRuntime
      ? await managedRuntime.call<RuntimeOverview>('overview').catch(() => null)
      : null);
  const captureLive = health.ok && !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = health.ok && !!overview?.capture.running && !!overview.capture.paused;
  const eventsToday = overview?.capture.eventsToday ?? 0;

  const statusLabel = !health.ok
    ? 'CofounderOS — stopped'
    : captureLive
      ? `CofounderOS — capturing (${eventsToday} today)`
      : capturePaused
        ? 'CofounderOS — capture paused'
        : 'CofounderOS — idle';
  applyMenuBarIndicator(getMenuBarIndicator(overview, health.ok, statusLabel));

  const captureToggle: Electron.MenuItemConstructorOptions =
    captureLive
      ? {
          label: 'Pause Capture',
          accelerator: 'CommandOrControl+.',
          click: async () => {
            try { await (await getRuntimeForRequest()).call('pauseCapture'); } catch (err) {
              appendLog(`Pause capture failed: ${String(err)}`);
            }
            await refreshTray();
          },
        }
      : capturePaused
        ? {
            label: 'Resume Capture',
            accelerator: 'CommandOrControl+.',
            click: async () => {
              try { await (await getRuntimeForRequest()).call('resumeCapture'); } catch (err) {
                appendLog(`Resume capture failed: ${String(err)}`);
              }
              await refreshTray();
            },
          }
        : {
            label: 'Start CofounderOS',
            click: () => void startRuntime(),
            enabled: !health.ok && !managedRuntime,
          };

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Open CofounderOS',
      accelerator: 'CommandOrControl+O',
      click: () => void showStatusWindow(),
    },
    captureToggle,
    { type: 'separator' },
    {
      label: 'Run Doctor',
      click: () => void showStatusWindow({ focus: 'doctor' }),
    },
    {
      label: 'Reveal Files',
      submenu: [
        {
          label: 'Markdown Export',
          click: () => void shell.openPath(markdownExportDir),
        },
        {
          label: 'Data Folder',
          click: () => void shell.openPath(dataDir),
        },
        {
          label: 'Config File',
          click: () => void shell.openPath(configPath),
        },
      ],
    },
    { type: 'separator' },
    ...(managedRuntime
      ? ([
          {
            label: 'Stop Managed Runtime',
            click: () => void stopManagedRuntime(),
          } satisfies Electron.MenuItemConstructorOptions,
        ])
      : []),
    {
      label: 'Quit',
      accelerator: 'CommandOrControl+Q',
      click: () => app.quit(),
    },
  ]));
}

async function showStatusWindow(_opts: { focus?: 'doctor' } = {}): Promise<void> {
  enterMacStatusWindowMode();
  if (!statusWindow) {
    const brandIconPath = resolveBrandIconPath();
    const savedState = loadWindowState();
    statusWindow = new BrowserWindow({
      width: savedState.width,
      height: savedState.height,
      ...(savedState.x !== undefined ? { x: savedState.x } : {}),
      ...(savedState.y !== undefined ? { y: savedState.y } : {}),
      title: 'CofounderOS Status',
      show: false,
      ...(brandIconPath ? { icon: brandIconPath } : {}),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(here, 'preload.cjs'),
      },
    });
    if (savedState.maximized) statusWindow.maximize();

    // Debounce persistence so a drag doesn't write a hundred files in a
    // row — most of the time we just save once when motion settles.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleSave = () => {
      if (!statusWindow) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (statusWindow && !statusWindow.isDestroyed()) saveWindowState(statusWindow);
      }, 400);
    };
    statusWindow.on('resize', scheduleSave);
    statusWindow.on('move', scheduleSave);
    statusWindow.on('maximize', scheduleSave);
    statusWindow.on('unmaximize', scheduleSave);

    statusWindow.on('close', () => {
      if (statusWindow && !statusWindow.isDestroyed()) saveWindowState(statusWindow);
    });
    statusWindow.on('closed', () => {
      statusWindow = null;
      enterMacAccessoryMode();
    });
    statusWindow.webContents.on('console-message', ({ level, message }) => {
      appendLog(`[renderer:${level}] ${message}`);
    });
    statusWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      appendLog(`[renderer] failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
    });
    statusWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
      appendLog(`[renderer] preload failed ${preloadPath}: ${error.message}`);
    });
  }
  await renderStatusWindow();
  statusWindow.show();
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
  statusWindow.focus();
}

function enterMacAccessoryMode(): void {
  if (!useMacAccessoryMode) return;
  app.setActivationPolicy('accessory');
  app.dock?.hide();
}

function enterMacStatusWindowMode(): void {
  if (!useMacAccessoryMode) return;
  app.setActivationPolicy('regular');
  void app.dock?.show();
}

async function renderStatusWindow(): Promise<void> {
  const win = statusWindow;
  if (!win || win.isDestroyed()) return;
  const sendInitialState = () => {
    if (win.isDestroyed()) return;
    win.webContents.send('cofounderos:desktop-logs', lastLogs.slice(-120).join('\n'));
    if (lastOverview) {
      win.webContents.send('cofounderos:overview', lastOverview);
    }
  };
  win.webContents.once('did-finish-load', sendInitialState);
  try {
    if (rendererDevUrl) {
      await win.loadURL(rendererDevUrl);
    } else {
      await win.loadFile(path.join(here, 'renderer', 'index.html'));
    }
  } catch (err) {
    win.webContents.removeListener('did-finish-load', sendInitialState);
    if (isExpectedDevRendererLoadFailure(err)) {
      appendLog(`Dev renderer navigation interrupted: ${String(err)}`);
      return;
    }
    throw err;
  }
}

function isExpectedDevRendererLoadFailure(err: unknown): boolean {
  if (!rendererDevUrl) return false;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('ERR_ABORTED') ||
    message.includes('ERR_FAILED') ||
    message.includes('ERR_CONNECTION_REFUSED')
  );
}

async function startRuntime(): Promise<void> {
  // The subprocess may already be alive (managedRuntime is set) yet the
  // runtime inside it could be stopped — e.g. after saveConfigPatch which
  // tears handles down so the new config can re-apply. Always send a
  // start request through the existing client in that case; runtime.start
  // is idempotent when status === 'running'.
  //
  // IMPORTANT: do NOT call renderStatusWindow here. That reloads the
  // renderer HTML and would remount the React tree, wiping any in-flight
  // UI state (e.g. the onboarding step). The renderer keeps itself fresh
  // via its own polling.
  if (managedRuntime) {
    try {
      await managedRuntime.call('start');
      appendLog('CofounderOS runtime started (existing client).');
    } catch (err) {
      appendLog(`Runtime restart on existing client failed: ${String(err)}`);
      void dialog.showErrorBox('CofounderOS failed to start', String(err));
    } finally {
      await refreshTray();
    }
    return;
  }
  appendLog('Starting CofounderOS runtime from desktop...');
  const runtime = new RuntimeServiceClient();
  managedRuntime = runtime;
  try {
    await runtime.call('start');
    appendLog('CofounderOS runtime started.');
  } catch (err) {
    runtime.close();
    managedRuntime = null;
    appendLog(`Runtime failed to start: ${String(err)}`);
    void dialog.showErrorBox('CofounderOS failed to start', String(err));
  } finally {
    await refreshTray();
    if (statusWindow) await renderStatusWindow();
  }
}

async function startDaemonIfNeeded(): Promise<void> {
  if (process.env.COFOUNDEROS_DESKTOP_AUTOSTART === '0') {
    appendLog('Desktop autostart disabled by COFOUNDEROS_DESKTOP_AUTOSTART=0.');
    return;
  }
  const health = await getHealth();
  if (health.ok) {
    appendLog('CofounderOS runtime already running; desktop will monitor it.');
    await refreshTray();
    return;
  }
  await startRuntime();
}

async function stopManagedRuntime(): Promise<void> {
  if (!managedRuntime) return;
  appendLog('Stopping managed CofounderOS runtime...');
  const runtime = managedRuntime;
  managedRuntime = null;
  await runtime.call('stop').catch((err) => appendLog(`Runtime stop failed: ${String(err)}`));
  runtime.close();
  applyMenuBarIndicator({ state: 'stopped', label: 'CofounderOS — stopped' });
  await refreshTray();
  if (statusWindow) await renderStatusWindow();
}

async function getHealth(): Promise<{ ok: boolean; text: string }> {
  if (managedRuntime) {
    try {
      const overview = await managedRuntime.call<RuntimeOverview>('overview');
      return {
        ok: overview.status === 'running',
        text: `${overview.status}; capture running=${overview.capture.running}`,
      };
    } catch (err) {
      return { ok: false, text: String(err) };
    }
  }
  try {
    const res = await fetch('http://127.0.0.1:3456/health', {
      signal: AbortSignal.timeout(1200),
    });
    const text = await res.text();
    return { ok: res.ok, text };
  } catch (err) {
    return { ok: false, text: String(err) };
  }
}

async function getRuntimeStatusText(): Promise<string> {
  const runtime = await getRuntimeForRequest();
  const overview = await runtime.call<RuntimeOverview>('overview');
  return [
    '# CofounderOS runtime',
    '',
    `status: ${overview.status}`,
    `config: ${overview.configPath}`,
    `data: ${overview.dataDir}`,
    '',
    '## Memory capture',
    `running: ${overview.capture.running}`,
    `paused: ${overview.capture.paused}`,
    `events today: ${overview.capture.eventsToday}`,
    '',
    '## Storage',
    `root: ${overview.storageRoot}`,
    `events: ${overview.storage.totalEvents}`,
    `assets: ${formatBytes(overview.storage.totalAssetBytes)}`,
    '',
    '## Memory organization',
    `indexing: ${overview.indexing.running ? formatIndexingJob(overview.indexing.currentJob) : 'idle'}`,
    `pages: ${overview.index.pageCount}`,
    `events covered: ${overview.index.eventsCovered}`,
    '',
    '## Local AI model',
    `${overview.model.name}: ${overview.model.ready ? 'ready' : 'not ready'}`,
    '',
    '## Exports',
    ...overview.exports.map((exp) => `${exp.name}: ${exp.running ? 'running' : 'stopped'}`),
  ].join('\n');
}

function formatIndexingJob(job: string | null): string {
  if (job === 'index-reorganise') return 'reorganising';
  if (job === 'index-incremental') return 'indexing new memories';
  return 'indexing';
}

async function getRuntimeDoctorText(): Promise<string> {
  const runtime = await getRuntimeForRequest();
  const checks = await runtime.call<RuntimeDoctorCheck[]>('doctor');
  const failCount = checks.filter((check) => check.status === 'fail').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;
  return [
    '# CofounderOS doctor',
    '',
    ...checks.map((check) => {
      const detail = check.detail ? `\n    ${check.detail}` : '';
      const action = check.action ? `\n    next: ${check.action}` : '';
      return `- [${check.status}] ${check.area}: ${check.message}${detail}${action}`;
    }),
    '',
    `summary: ${failCount} fail, ${warnCount} warn, ${checks.length - failCount - warnCount} ok/info`,
  ].join('\n');
}

const execFileP = promisify(execFile);

/**
 * Probe whether the OpenAI Whisper CLI is installed and runnable.
 * Used by the audio onboarding step and the Settings → Audio tab so
 * users get an honest "installed / not installed" signal instead of
 * silently producing nothing when audio capture is enabled.
 *
 * We probe the literal `whisper` command (matching the runtime config
 * default `capture.audio.whisper_command`) on PATH plus a few common
 * install locations; advanced users with custom commands set their
 * config and the runtime preflight handles it from there.
 */
async function probeWhisperCli(): Promise<{
  available: boolean;
  path?: string;
  version?: string;
  triedCommand?: string;
}> {
  const command = 'whisper';
  const env = whisperEnv();
  try {
    const resolvedPath = await whichOnPath(command, env);
    if (!resolvedPath) throw new Error('whisper not found on PATH');
    const help = await execFileP(resolvedPath, ['--help'], {
      env,
      timeout: 30_000,
      maxBuffer: 1 << 20,
    });
    const firstLine = help.stdout.split('\n').find((l) => l.trim()) ?? '';
    return {
      available: true,
      path: resolvedPath,
      version: firstLine.slice(0, 200),
      triedCommand: command,
    };
  } catch {
    return { available: false, triedCommand: command };
  }
}

/**
 * Cross-platform `which` shim. macOS/Linux use `/usr/bin/which`; Windows
 * uses `where.exe` and may print multiple paths (one per line) — we keep
 * the first match in either case.
 */
async function whichOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const isWin = process.platform === 'win32';
  const tool = isWin ? 'where' : '/usr/bin/which';
  const target = isWin ? `${command}.exe` : command;
  try {
    const res = await execFileP(tool, [target], { env, timeout: 5_000 });
    const first = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return first ?? null;
  } catch {
    if (!isWin) return null;
    // `where.exe` returns non-zero when nothing matches — fall back to the
    // bare name and let `where` look it up as written (covers .cmd / .bat
    // shims that some installers create without a trailing .exe).
    try {
      const res = await execFileP('where', [command], { env, timeout: 5_000 });
      const first = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      return first ?? null;
    } catch {
      return null;
    }
  }
}

type WhisperInstaller = 'brew' | 'pipx' | 'pip3' | 'pip';

/**
 * Lightweight detector that the renderer uses to decide whether the
 * one-click "Install Whisper" path is available. Candidate order is
 * platform-aware so we surface the most user-friendly tool first.
 */
async function detectWhisperInstaller(): Promise<{
  installer: WhisperInstaller | null;
  installerPath?: string;
}> {
  const env = whisperEnv();
  const candidates = whisperInstallerCandidates();
  for (const tool of candidates) {
    const resolved = await whichOnPath(tool, env);
    if (resolved) return { installer: tool, installerPath: resolved };
  }
  return { installer: null };
}

function whisperInstallerCandidates(): WhisperInstaller[] {
  // openai-whisper is a Python package, so the only installers that
  // actually work cross-platform are pipx → pip3 → pip. Brew is added
  // first on macOS / Linuxbrew because it bundles the Python runtime
  // for users who don't have one. We deliberately don't list winget /
  // choco / apt because none of them ship `openai-whisper`.
  if (process.platform === 'win32') {
    return ['pipx', 'pip3', 'pip'];
  }
  if (process.platform === 'linux') {
    return ['pipx', 'pip3', 'pip', 'brew'];
  }
  return ['brew', 'pipx', 'pip3', 'pip'];
}

function whisperEnv(): NodeJS.ProcessEnv {
  // GUI Electron apps inherit a stripped PATH from the launcher
  // (launchd on macOS, the desktop session on Linux, the shell config
  // on Windows). Augment with the most common package-manager bin
  // locations so install + probe stay in sync across platforms.
  const extras: string[] = [];
  if (process.platform === 'darwin') {
    extras.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      `${process.env.HOME ?? ''}/.local/bin`,
      `${process.env.HOME ?? ''}/Library/Python/3.11/bin`,
      `${process.env.HOME ?? ''}/Library/Python/3.12/bin`,
    );
  } else if (process.platform === 'linux') {
    extras.push(
      '/usr/local/bin',
      '/usr/bin',
      `${process.env.HOME ?? ''}/.local/bin`,
      '/home/linuxbrew/.linuxbrew/bin',
    );
  } else if (process.platform === 'win32') {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const localAppData =
      process.env.LOCALAPPDATA ?? (home ? path.join(home, 'AppData', 'Local') : '');
    if (home) {
      extras.push(
        path.join(home, '.local', 'bin'),
        path.join(home, 'AppData', 'Roaming', 'Python', 'Scripts'),
      );
    }
    if (localAppData) {
      extras.push(path.join(localAppData, 'Programs', 'Python', 'Scripts'));
      // Common per-user pipx target on Windows.
      extras.push(path.join(localAppData, 'pipx', 'venvs'));
    }
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  const filtered = extras.filter((p) => p && p.length > 0);
  return {
    ...process.env,
    PATH: [process.env.PATH ?? process.env.Path, ...filtered].filter(Boolean).join(sep),
  };
}

interface WhisperInstallEvent {
  kind: 'started' | 'log' | 'finished' | 'failed';
  installer?: WhisperInstaller;
  message?: string;
  reason?: string;
  available?: boolean;
  path?: string;
}

let activeWhisperInstall: ChildProcess | null = null;

/**
 * One-click Whisper installer. Picks the first available package
 * manager appropriate for the platform, runs it in the background, and
 * streams stdout/stderr lines back to the renderer as
 * `whisper-install-progress` events. Re-probes on completion so the UI
 * can flip its "installed" state without the user touching anything.
 */
async function installWhisper(): Promise<{
  started: boolean;
  reason?: string;
  installer?: WhisperInstaller;
}> {
  if (activeWhisperInstall && !activeWhisperInstall.killed) {
    return { started: false, reason: 'Install already running.' };
  }
  const { installer, installerPath } = await detectWhisperInstaller();
  if (!installer || !installerPath) {
    const reason = whisperMissingInstallerMessage();
    emitWhisperInstall({ kind: 'failed', reason });
    return { started: false, reason };
  }
  const args = whisperInstallerArgs(installer);

  emitWhisperInstall({
    kind: 'started',
    installer,
    message: `${installer} ${args.join(' ')}`,
  });

  const env = whisperEnv();
  // Brew refuses to install with HOMEBREW_NO_AUTO_UPDATE unset and a
  // stale repo; setting it keeps the install short and predictable.
  if (installer === 'brew') env.HOMEBREW_NO_AUTO_UPDATE = '1';

  return await new Promise<{
    started: boolean;
    installer: WhisperInstaller;
  }>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(installerPath, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // winget / choco are .exe files; spawning them directly works
        // without a shell. No `shell: true` to keep injection-safe.
      });
    } catch (err) {
      emitWhisperInstall({
        kind: 'failed',
        installer,
        reason: err instanceof Error ? err.message : String(err),
      });
      resolve({ started: false, installer });
      return;
    }
    activeWhisperInstall = child;

    const forward = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (line.trim()) emitWhisperInstall({ kind: 'log', installer, message: line });
      });
    };
    forward(child.stdout);
    forward(child.stderr);

    child.on('error', (err) => {
      emitWhisperInstall({
        kind: 'failed',
        installer,
        reason: err.message,
      });
      activeWhisperInstall = null;
    });

    child.on('exit', async (code, signal) => {
      activeWhisperInstall = null;
      const probe = await probeWhisperCli();
      if (code === 0 || probe.available) {
        if (code !== 0) {
          emitWhisperInstall({
            kind: 'log',
            installer,
            message: `Installer exited with code ${code ?? 'unknown'}, but Whisper is available at ${
              probe.path ?? 'whisper'
            }.`,
          });
        }
        emitWhisperInstall({
          kind: 'finished',
          installer,
          available: probe.available,
          path: probe.path,
        });
      } else {
        emitWhisperInstall({
          kind: 'failed',
          installer,
          reason:
            signal != null
              ? `Install was interrupted (${signal}).`
              : `Install exited with code ${code ?? 'unknown'}. Check the log above for details.`,
        });
      }
    });

    resolve({ started: true, installer });
  });
}

function emitWhisperInstall(event: WhisperInstallEvent): void {
  const line =
    event.kind === 'log'
      ? `whisper-install [${event.installer}] ${event.message ?? ''}`
      : `whisper-install ${event.kind}${event.installer ? ` [${event.installer}]` : ''}${
          event.reason ? `: ${event.reason}` : event.message ? `: ${event.message}` : ''
        }`;
  appendLog(line);
  statusWindow?.webContents.send('cofounderos:whisper-install-progress', event);
}

function whisperInstallerArgs(installer: WhisperInstaller): string[] {
  switch (installer) {
    case 'brew':
      return ['install', 'openai-whisper'];
    case 'pipx':
      return ['install', 'openai-whisper'];
    case 'pip3':
    case 'pip':
      // `--user` keeps the install scoped to the current user on every
      // platform, avoiding sudo prompts on Linux/macOS and admin elev
      // on Windows. `-U` makes a no-op safe if it's already installed.
      return ['install', '--user', '-U', 'openai-whisper'];
  }
}

function whisperMissingInstallerMessage(): string {
  if (process.platform === 'win32') {
    return "Couldn't find pipx, pip3, or pip on this system. Install Python from python.org (be sure to check 'Add Python to PATH' in the installer), then click Install Whisper again.";
  }
  if (process.platform === 'linux') {
    return "Couldn't find pipx, pip3, or pip on this system. Install Python with pip (e.g. `sudo apt install python3-pip pipx` or your distro's equivalent), then click Install Whisper again.";
  }
  return "Couldn't find Homebrew, pipx, or pip on this system. Install Homebrew from brew.sh or pipx via `python3 -m pip install --user pipx`, then click Install Whisper again.";
}

async function probeFfprobe(): Promise<{ available: boolean; path?: string }> {
  const env = whisperEnv();
  const resolved = await whichOnPath('ffprobe', env);
  if (!resolved) return { available: false };
  return { available: true, path: resolved };
}

/**
 * macOS-only wrapper around `systemPreferences.getMediaAccessStatus`.
 * On other platforms we report `unsupported` so the renderer can omit
 * the permission row entirely.
 */
type MicStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unsupported';

function probeMicPermission(): { status: MicStatus } {
  if (process.platform !== 'darwin') return { status: 'unsupported' };
  try {
    const raw = systemPreferences.getMediaAccessStatus('microphone');
    // Electron declares `unknown` as a possible value (returned on
    // platforms where the API isn't meaningful); map it to our
    // `unsupported` bucket so the renderer has a single fallback case.
    if (raw === 'unknown') return { status: 'unsupported' };
    return { status: raw };
  } catch {
    return { status: 'unsupported' };
  }
}

async function requestMicPermission(): Promise<{ status: MicStatus }> {
  if (process.platform !== 'darwin') return { status: 'unsupported' };
  try {
    // `askForMediaAccess` triggers the system prompt the *first* time
    // it's called; subsequent calls return the cached decision without
    // re-prompting the user. Pair with `probeMicPermission` afterwards
    // to translate the boolean into our richer status enum.
    await systemPreferences.askForMediaAccess('microphone');
  } catch {
    /* ignore — we'll just return the current status below */
  }
  return probeMicPermission();
}

function registerRuntimeIpc(): void {
  ipcMain.handle('cofounderos:overview', async () => {
    return await getOverviewForRequest();
  });
  ipcMain.handle('cofounderos:doctor', async () => {
    return await (await getRuntimeForRequest()).call('doctor');
  });
  ipcMain.handle('cofounderos:read-config', async () => {
    return await (await getRuntimeForRequest()).call('readConfig');
  });
  ipcMain.handle('cofounderos:validate-config', async (_event, config: unknown) => {
    return await (await getRuntimeForRequest()).call('validateConfig', config);
  });
  ipcMain.handle('cofounderos:save-config-patch', async (_event, patch: unknown) => {
    return await (await getRuntimeForRequest()).call('saveConfigPatch', patch);
  });
  ipcMain.handle('cofounderos:list-journal-days', async () => {
    return await (await getRuntimeForRequest()).call('listJournalDays');
  });
  ipcMain.handle('cofounderos:get-journal-day', async (_event, day: string) => {
    return await (await getRuntimeForRequest()).call('getJournalDay', day);
  });
  ipcMain.handle('cofounderos:get-indexed-journal-day', async (_event, day: string) => {
    return await (await getRuntimeForRequest()).call('getIndexedJournalDay', day);
  });
  ipcMain.handle('cofounderos:search-frames', async (_event, query: unknown) => {
    return await (await getRuntimeForRequest()).call('searchFrames', query);
  });
  ipcMain.handle('cofounderos:explain-search-results', async (_event, query: unknown) => {
    return await (await getRuntimeForRequest()).call('explainSearchResults', query);
  });
  ipcMain.handle('cofounderos:get-frame-index-details', async (_event, frameId: string) => {
    return await (await getRuntimeForRequest()).call('getFrameIndexDetails', frameId);
  });
  ipcMain.handle('cofounderos:read-asset', async (_event, assetPath: string) => {
    const result = await (await getRuntimeForRequest()).call<{ base64: string }>('readAsset', assetPath);
    return new Uint8Array(Buffer.from(result.base64, 'base64'));
  });
  ipcMain.handle('cofounderos:start-runtime', async () => {
    await startRuntime();
    return await (await getRuntimeForRequest()).call('overview');
  });
  ipcMain.handle('cofounderos:stop-runtime', async () => {
    await stopManagedRuntime();
    return { stopped: true };
  });
  ipcMain.handle('cofounderos:pause-capture', async () => {
    return await (await getRuntimeForRequest()).call('pauseCapture');
  });
  ipcMain.handle('cofounderos:resume-capture', async () => {
    return await (await getRuntimeForRequest()).call('resumeCapture');
  });
  ipcMain.handle('cofounderos:trigger-index', async () => {
    return await (await getRuntimeForRequest()).call('triggerIndex');
  });
  ipcMain.handle('cofounderos:trigger-reorganise', async () => {
    return await (await getRuntimeForRequest()).call('triggerReorganise');
  });
  ipcMain.handle('cofounderos:trigger-full-reindex', async (_event, range: unknown) => {
    return await (await getRuntimeForRequest()).call('triggerFullReindex', range);
  });
  ipcMain.handle('cofounderos:bootstrap-model', async () => {
    return await (await getRuntimeForRequest()).call('bootstrapModel');
  });
  ipcMain.handle('cofounderos:get-start-at-login', async () => {
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('cofounderos:set-start-at-login', async (_event, enabled: boolean) => {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
    });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('cofounderos:open-path', async (_event, target: OpenPathTarget) => {
    const targetPath = await resolveOpenPathTarget(target);
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
    return { opened: targetPath };
  });
  ipcMain.handle('cofounderos:copy-text', async (_event, text: string) => {
    clipboard.writeText(text);
    return { copied: true };
  });
  ipcMain.handle('cofounderos:delete-frame', async (_event, frameId: string) => {
    return await (await getRuntimeForRequest()).call('deleteFrame', frameId);
  });
  ipcMain.handle('cofounderos:delete-frames-by-day', async (_event, day: string) => {
    return await (await getRuntimeForRequest()).call('deleteFramesByDay', day);
  });
  ipcMain.handle('cofounderos:delete-all-memory', async () => {
    return await (await getRuntimeForRequest()).call('deleteAllMemory');
  });
  ipcMain.handle('cofounderos:probe-whisper', async () => {
    return await probeWhisperCli();
  });
  ipcMain.handle('cofounderos:detect-whisper-installer', async () => {
    const detected = await detectWhisperInstaller();
    return { installer: detected.installer };
  });
  ipcMain.handle('cofounderos:install-whisper', async () => {
    return await installWhisper();
  });
  ipcMain.handle('cofounderos:probe-ffprobe', async () => {
    return await probeFfprobe();
  });
  ipcMain.handle('cofounderos:probe-mic-permission', async () => {
    return probeMicPermission();
  });
  ipcMain.handle('cofounderos:request-mic-permission', async () => {
    return await requestMicPermission();
  });
}

async function getOverviewForRequest(): Promise<RuntimeOverview | null> {
  try {
    return await (await getRuntimeForRequest()).call<RuntimeOverview>('overview');
  } catch (err) {
    if (isExpectedRuntimeServiceClosure(err)) {
      appendLog(`Overview request skipped while runtime service is restarting: ${String(err)}`);
      return lastOverview;
    }
    throw err;
  }
}

function isExpectedRuntimeServiceClosure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('runtime service closed') || message.includes('runtime service exited');
}

type OpenPathTarget =
  | 'config'
  | 'data'
  | 'markdown'
  | {
      target: 'markdown';
      category?: string;
    };

async function resolveOpenPathTarget(target: OpenPathTarget): Promise<string> {
  if (target === 'config') return configPath;
  if (target === 'data') return dataDir;
  if (target === 'markdown') return await getMarkdownExportDir();
  if (target && typeof target === 'object' && target.target === 'markdown') {
    const exportDir = await getMarkdownExportDir();
    if (!target.category) return exportDir;
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(target.category)) {
      throw new Error('Invalid export category');
    }
    return path.join(exportDir, target.category);
  }
  throw new Error('Unknown path target');
}

async function getMarkdownExportDir(): Promise<string> {
  try {
    const loaded = await loadConfig(configPath);
    const markdown = loaded.config.export.plugins.find(
      (plugin) => plugin.name === 'markdown' && plugin.enabled !== false,
    );
    const configuredPath = markdown?.path;
    if (typeof configuredPath === 'string' && configuredPath.trim()) {
      return expandPath(configuredPath);
    }
  } catch (err) {
    appendLog(`Could not resolve markdown export path from config: ${String(err)}`);
  }
  return markdownExportDir;
}

async function getRuntimeForRequest(): Promise<RuntimeServiceClient> {
  if (!managedRuntime) {
    managedRuntime = new RuntimeServiceClient();
  }
  return managedRuntime;
}

function appendLog(line: string): void {
  if (!line) return;
  lastLogs.push(...line.split(/\r?\n/).filter(Boolean).map((l) => {
    return `[${new Date().toLocaleTimeString()}] ${l}`;
  }));
  if (lastLogs.length > 400) lastLogs = lastLogs.slice(-400);
}

function resolveRuntimeWorkspaceRoot(): string {
  const envRoot = process.env.COFOUNDEROS_RESOURCE_ROOT;
  if (envRoot && envRoot.trim()) return envRoot;
  if (app.isPackaged) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      // Packaged builds should place plugins/ and native helpers under this
      // resource root so runtime plugin discovery does not depend on a repo.
      return path.join(resourcesPath, 'cofounderos');
    }
  }
  return repoRoot;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

function resolveBrandIconPath(): string | null {
  const candidates = [
    path.resolve(here, '../build/icon.png'),
    path.resolve(here, '../../build/icon.png'),
    path.resolve(repoRoot, 'packages/desktop/build/icon.png'),
  ];
  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function applyBrandDockIcon(): void {
  const iconPath = resolveBrandIconPath();
  if (!iconPath) {
    appendLog('Brand icon not found; cmd+tab will use default Electron icon.');
    return;
  }
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') {
      app.dock?.setIcon(image);
    }
    appendLog(`Brand icon loaded from ${iconPath}`);
  } catch (err) {
    appendLog(`Failed to apply brand icon: ${String(err)}`);
  }
}

function makeTrayImage(): Electron.NativeImage {
  // Load real on-disk PNG assets — Electron's nativeImage prefers a real
  // file path with @2x retina sibling on macOS, which gives us a reliably
  // visible status item slot on Sequoia. Buffer/data-URL inputs render
  // empty in some menu-bar scenarios.
  const candidates = [
    path.resolve(here, '../assets/trayTemplate.png'),
    path.resolve(here, '../../assets/trayTemplate.png'),
    path.resolve(repoRoot, 'packages/desktop/assets/trayTemplate.png'),
  ];
  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        image.setTemplateImage(true);
        appendLog(`Tray icon loaded from ${candidate}`);
        return image;
      }
    } catch {
      // try next candidate
    }
  }
  appendLog('Tray icon assets not found; falling back to in-memory PNG');
  const fallback = nativeImage.createFromBuffer(drawTrayPng());
  fallback.setTemplateImage(true);
  return fallback;
}

function drawTrayPng(): Buffer {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAQUlEQVR4nO3PsQ0AMAjA' +
    'sP7//0qUDhCJDAyNgg5BPcgZS5IkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkScf' +
    'YwQATTwHAyVLFpQAAAABJRU5ErkJggg==';
  return Buffer.from(base64, 'base64');
}

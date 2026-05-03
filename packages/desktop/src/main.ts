import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
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
} from 'electron';
import { defaultDataDir } from '@cofounderos/core';

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
    pageCount: number;
    eventsCovered: number;
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
  }>;
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
      void refreshTray();
      if (statusWindow) void renderStatusWindow();
    });
    this.on('bootstrap-progress', (payload) => {
      statusWindow?.webContents.send('cofounderos:bootstrap-progress', payload);
    });
    this.on('overview', (payload) => {
      lastOverview = payload as RuntimeOverview;
      statusWindow?.webContents.send('cofounderos:overview', payload);
    });
    this.on('agent-step', (payload) => {
      statusWindow?.webContents.send('cofounderos:agent-step', payload);
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
    if (process.platform === 'darwin') tray.setTitle(' CO');
    tray.setToolTip('CofounderOS — click for status');
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
          if (msg.kind === 'ready') appendLog('Native macOS status item ready');
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
    return true;
  } catch (err) {
    appendLog(`Native status item unavailable: ${String(err)}`);
    statusItemHelper = null;
    return false;
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
  const captureLive = !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  const eventsToday = overview?.capture.eventsToday ?? 0;

  const statusLabel = !health.ok
    ? 'CofounderOS — stopped'
    : captureLive
      ? `CofounderOS — capturing (${eventsToday} today)`
      : capturePaused
        ? 'CofounderOS — capture paused'
        : 'CofounderOS — idle';

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
  if (!statusWindow) return;
  await statusWindow.loadFile(path.join(here, 'renderer', 'index.html'));
  statusWindow.webContents.once('did-finish-load', () => {
    statusWindow?.webContents.send('cofounderos:desktop-logs', lastLogs.slice(-120).join('\n'));
    if (lastOverview) {
      statusWindow?.webContents.send('cofounderos:overview', lastOverview);
    }
  });
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

function registerRuntimeIpc(): void {
  ipcMain.handle('cofounderos:overview', async () => {
    return await (await getRuntimeForRequest()).call('overview');
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
  ipcMain.handle('cofounderos:search-frames', async (_event, query: unknown) => {
    return await (await getRuntimeForRequest()).call('searchFrames', query);
  });
  ipcMain.handle('cofounderos:list-insights', async (_event, query: unknown) => {
    return await (await getRuntimeForRequest()).call('listInsights', query);
  });
  ipcMain.handle('cofounderos:run-insights-now', async () => {
    return await (await getRuntimeForRequest()).call('runInsightsNow');
  });
  ipcMain.handle('cofounderos:ask-insights', async (_event, input: unknown) => {
    return await (await getRuntimeForRequest()).call('askInsights', input);
  });
  ipcMain.handle('cofounderos:dismiss-insight', async (_event, id: string) => {
    return await (await getRuntimeForRequest()).call('dismissInsight', id);
  });
  ipcMain.handle('cofounderos:chat-insights', async (_event, input: unknown) => {
    return await (await getRuntimeForRequest()).call('chatInsights', input);
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
  ipcMain.handle('cofounderos:open-path', async (_event, target: 'config' | 'data' | 'markdown') => {
    const targetPath = target === 'config'
      ? configPath
      : target === 'data'
        ? dataDir
        : markdownExportDir;
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

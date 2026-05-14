import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { app, BrowserWindow, clipboard, ipcMain, Menu, net, Tray, nativeImage, protocol, shell, dialog, systemPreferences } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { defaultDataDir, expandPath, loadConfig } from '@beside/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const workspaceRoot = resolveRuntimeWorkspaceRoot();
if (app.isPackaged && !process.env.BESIDE_DATA_DIR) process.env.BESIDE_USE_PLATFORM_DATA_DIR ??= '1';
const dataDir = defaultDataDir();
const configPath = path.join(dataDir, 'config.yaml');
const markdownExportDir = path.join(dataDir, 'export/markdown');
const windowStatePath = path.join(dataDir, 'desktop-window.json');
// Presence of this marker on disk means the user finished onboarding at least once.
// The main process reads it at launch to decide whether to auto-start the runtime
// (which would otherwise spawn the capture helper and trigger the Screen Recording
// TCC prompt before the renderer has surfaced the permissions step).
const onboardingMarkerPath = path.join(dataDir, 'onboarding-complete');
const rendererDevUrl = process.env.BESIDE_RENDERER_URL;
const ASSET_PROTOCOL = 'beside-asset';

protocol.registerSchemesAsPrivileged([{ scheme: ASSET_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);

interface WindowState { width: number; height: number; x?: number; y?: number; maximized?: boolean; }
const DEFAULT_WINDOW_STATE: WindowState = { width: 860, height: 760 };

function loadWindowState(): WindowState {
  try {
    const p = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    return { width: p.width > 400 ? p.width : 860, height: p.height > 300 ? p.height : 760, ...(p.x != null && { x: p.x }), ...(p.y != null && { y: p.y }), ...(p.maximized && { maximized: true }) };
  } catch { return { ...DEFAULT_WINDOW_STATE }; }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    fs.mkdirSync(path.dirname(windowStatePath), { recursive: true });
    fs.writeFileSync(windowStatePath, JSON.stringify(win.isMaximized() ? { ...DEFAULT_WINDOW_STATE, maximized: true } : { width: win.getSize()[0], height: win.getSize()[1], x: win.getPosition()[0], y: win.getPosition()[1] }, null, 2), 'utf8');
  } catch (err) { appendLog(`Failed to persist window state: ${String(err)}`); }
}

let tray: Tray | null = null, statusWindow: BrowserWindow | null = null, managedRuntime: RuntimeServiceClient | null = null, statusItemHelper: ChildProcess | null = null;
let lastLogs: string[] = [], lastOverview: any = null;
const useMacAccessoryMode = process.platform === 'darwin' && process.env.BESIDE_DESKTOP_SHOW_DOCK !== '1';
let updateCheckInFlight = false;
let manualUpdateCheckRequested = false;
let updateDownloadPromptOpen = false;
let updateInstallPromptOpen = false;
let updateCheckTimer: NodeJS.Timeout | null = null;

type MenuBarCaptureState = 'capturing' | 'paused' | 'stopped';
type MenuBarIndicator = { state: MenuBarCaptureState; label: string; };

class RuntimeServiceClient {
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (r?: unknown) => void; }>();

  constructor() {
    this.child = spawn(app.isPackaged ? process.execPath : (process.env.COFUNDEROS_NODE ?? 'node'), [path.join(here, 'runtime-service.js')], { env: { ...process.env, BESIDE_RESOURCE_ROOT: workspaceRoot, ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr?.setEncoding('utf8').on('data', (c) => appendLog(c.trimEnd()));
    this.child.on('error', (err) => this.rejectAll(err));
    this.child.on('exit', (code, signal) => { this.rejectAll(new Error(`exited (code=${code}, signal=${signal})`)); if (managedRuntime === this) managedRuntime = null; applyMenuBarIndicator({ state: 'stopped', label: 'Beside — stopped' }); void refreshTray(); if (statusWindow) void renderStatusWindow(); });
    this.on('bootstrap-progress', (p) => statusWindow?.webContents.send('beside:bootstrap-progress', p));
    this.on('overview', (p) => { lastOverview = p; applyMenuBarIndicator(getMenuBarIndicator(lastOverview)); statusWindow?.webContents.send('beside:overview', p); });
    this.on('capture-hook-update', (p) => statusWindow?.webContents.send('beside:capture-hook-update', p));
    readline.createInterface({ input: this.child.stdout!, crlfDelay: Infinity }).on('line', (line) => this.handleLine(line));
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as any, reject });
      this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`, (err) => { if (err) { this.pending.delete(id); reject(err); } });
    });
  }

  on(event: string, callback: (payload: unknown) => void) { const l = this.listeners.get(event) ?? new Set(); l.add(callback); this.listeners.set(event, l); }
  close() { this.child.kill('SIGTERM'); this.rejectAll(new Error('runtime service closed')); }

  private handleLine(line: string) {
    try {
      const res = JSON.parse(line) as any;
      if (res.event) { this.listeners.get(res.event)?.forEach((cb) => cb(res.payload)); return; }
      const p = this.pending.get(res.id);
      if (p) { this.pending.delete(res.id); res.ok ? p.resolve(res.result) : p.reject(new Error(res.error)); }
    } catch { appendLog(`[stdout] ${line}`); }
  }

  private rejectAll(err: unknown) { this.pending.forEach((p) => p.reject(err)); this.pending.clear(); }
}

app.setName('Beside');
if (process.platform === 'darwin') try { app.setAboutPanelOptions({ applicationName: 'Beside' }); } catch {}

let initialScreenStatus: string | null = null;

app.whenReady().then(async () => {
  configureAutoUpdates();
  if (process.platform === 'darwin') {
    try { initialScreenStatus = systemPreferences.getMediaAccessStatus('screen') === 'unknown' ? 'unsupported' : systemPreferences.getMediaAccessStatus('screen'); }
    catch { initialScreenStatus = 'unsupported'; }
  }
  registerAssetProtocol(); registerRuntimeIpc(); applyBrandDockIcon();
  if (useMacAccessoryMode) enterMacAccessoryMode();
  if (process.platform === 'darwin' && startNativeStatusItem()) {} else createElectronTrayFallback();
  await startDaemonIfNeeded();
  if (process.env.BESIDE_DESKTOP_SHOW_ON_START !== '0') await showStatusWindow();
  scheduleAutoUpdateChecks();
});

function registerAssetProtocol() {
  protocol.handle(ASSET_PROTOCOL, async (req) => net.fetch(pathToFileURL(await resolveAssetPath(decodeURIComponent(new URL(req.url).pathname.replace(/^\/+/, '')))).toString()));
}

async function resolveAssetPath(p: string) {
  if (!p || p.includes('\\0')) throw new Error('invalid path');
  const r = (lastOverview ?? await getOverviewForRequest())?.storageRoot;
  if (!r) throw new Error('no storage root');
  const res = path.resolve(r, p);
  if (!res.startsWith(`${path.resolve(r)}${path.sep}`) && res !== path.resolve(r)) throw new Error('escapes storage root');
  return res;
}

function assetUrl(assetPath: string): string {
  return `${ASSET_PROTOCOL}://local/${encodeURIComponent(assetPath)}`;
}

function isPathInside(child: string, parent: string) { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
function isStatusWindowNavigation(url: string) {
  try {
    const p = new URL(url);
    if (p.protocol === `${ASSET_PROTOCOL}:`) return true;
    if (rendererDevUrl && p.origin === new URL(rendererDevUrl).origin) return true;
    if (p.protocol === 'file:') return isPathInside(path.resolve(fileURLToPath(p)), path.resolve(here, 'renderer'));
  } catch {}
  return false;
}

async function openExternalHttpUrl(url: string) {
  const p = new URL(url);
  if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error('Only http(s) allowed.');
  await shell.openExternal(p.toString());
  return p.toString();
}

app.on('window-all-closed', () => {});
app.on('before-quit', () => { if (updateCheckTimer) clearInterval(updateCheckTimer); statusItemHelper?.kill('SIGTERM'); managedRuntime?.close(); });

function createElectronTrayFallback() {
  try {
    tray = new Tray(makeTrayImage()); applyMenuBarIndicator(getMenuBarIndicator(lastOverview));
    const timer = setInterval(() => refreshTray(), 60_000);
    app.once('before-quit', () => clearInterval(timer));
    tray.on('click', () => showStatusWindow());
  } catch (err) { dialog.showErrorBox('Tray failed', `${String(err)}\n\nApp runs, use status window.`); }
}

function startNativeStatusItem() {
  try {
    const helper = spawn(path.resolve(here, 'native/beside-status-item'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    statusItemHelper = helper;
    helper.stdout?.setEncoding('utf8').on('data', (c) => c.split(/\r?\n/).filter(Boolean).forEach((l: string) => {
      try { const m = JSON.parse(l); if (m.kind === 'show-status') showStatusWindow(); if (m.kind === 'quit') app.quit(); if (m.kind === 'ready') applyMenuBarIndicator(getMenuBarIndicator(lastOverview)); } catch {}
    }));
    helper.on('exit', () => { if (statusItemHelper === helper) statusItemHelper = null; });
    helper.on('error', () => { if (statusItemHelper === helper) statusItemHelper = null; });
    return true;
  } catch { return false; }
}

function getMenuBarIndicator(o: any, ok = o?.status === 'running', labelOverride?: string): MenuBarIndicator {
  if (!ok) return { state: 'stopped', label: labelOverride ?? 'Beside — stopped' };
  if (o?.capture.running) return o.capture.paused ? { state: 'paused', label: labelOverride ?? 'Beside — capture paused' } : { state: 'capturing', label: labelOverride ?? `Beside — capturing (${o.capture.eventsToday ?? 0} today)` };
  return { state: 'stopped', label: labelOverride ?? 'Beside — idle' };
}

function applyMenuBarIndicator(i: MenuBarIndicator) {
  if (tray) { if (process.platform === 'darwin') tray.setTitle(''); tray.setToolTip(i.label); }
  statusItemHelper?.stdin?.write(`${JSON.stringify({ kind: 'set-state', state: i.state, label: i.label })}\n`, (err) => err && appendLog(`Native tray error: ${err}`));
}

async function refreshTray() {
  if (!tray) return;
  const h = await getHealth(), o = lastOverview ?? (managedRuntime ? await managedRuntime.call('overview').catch(() => null) : null) as any;
  const live = h.ok && o?.capture.running && !o.capture.paused, paused = h.ok && o?.capture.running && o.capture.paused;
  applyMenuBarIndicator(getMenuBarIndicator(o, h.ok, !h.ok ? 'Beside — stopped' : live ? `Beside — capturing (${o.capture.eventsToday ?? 0} today)` : paused ? 'Beside — capture paused' : 'Beside — idle'));

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: getMenuBarIndicator(o, h.ok).label, enabled: false }, { type: 'separator' },
    { label: 'Open Beside', accelerator: 'CommandOrControl+O', click: () => showStatusWindow() },
    live ? { label: 'Pause Capture', accelerator: 'CommandOrControl+.', click: async () => { await (await getRuntimeForRequest()).call('pauseCapture').catch(e => appendLog(`Pause failed: ${e}`)); await refreshTray(); } } : paused ? { label: 'Resume Capture', accelerator: 'CommandOrControl+.', click: async () => { await (await getRuntimeForRequest()).call('resumeCapture').catch(e => appendLog(`Resume failed: ${e}`)); await refreshTray(); } } : { label: 'Start Capture', click: () => startRuntime(), enabled: !live && !paused && !(h.ok && !managedRuntime) },
    { type: 'separator' }, { label: 'Run Doctor', click: () => showStatusWindow({ focus: 'doctor' }) },
    { label: 'Check for Updates...', click: () => checkForUpdates(true) },
    { label: 'Reveal Files', submenu: [{ label: 'Markdown Export', click: () => shell.openPath(markdownExportDir) }, { label: 'Data Folder', click: () => shell.openPath(dataDir) }, { label: 'Config File', click: () => shell.openPath(configPath) }] },
    { type: 'separator' }, ...(managedRuntime ? [{ label: 'Stop Managed Runtime', click: () => stopManagedRuntime() }] : []),
    { label: 'Quit', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
  ]));
}

function configureAutoUpdates() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => appendLog('Checking for app updates.'));
  autoUpdater.on('update-available', (info) => { updateCheckInFlight = false; manualUpdateCheckRequested = false; void promptToDownloadUpdate(info); });
  autoUpdater.on('update-not-available', (info) => {
    const wasManual = manualUpdateCheckRequested;
    manualUpdateCheckRequested = false;
    updateCheckInFlight = false;
    appendLog(`No app update available; current version is ${app.getVersion()}${info?.version ? `, latest is ${info.version}` : ''}.`);
    if (wasManual) void dialog.showMessageBox({ type: 'info', message: 'Beside is up to date.', detail: `You are running ${app.getVersion()}.` });
  });
  autoUpdater.on('download-progress', (progress) => appendLog(`Downloading app update ${Math.round(progress.percent)}%.`));
  autoUpdater.on('update-downloaded', (info) => { updateCheckInFlight = false; manualUpdateCheckRequested = false; void promptToInstallUpdate(info); });
  autoUpdater.on('error', (err) => {
    const wasManual = manualUpdateCheckRequested;
    manualUpdateCheckRequested = false;
    updateCheckInFlight = false;
    appendLog(`App update failed: ${err?.message ?? String(err)}`);
    if (wasManual) void dialog.showMessageBox({ type: 'error', message: 'Could not check for updates.', detail: err?.message ?? String(err) });
  });
}

function scheduleAutoUpdateChecks() {
  if (process.env.BESIDE_DISABLE_AUTO_UPDATES === '1') return;
  void checkForUpdates(false);
  updateCheckTimer = setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1000);
}

async function checkForUpdates(manual: boolean) {
  if (!app.isPackaged) {
    if (manual) await dialog.showMessageBox({ type: 'info', message: 'Updates are available in packaged builds.', detail: 'Build and install Beside before checking for production updates.' });
    return;
  }
  if (process.env.BESIDE_DISABLE_AUTO_UPDATES === '1') {
    if (manual) await dialog.showMessageBox({ type: 'info', message: 'Automatic updates are disabled.', detail: 'BESIDE_DISABLE_AUTO_UPDATES=1 is set for this process.' });
    return;
  }
  if (updateCheckInFlight) {
    if (manual) await dialog.showMessageBox({ type: 'info', message: 'Already checking for updates.' });
    return;
  }

  updateCheckInFlight = true;
  manualUpdateCheckRequested = manual;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (manual && !result?.updateInfo) await dialog.showMessageBox({ type: 'info', message: 'No update information was returned.' });
  } catch (err) {
    manualUpdateCheckRequested = false;
    updateCheckInFlight = false;
    appendLog(`App update check failed: ${String(err)}`);
    if (manual) await dialog.showMessageBox({ type: 'error', message: 'Could not check for updates.', detail: String(err) });
  }
}

async function promptToDownloadUpdate(info: any) {
  appendLog(`App update ${info?.version ?? 'is'} available.`);
  if (updateDownloadPromptOpen) return;
  updateDownloadPromptOpen = true;
  try {
    const res = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Beside ${info?.version ?? 'update'} is available.`,
      detail: `You are running ${app.getVersion()}. Download the update now?`,
    });
    if (res.response === 0) await autoUpdater.downloadUpdate();
  } finally {
    updateDownloadPromptOpen = false;
  }
}

async function promptToInstallUpdate(info: any) {
  appendLog(`App update ${info?.version ?? ''} downloaded.`);
  if (updateInstallPromptOpen) return;
  updateInstallPromptOpen = true;
  try {
    const res = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Beside ${info?.version ?? 'update'} is ready to install.`,
      detail: 'Restart Beside to finish installing the update.',
    });
    if (res.response === 0) autoUpdater.quitAndInstall(false, true);
  } finally {
    updateInstallPromptOpen = false;
  }
}

async function showStatusWindow(opts: { focus?: 'doctor' } = {}) {
  enterMacStatusWindowMode();
  if (!statusWindow) {
    const s = loadWindowState();
    statusWindow = new BrowserWindow({ ...s, title: 'Beside Status', show: false, ...(resolveBrandIconPath() && { icon: resolveBrandIconPath()! }), webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(here, 'preload.cjs') } });
    if (s.maximized) statusWindow.maximize();

    let t: NodeJS.Timeout | null = null;
    const save = () => { if (!statusWindow) return; if (t) clearTimeout(t); t = setTimeout(() => statusWindow && !statusWindow.isDestroyed() && saveWindowState(statusWindow), 400); };
    ['resize', 'move', 'maximize', 'unmaximize'].forEach((e) => statusWindow!.on(e as any, save));
    statusWindow.on('close', () => statusWindow && !statusWindow.isDestroyed() && saveWindowState(statusWindow));
    statusWindow.on('closed', () => { statusWindow = null; enterMacAccessoryMode(); setRuntimeHeartbeat('idle'); });
    ['show', 'restore', 'focus'].forEach((e) => statusWindow!.on(e as any, () => setRuntimeHeartbeat('active')));
    ['hide', 'minimize'].forEach((e) => statusWindow!.on(e as any, () => setRuntimeHeartbeat('idle')));
    statusWindow.webContents.on('console-message', ({ level, message }) => appendLog(`[renderer:${level}] ${message}`));
    statusWindow.webContents.setWindowOpenHandler(({ url }) => { openExternalHttpUrl(url).catch(e => appendLog(`Nav block: ${e}`)); return { action: 'deny' }; });
    statusWindow.webContents.on('will-navigate', (e, url) => { if (!isStatusWindowNavigation(url)) { e.preventDefault(); openExternalHttpUrl(url).catch(e => appendLog(`Nav block: ${e}`)); } });
  }
  await renderStatusWindow();
  statusWindow.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  statusWindow.focus();
}

function enterMacAccessoryMode() { if (useMacAccessoryMode) { app.setActivationPolicy('accessory'); app.dock?.hide(); } }
function enterMacStatusWindowMode() { if (useMacAccessoryMode) { app.setActivationPolicy('regular'); app.dock?.show(); app.setName('Beside'); applyBrandDockIcon(); } }

async function renderStatusWindow() {
  const w = statusWindow; if (!w || w.isDestroyed()) return;
  const init = () => { if (w.isDestroyed()) return; w.webContents.send('beside:desktop-logs', lastLogs.slice(-120).join('\n')); if (lastOverview) w.webContents.send('beside:overview', lastOverview); };
  w.webContents.once('did-finish-load', init);
  try { rendererDevUrl ? await w.loadURL(rendererDevUrl) : await w.loadFile(path.join(here, 'renderer', 'index.html')); }
  catch (err) { w.webContents.removeListener('did-finish-load', init); if (!rendererDevUrl || !/ERR_/.test(String(err))) throw err; appendLog(`Dev render nav err: ${err}`); }
}

async function startRuntime() {
  if (managedRuntime) { try { await managedRuntime.call('start'); } catch (err) { dialog.showErrorBox('Start failed', String(err)); } finally { await refreshTray(); } return; }
  const rt = new RuntimeServiceClient();
  managedRuntime = rt;
  try { await rt.call('start'); }
  catch (err) { try { rt.close(); } catch {} if (managedRuntime === rt) managedRuntime = null; dialog.showErrorBox('Start failed', String(err)); }
  finally { await refreshTray(); if (statusWindow) await renderStatusWindow(); }
}

function isOnboardingComplete(): boolean {
  try { return fs.existsSync(onboardingMarkerPath); } catch { return false; }
}

function setOnboardingComplete(done: boolean): boolean {
  try {
    if (done) { fs.mkdirSync(path.dirname(onboardingMarkerPath), { recursive: true }); fs.writeFileSync(onboardingMarkerPath, new Date().toISOString(), 'utf8'); }
    else fs.rmSync(onboardingMarkerPath, { force: true });
  } catch (err) { appendLog(`Failed to update onboarding marker: ${String(err)}`); }
  return isOnboardingComplete();
}

async function startDaemonIfNeeded() {
  if (process.env.BESIDE_DESKTOP_AUTOSTART === '0') return;
  // Defer runtime auto-start (and the capture helper spawn that triggers the
  // Screen Recording TCC prompt) until the user has completed onboarding once.
  // The onboarding flow itself explicitly calls startRuntime() at the end.
  if (!isOnboardingComplete()) { appendLog('Onboarding not complete: deferring runtime auto-start.'); return; }
  if ((await getHealth()).ok) return;
  await startRuntime();
}

async function stopManagedRuntime() {
  if (!managedRuntime) return;
  const r = managedRuntime; managedRuntime = null;
  await r.call('stop').catch((e) => appendLog(`Stop failed: ${e}`)); r.close();
  applyMenuBarIndicator({ state: 'stopped', label: 'Beside — stopped' });
  await refreshTray(); if (statusWindow) await renderStatusWindow();
}

async function getHealth() {
  try { return managedRuntime ? { ok: (await managedRuntime.call<any>('overview')).status === 'running', text: '' } : { ok: (await fetch('http://127.0.0.1:3456/health')).ok, text: '' }; }
  catch { return { ok: false, text: '' }; }
}

const execFileP = promisify(execFile);

async function whichOnPath(cmd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const isW = process.platform === 'win32';
  try { return (await execFileP(isW ? 'where' : '/usr/bin/which', [isW ? `${cmd}.exe` : cmd], { env, timeout: 5000 })).stdout.split(/\r?\n/).map(l => l.trim()).find(l => l) || null; }
  catch { if (isW) { try { return (await execFileP('where', [cmd], { env, timeout: 5000 })).stdout.split(/\r?\n/).map(l => l.trim()).find(l => l) || null; } catch { return null; } } return null; }
}

function whisperEnv(): NodeJS.ProcessEnv {
  const ext = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`] : process.platform === 'linux' ? ['/usr/local/bin', '/usr/bin', `${process.env.HOME}/.local/bin`] : [process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.local', 'bin') : ''];
  return { ...process.env, PATH: [process.env.PATH ?? process.env.Path, ...ext.filter(Boolean)].join(process.platform === 'win32' ? ';' : ':') };
}

async function detectWhisperInstaller() {
  for (const t of process.platform === 'win32' ? ['pipx', 'pip3', 'pip'] : process.platform === 'linux' ? ['pipx', 'pip3', 'pip', 'brew'] : ['brew', 'pipx', 'pip3', 'pip']) {
    const p = await whichOnPath(t, whisperEnv()); if (p) return { installer: t, installerPath: p };
  }
  return { installer: null };
}

async function installWhisper() {
  const { installer, installerPath } = await detectWhisperInstaller();
  if (!installer || !installerPath) return { started: false, reason: 'No installer found.' };
  const args = installer === 'brew' || installer === 'pipx' ? ['install', 'openai-whisper'] : ['install', '--user', '-U', 'openai-whisper'];
  const env = whisperEnv(); if (installer === 'brew') env.HOMEBREW_NO_AUTO_UPDATE = '1';
  return new Promise<any>((resolve) => {
    try {
      const child = spawn(installerPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      ['stdout', 'stderr'].forEach(s => readline.createInterface({ input: (child as any)[s], crlfDelay: Infinity }).on('line', (l) => l.trim() && emitWhisperInstall({ kind: 'log', installer, message: l })));
      child.on('error', (err) => { emitWhisperInstall({ kind: 'failed', installer, reason: err.message }); resolve({ started: false }); });
      child.on('exit', async (code) => { const p = await probeWhisperCli(); if (code === 0 || p.available) emitWhisperInstall({ kind: 'finished', installer, available: p.available, path: p.path }); else emitWhisperInstall({ kind: 'failed', installer, reason: `Code ${code}` }); resolve({ started: true }); });
    } catch (err) { emitWhisperInstall({ kind: 'failed', installer, reason: String(err) }); resolve({ started: false }); }
  });
}

function emitWhisperInstall(e: any) { appendLog(`whisper-install ${e.kind} ${e.installer || ''}: ${e.message || e.reason || ''}`); statusWindow?.webContents.send('beside:whisper-install-progress', e); }

async function probeWhisperCli() {
  try {
    const p = await whichOnPath('whisper', whisperEnv());
    if (!p) throw new Error();
    const h = await execFileP(p, ['--help'], { env: whisperEnv(), timeout: 30000 });
    return { available: true, path: p, version: h.stdout.split('\n').find(l => l.trim())?.slice(0, 200) || '', triedCommand: 'whisper' };
  } catch { return { available: false, triedCommand: 'whisper' }; }
}

async function probeFfprobe() { const p = await whichOnPath('ffprobe', whisperEnv()); return p ? { available: true, path: p } : { available: false }; }
function probeMicPermission() { return process.platform === 'darwin' ? { status: systemPreferences.getMediaAccessStatus('microphone') || 'unsupported' } : { status: 'unsupported' }; }
async function requestMicPermission() { if (process.platform === 'darwin') try { await systemPreferences.askForMediaAccess('microphone'); } catch {} return probeMicPermission(); }

function probeScreenPermission() {
  if (process.platform !== 'darwin') return { status: 'unsupported', needsRelaunch: false };
  let status = 'unsupported'; try { status = systemPreferences.getMediaAccessStatus('screen') || 'unsupported'; } catch {}
  if (!initialScreenStatus) initialScreenStatus = status;
  return { status, needsRelaunch: initialScreenStatus !== 'granted' && status === 'granted' };
}

async function requestScreenPermission() {
  if (process.platform !== 'darwin') return { status: 'unsupported', needsRelaunch: false, openedSettings: false };
  try { await import('electron').then(e => e.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })).catch(() => {}); } catch {}
  let openedSettings = false; try { await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); openedSettings = true; } catch {}
  return { ...probeScreenPermission(), openedSettings };
}

function probeAccessibilityPermission() { return process.platform === 'darwin' ? { status: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied' } : { status: 'unsupported' }; }
async function requestAccessibilityPermission() {
  if (process.platform !== 'darwin') return { status: 'unsupported', openedSettings: false };
  const granted = systemPreferences.isTrustedAccessibilityClient(true);
  let openedSettings = false; if (!granted) try { await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'); openedSettings = true; } catch {}
  return { status: granted ? 'granted' : 'denied', openedSettings };
}

async function openPermissionSettings(kind: 'screen' | 'accessibility' | 'microphone' | 'automation') {
  if (process.platform !== 'darwin') return { opened: false };
  const t = { screen: 'Privacy_ScreenCapture', accessibility: 'Privacy_Accessibility', microphone: 'Privacy_Microphone', automation: 'Privacy_Automation' };
  try { await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${t[kind]}`); return { opened: true }; } catch { return { opened: false }; }
}

function relaunchApp() { app.relaunch(); setTimeout(() => app.exit(0), 100); return { relaunching: true }; }

function registerRuntimeIpc() {
  const h = ipcMain.handle;
  h('beside:overview', () => getOverviewForRequest());
  h('beside:doctor', async () => (await getRuntimeForRequest()).call('doctor'));
  h('beside:read-config', async () => (await getRuntimeForRequest()).call('readConfig'));
  h('beside:validate-config', async (e, c) => (await getRuntimeForRequest()).call('validateConfig', c));
  h('beside:save-config-patch', async (e, p) => (await getRuntimeForRequest()).call('saveConfigPatch', p));
  h('beside:list-journal-days', async () => (await getRuntimeForRequest()).call('listJournalDays'));
  h('beside:get-journal-day', async (e, d) => (await getRuntimeForRequest()).call('getJournalDay', d));
  h('beside:read-journal-markdown', async (e, d) => (await getRuntimeForRequest()).call('readJournalMarkdown', d));
  h('beside:list-meetings', async (e, q) => (await getRuntimeForRequest()).call('listMeetings', q));
  h('beside:list-day-events', async (e, q) => (await getRuntimeForRequest()).call('listDayEvents', q));
  h('beside:trigger-event-extractor', async () => (await getRuntimeForRequest()).call('triggerEventExtractor', undefined));
  h('beside:list-capture-hook-definitions', async () => (await getRuntimeForRequest()).call('listCaptureHookDefinitions'));
  h('beside:list-capture-hook-widget-manifests', async () => (await getRuntimeForRequest()).call('listCaptureHookWidgetManifests'));
  h('beside:get-capture-hook-diagnostics', async () => (await getRuntimeForRequest()).call('getCaptureHookDiagnostics'));
  h('beside:query-capture-hook-storage', async (e, params) => (await getRuntimeForRequest()).call('queryCaptureHookStorage', params));
  h('beside:mutate-capture-hook-storage', async (e, params) => (await getRuntimeForRequest()).call('mutateCaptureHookStorage', params));
  h('beside:read-capture-hook-widget-bundle', async (e, params: any) => readCaptureHookWidgetBundle(params));
  h('beside:search-frames', async (e, q) => (await getRuntimeForRequest()).call('searchFrames', q));
  h('beside:explain-search-results', async (e, q) => (await getRuntimeForRequest()).call('explainSearchResults', q));
  h('beside:get-frame-index-details', async (e, f) => (await getRuntimeForRequest()).call('getFrameIndexDetails', f));
  h('beside:asset-url', async (e, p) => { await resolveAssetPath(p); return assetUrl(p); });
  h('beside:read-asset', async (e, p) => new Uint8Array(await fs.promises.readFile(await resolveAssetPath(p))));
  h('beside:start-runtime', async () => { await startRuntime(); return (await getRuntimeForRequest()).call('overview'); });
  h('beside:stop-runtime', async () => { await stopManagedRuntime(); return { stopped: true }; });
  h('beside:pause-capture', async () => (await getRuntimeForRequest()).call('pauseCapture'));
  h('beside:resume-capture', async () => (await getRuntimeForRequest()).call('resumeCapture'));
  h('beside:trigger-index', async () => (await getRuntimeForRequest()).call('triggerIndex'));
  h('beside:trigger-reorganise', async () => (await getRuntimeForRequest()).call('triggerReorganise'));
  h('beside:trigger-full-reindex', async (e, r) => (await getRuntimeForRequest()).call('triggerFullReindex', r));
  h('beside:bootstrap-model', async () => (await getRuntimeForRequest()).call('bootstrapModel'));
  h('beside:update-model', async () => (await getRuntimeForRequest()).call('updateModel'));
  h('beside:get-start-at-login', () => app.getLoginItemSettings().openAtLogin);
  h('beside:set-start-at-login', (e, en) => { app.setLoginItemSettings({ openAtLogin: en, openAsHidden: true }); return en; });
  h('beside:open-path', async (e, t: any) => { const p = t === 'config' ? configPath : t === 'data' ? dataDir : await getMarkdownExportDir(); const err = await shell.openPath(p); if (err) throw new Error(err); return { opened: p }; });
  h('beside:open-asset-path', async (e, rel: string) => {
    const abs = await resolveAssetPath(rel);
    const err = await shell.openPath(abs);
    if (err) throw new Error(err);
    return { opened: abs };
  });
  h('beside:copy-text', (e, t) => { clipboard.writeText(t); return { copied: true }; });
  h('beside:open-external-url', async (e, u) => ({ opened: await openExternalHttpUrl(u) }));
  h('beside:delete-frame', async (e, id) => (await getRuntimeForRequest()).call('deleteFrame', id));
  h('beside:delete-frames', async (e, q) => (await getRuntimeForRequest()).call('deleteFrames', q));
  h('beside:delete-all-memory', async () => (await getRuntimeForRequest()).call('deleteAllMemory'));
  h('beside:probe-whisper', probeWhisperCli);
  h('beside:detect-whisper-installer', async () => ({ installer: (await detectWhisperInstaller()).installer }));
  h('beside:install-whisper', installWhisper);
  h('beside:probe-ffprobe', probeFfprobe);
  h('beside:probe-mic-permission', probeMicPermission);
  h('beside:request-mic-permission', requestMicPermission);
  h('beside:probe-screen-permission', probeScreenPermission);
  h('beside:request-screen-permission', requestScreenPermission);
  h('beside:probe-accessibility-permission', probeAccessibilityPermission);
  h('beside:request-accessibility-permission', requestAccessibilityPermission);
  h('beside:open-permission-settings', (e, k: any) => openPermissionSettings(k));
  h('beside:relaunch-app', relaunchApp);
  h('beside:get-onboarding-complete', () => isOnboardingComplete());
  h('beside:set-onboarding-complete', (_e, done: boolean) => setOnboardingComplete(!!done));
}

async function getOverviewForRequest() { try { return await (await getRuntimeForRequest()).call<any>('overview'); } catch (err) { if (/closed|exited/.test(String(err))) return lastOverview; throw err; } }

async function readCaptureHookWidgetBundle(params: { resolvedBundlePath?: string }): Promise<{ source: string }> {
  if (!params?.resolvedBundlePath) throw new Error('resolvedBundlePath required');
  const abs = path.resolve(params.resolvedBundlePath);
  if (!isPathInside(abs, workspaceRoot)) throw new Error('widget bundle outside workspace');
  const source = await fs.promises.readFile(abs, 'utf8');
  return { source };
}
async function getMarkdownExportDir() { try { const c = (await loadConfig(configPath)).config.export.plugins.find((p) => p.name === 'markdown'); if (typeof c?.path === 'string') return expandPath(c.path); } catch {} return markdownExportDir; }
async function getRuntimeForRequest() { if (!managedRuntime) managedRuntime = new RuntimeServiceClient(); return managedRuntime; }
function setRuntimeHeartbeat(mode: string) { managedRuntime?.call('setHeartbeat', { mode }).catch(() => {}); }

function appendLog(l: string) {
  if (!l) return; lastLogs.push(...l.split(/\r?\n/).filter(Boolean).map(x => `[${new Date().toLocaleTimeString()}] ${x}`));
  if (lastLogs.length > 400) lastLogs = lastLogs.slice(-400);
}

function resolveRuntimeWorkspaceRoot() { return process.env.BESIDE_RESOURCE_ROOT?.trim() || (app.isPackaged && (process as any).resourcesPath ? path.join((process as any).resourcesPath, 'beside') : repoRoot); }

function resolveBrandIconPath() {
  for (const c of [path.resolve(here, '../build/icon.png'), path.resolve(here, '../../build/icon.png'), path.resolve(repoRoot, 'packages/desktop/build/icon.png')]) { try { const i = nativeImage.createFromPath(c); if (!i.isEmpty()) return c; } catch {} }
  return null;
}

function applyBrandDockIcon() {
  const p = resolveBrandIconPath();
  if (p && process.platform === 'darwin') try { app.dock?.setIcon(nativeImage.createFromPath(p)); } catch {}
}

function makeTrayImage() {
  for (const c of [path.resolve(here, '../assets/trayTemplate.png'), path.resolve(here, '../../assets/trayTemplate.png'), path.resolve(repoRoot, 'packages/desktop/assets/trayTemplate.png')]) { try { const i = nativeImage.createFromPath(c); if (!i.isEmpty()) { i.setTemplateImage(true); return i; } } catch {} }
  const fb = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAQUlEQVR4nO3PsQ0AMAjAsP7//0qUDhCJDAyNgg5BPcgZS5IkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkScfYwQATTwHAyVLFpQAAAABJRU5ErkJggg==', 'base64')); fb.setTemplateImage(true); return fb;
}

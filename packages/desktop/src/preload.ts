import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getOverview: () => ipcRenderer.invoke('cofounderos:overview'),
  runDoctor: () => ipcRenderer.invoke('cofounderos:doctor'),
  readConfig: () => ipcRenderer.invoke('cofounderos:read-config'),
  validateConfig: (config: unknown) => ipcRenderer.invoke('cofounderos:validate-config', config),
  saveConfigPatch: (patch: unknown) => ipcRenderer.invoke('cofounderos:save-config-patch', patch),
  listJournalDays: () => ipcRenderer.invoke('cofounderos:list-journal-days'),
  getJournalDay: (day: string) => ipcRenderer.invoke('cofounderos:get-journal-day', day),
  getIndexedJournalDay: (day: string) => ipcRenderer.invoke('cofounderos:get-indexed-journal-day', day),
  searchFrames: (query: unknown) => ipcRenderer.invoke('cofounderos:search-frames', query),
  explainSearchResults: (query: unknown) => ipcRenderer.invoke('cofounderos:explain-search-results', query),
  getFrameIndexDetails: (frameId: string) => ipcRenderer.invoke('cofounderos:get-frame-index-details', frameId),
  readAsset: (assetPath: string) => ipcRenderer.invoke('cofounderos:read-asset', assetPath),
  startRuntime: () => ipcRenderer.invoke('cofounderos:start-runtime'),
  stopRuntime: () => ipcRenderer.invoke('cofounderos:stop-runtime'),
  pauseCapture: () => ipcRenderer.invoke('cofounderos:pause-capture'),
  resumeCapture: () => ipcRenderer.invoke('cofounderos:resume-capture'),
  triggerIndex: () => ipcRenderer.invoke('cofounderos:trigger-index'),
  triggerReorganise: () => ipcRenderer.invoke('cofounderos:trigger-reorganise'),
  triggerFullReindex: (range: { from?: string; to?: string }) => ipcRenderer.invoke('cofounderos:trigger-full-reindex', range),
  bootstrapModel: () => ipcRenderer.invoke('cofounderos:bootstrap-model'),
  getStartAtLogin: () => ipcRenderer.invoke('cofounderos:get-start-at-login'),
  setStartAtLogin: (enabled: boolean) => ipcRenderer.invoke('cofounderos:set-start-at-login', enabled),
  openPath: (target: 'config' | 'data' | 'markdown' | { target: 'markdown'; category?: string }) => ipcRenderer.invoke('cofounderos:open-path', target),
  copyText: (text: string) => ipcRenderer.invoke('cofounderos:copy-text', text),
  deleteFrame: (frameId: string) => ipcRenderer.invoke('cofounderos:delete-frame', frameId),
  deleteFramesByDay: (day: string) => ipcRenderer.invoke('cofounderos:delete-frames-by-day', day),
  deleteAllMemory: () => ipcRenderer.invoke('cofounderos:delete-all-memory'),
  probeWhisper: () => ipcRenderer.invoke('cofounderos:probe-whisper'),
  detectWhisperInstaller: () => ipcRenderer.invoke('cofounderos:detect-whisper-installer'),
  installWhisper: () => ipcRenderer.invoke('cofounderos:install-whisper'),
  probeFfprobe: () => ipcRenderer.invoke('cofounderos:probe-ffprobe'),
  probeMicPermission: () => ipcRenderer.invoke('cofounderos:probe-mic-permission'),
  requestMicPermission: () => ipcRenderer.invoke('cofounderos:request-mic-permission'),
  onDesktopLogs: (callback: (logs: string) => void) => {
    ipcRenderer.on('cofounderos:desktop-logs', (_event, logs: string) => callback(logs));
  },
  onBootstrapProgress: (callback: (progress: unknown) => void) => {
    ipcRenderer.on('cofounderos:bootstrap-progress', (_event, progress: unknown) => callback(progress));
  },
  onWhisperInstallProgress: (callback: (event: unknown) => void) => {
    ipcRenderer.on('cofounderos:whisper-install-progress', (_e, event: unknown) => callback(event));
  },
  onOverview: (callback: (overview: unknown) => void) => {
    ipcRenderer.on('cofounderos:overview', (_event, overview: unknown) => callback(overview));
  },
};

contextBridge.exposeInMainWorld('cofounderos', api);

export type CofounderOSDesktopApi = typeof api;

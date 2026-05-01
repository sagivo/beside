import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getOverview: () => ipcRenderer.invoke('cofounderos:overview'),
  runDoctor: () => ipcRenderer.invoke('cofounderos:doctor'),
  readConfig: () => ipcRenderer.invoke('cofounderos:read-config'),
  validateConfig: (config: unknown) => ipcRenderer.invoke('cofounderos:validate-config', config),
  saveConfigPatch: (patch: unknown) => ipcRenderer.invoke('cofounderos:save-config-patch', patch),
  listJournalDays: () => ipcRenderer.invoke('cofounderos:list-journal-days'),
  getJournalDay: (day: string) => ipcRenderer.invoke('cofounderos:get-journal-day', day),
  searchFrames: (query: unknown) => ipcRenderer.invoke('cofounderos:search-frames', query),
  readAsset: (assetPath: string) => ipcRenderer.invoke('cofounderos:read-asset', assetPath),
  startRuntime: () => ipcRenderer.invoke('cofounderos:start-runtime'),
  stopRuntime: () => ipcRenderer.invoke('cofounderos:stop-runtime'),
  pauseCapture: () => ipcRenderer.invoke('cofounderos:pause-capture'),
  resumeCapture: () => ipcRenderer.invoke('cofounderos:resume-capture'),
  triggerIndex: () => ipcRenderer.invoke('cofounderos:trigger-index'),
  triggerReorganise: () => ipcRenderer.invoke('cofounderos:trigger-reorganise'),
  bootstrapModel: () => ipcRenderer.invoke('cofounderos:bootstrap-model'),
  getStartAtLogin: () => ipcRenderer.invoke('cofounderos:get-start-at-login'),
  setStartAtLogin: (enabled: boolean) => ipcRenderer.invoke('cofounderos:set-start-at-login', enabled),
  openPath: (target: 'config' | 'data' | 'markdown') => ipcRenderer.invoke('cofounderos:open-path', target),
  copyText: (text: string) => ipcRenderer.invoke('cofounderos:copy-text', text),
  onDesktopLogs: (callback: (logs: string) => void) => {
    ipcRenderer.on('cofounderos:desktop-logs', (_event, logs: string) => callback(logs));
  },
  onBootstrapProgress: (callback: (progress: unknown) => void) => {
    ipcRenderer.on('cofounderos:bootstrap-progress', (_event, progress: unknown) => callback(progress));
  },
};

contextBridge.exposeInMainWorld('cofounderos', api);

export type CofounderOSDesktopApi = typeof api;

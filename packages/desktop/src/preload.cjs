const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getOverview: () => ipcRenderer.invoke('cofounderos:overview'),
  runDoctor: () => ipcRenderer.invoke('cofounderos:doctor'),
  readConfig: () => ipcRenderer.invoke('cofounderos:read-config'),
  validateConfig: (config) => ipcRenderer.invoke('cofounderos:validate-config', config),
  saveConfigPatch: (patch) => ipcRenderer.invoke('cofounderos:save-config-patch', patch),
  listJournalDays: () => ipcRenderer.invoke('cofounderos:list-journal-days'),
  getJournalDay: (day) => ipcRenderer.invoke('cofounderos:get-journal-day', day),
  searchFrames: (query) => ipcRenderer.invoke('cofounderos:search-frames', query),
  readAsset: (assetPath) => ipcRenderer.invoke('cofounderos:read-asset', assetPath),
  startRuntime: () => ipcRenderer.invoke('cofounderos:start-runtime'),
  stopRuntime: () => ipcRenderer.invoke('cofounderos:stop-runtime'),
  pauseCapture: () => ipcRenderer.invoke('cofounderos:pause-capture'),
  resumeCapture: () => ipcRenderer.invoke('cofounderos:resume-capture'),
  bootstrapModel: () => ipcRenderer.invoke('cofounderos:bootstrap-model'),
  getStartAtLogin: () => ipcRenderer.invoke('cofounderos:get-start-at-login'),
  setStartAtLogin: (enabled) => ipcRenderer.invoke('cofounderos:set-start-at-login', enabled),
  openPath: (target) => ipcRenderer.invoke('cofounderos:open-path', target),
  copyText: (text) => ipcRenderer.invoke('cofounderos:copy-text', text),
  onDesktopLogs: (callback) => {
    ipcRenderer.on('cofounderos:desktop-logs', (_event, logs) => callback(logs));
  },
  onBootstrapProgress: (callback) => {
    ipcRenderer.on('cofounderos:bootstrap-progress', (_event, progress) => callback(progress));
  },
};

contextBridge.exposeInMainWorld('cofounderos', api);

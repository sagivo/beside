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
  explainSearchResults: (query) => ipcRenderer.invoke('cofounderos:explain-search-results', query),
  getFrameIndexDetails: (frameId) => ipcRenderer.invoke('cofounderos:get-frame-index-details', frameId),
  assetUrl: (assetPath) => ipcRenderer.invoke('cofounderos:asset-url', assetPath),
  readAsset: (assetPath) => ipcRenderer.invoke('cofounderos:read-asset', assetPath),
  startRuntime: () => ipcRenderer.invoke('cofounderos:start-runtime'),
  stopRuntime: () => ipcRenderer.invoke('cofounderos:stop-runtime'),
  pauseCapture: () => ipcRenderer.invoke('cofounderos:pause-capture'),
  resumeCapture: () => ipcRenderer.invoke('cofounderos:resume-capture'),
  triggerIndex: () => ipcRenderer.invoke('cofounderos:trigger-index'),
  triggerReorganise: () => ipcRenderer.invoke('cofounderos:trigger-reorganise'),
  triggerFullReindex: (range) => ipcRenderer.invoke('cofounderos:trigger-full-reindex', range),
  bootstrapModel: () => ipcRenderer.invoke('cofounderos:bootstrap-model'),
  updateModel: () => ipcRenderer.invoke('cofounderos:update-model'),
  getStartAtLogin: () => ipcRenderer.invoke('cofounderos:get-start-at-login'),
  setStartAtLogin: (enabled) => ipcRenderer.invoke('cofounderos:set-start-at-login', enabled),
  openPath: (target) => ipcRenderer.invoke('cofounderos:open-path', target),
  copyText: (text) => ipcRenderer.invoke('cofounderos:copy-text', text),
  deleteFrame: (frameId) => ipcRenderer.invoke('cofounderos:delete-frame', frameId),
  deleteAllMemory: () => ipcRenderer.invoke('cofounderos:delete-all-memory'),
  probeWhisper: () => ipcRenderer.invoke('cofounderos:probe-whisper'),
  detectWhisperInstaller: () => ipcRenderer.invoke('cofounderos:detect-whisper-installer'),
  installWhisper: () => ipcRenderer.invoke('cofounderos:install-whisper'),
  probeFfprobe: () => ipcRenderer.invoke('cofounderos:probe-ffprobe'),
  probeMicPermission: () => ipcRenderer.invoke('cofounderos:probe-mic-permission'),
  requestMicPermission: () => ipcRenderer.invoke('cofounderos:request-mic-permission'),
  probeScreenPermission: () => ipcRenderer.invoke('cofounderos:probe-screen-permission'),
  requestScreenPermission: () => ipcRenderer.invoke('cofounderos:request-screen-permission'),
  probeAccessibilityPermission: () =>
    ipcRenderer.invoke('cofounderos:probe-accessibility-permission'),
  requestAccessibilityPermission: () =>
    ipcRenderer.invoke('cofounderos:request-accessibility-permission'),
  openPermissionSettings: (kind) =>
    ipcRenderer.invoke('cofounderos:open-permission-settings', kind),
  relaunchApp: () => ipcRenderer.invoke('cofounderos:relaunch-app'),
  onDesktopLogs: (callback) => {
    ipcRenderer.on('cofounderos:desktop-logs', (_event, logs) => callback(logs));
  },
  onBootstrapProgress: (callback) => {
    ipcRenderer.on('cofounderos:bootstrap-progress', (_event, progress) => callback(progress));
  },
  onWhisperInstallProgress: (callback) => {
    ipcRenderer.on('cofounderos:whisper-install-progress', (_e, event) => callback(event));
  },
  onOverview: (callback) => {
    ipcRenderer.on('cofounderos:overview', (_event, overview) => callback(overview));
  },
  startChat: (params) => ipcRenderer.invoke('cofounderos:chat-start', params),
  cancelChat: (turnId) => ipcRenderer.invoke('cofounderos:chat-cancel', turnId),
  onChatEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('cofounderos:chat-event', listener);
    return () => ipcRenderer.removeListener('cofounderos:chat-event', listener);
  },
  listMeetings: (query) => ipcRenderer.invoke('cofounderos:list-meetings', query),
  listDayEvents: (query) => ipcRenderer.invoke('cofounderos:list-day-events', query),
  triggerEventExtractor: () => ipcRenderer.invoke('cofounderos:trigger-event-extractor'),
};

contextBridge.exposeInMainWorld('cofounderos', api);

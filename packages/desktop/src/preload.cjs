const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getOverview: () => ipcRenderer.invoke('beside:overview'),
  runDoctor: () => ipcRenderer.invoke('beside:doctor'),
  readConfig: () => ipcRenderer.invoke('beside:read-config'),
  validateConfig: (config) => ipcRenderer.invoke('beside:validate-config', config),
  saveConfigPatch: (patch) => ipcRenderer.invoke('beside:save-config-patch', patch),
  listJournalDays: () => ipcRenderer.invoke('beside:list-journal-days'),
  getJournalDay: (day) => ipcRenderer.invoke('beside:get-journal-day', day),
  searchFrames: (query) => ipcRenderer.invoke('beside:search-frames', query),
  explainSearchResults: (query) => ipcRenderer.invoke('beside:explain-search-results', query),
  getFrameIndexDetails: (frameId) => ipcRenderer.invoke('beside:get-frame-index-details', frameId),
  assetUrl: (assetPath) => ipcRenderer.invoke('beside:asset-url', assetPath),
  readAsset: (assetPath) => ipcRenderer.invoke('beside:read-asset', assetPath),
  startRuntime: () => ipcRenderer.invoke('beside:start-runtime'),
  stopRuntime: () => ipcRenderer.invoke('beside:stop-runtime'),
  pauseCapture: () => ipcRenderer.invoke('beside:pause-capture'),
  resumeCapture: () => ipcRenderer.invoke('beside:resume-capture'),
  triggerIndex: () => ipcRenderer.invoke('beside:trigger-index'),
  triggerReorganise: () => ipcRenderer.invoke('beside:trigger-reorganise'),
  triggerFullReindex: (range) => ipcRenderer.invoke('beside:trigger-full-reindex', range),
  bootstrapModel: () => ipcRenderer.invoke('beside:bootstrap-model'),
  updateModel: () => ipcRenderer.invoke('beside:update-model'),
  getStartAtLogin: () => ipcRenderer.invoke('beside:get-start-at-login'),
  setStartAtLogin: (enabled) => ipcRenderer.invoke('beside:set-start-at-login', enabled),
  openPath: (target) => ipcRenderer.invoke('beside:open-path', target),
  copyText: (text) => ipcRenderer.invoke('beside:copy-text', text),
  openAssetPath: (assetPath) => ipcRenderer.invoke('beside:open-asset-path', assetPath),
  deleteFrame: (frameId) => ipcRenderer.invoke('beside:delete-frame', frameId),
  deleteAllMemory: () => ipcRenderer.invoke('beside:delete-all-memory'),
  probeWhisper: () => ipcRenderer.invoke('beside:probe-whisper'),
  detectWhisperInstaller: () => ipcRenderer.invoke('beside:detect-whisper-installer'),
  installWhisper: () => ipcRenderer.invoke('beside:install-whisper'),
  probeFfprobe: () => ipcRenderer.invoke('beside:probe-ffprobe'),
  probeMicPermission: () => ipcRenderer.invoke('beside:probe-mic-permission'),
  requestMicPermission: () => ipcRenderer.invoke('beside:request-mic-permission'),
  probeScreenPermission: () => ipcRenderer.invoke('beside:probe-screen-permission'),
  requestScreenPermission: () => ipcRenderer.invoke('beside:request-screen-permission'),
  probeAccessibilityPermission: () =>
    ipcRenderer.invoke('beside:probe-accessibility-permission'),
  requestAccessibilityPermission: () =>
    ipcRenderer.invoke('beside:request-accessibility-permission'),
  openPermissionSettings: (kind) =>
    ipcRenderer.invoke('beside:open-permission-settings', kind),
  relaunchApp: () => ipcRenderer.invoke('beside:relaunch-app'),
  onDesktopLogs: (callback) => {
    ipcRenderer.on('beside:desktop-logs', (_event, logs) => callback(logs));
  },
  onBootstrapProgress: (callback) => {
    ipcRenderer.on('beside:bootstrap-progress', (_event, progress) => callback(progress));
  },
  onWhisperInstallProgress: (callback) => {
    ipcRenderer.on('beside:whisper-install-progress', (_e, event) => callback(event));
  },
  onOverview: (callback) => {
    ipcRenderer.on('beside:overview', (_event, overview) => callback(overview));
  },
  listMeetings: (query) => ipcRenderer.invoke('beside:list-meetings', query),
  listDayEvents: (query) => ipcRenderer.invoke('beside:list-day-events', query),
  getActionCenter: (query) => ipcRenderer.invoke('beside:get-action-center', query),
  triggerEventExtractor: () => ipcRenderer.invoke('beside:trigger-event-extractor'),
  listCaptureHookDefinitions: () => ipcRenderer.invoke('beside:list-capture-hook-definitions'),
  listCaptureHookWidgetManifests: () => ipcRenderer.invoke('beside:list-capture-hook-widget-manifests'),
  getCaptureHookDiagnostics: () => ipcRenderer.invoke('beside:get-capture-hook-diagnostics'),
  queryCaptureHookStorage: (params) => ipcRenderer.invoke('beside:query-capture-hook-storage', params),
  mutateCaptureHookStorage: (params) => ipcRenderer.invoke('beside:mutate-capture-hook-storage', params),
  readCaptureHookWidgetBundle: (params) => ipcRenderer.invoke('beside:read-capture-hook-widget-bundle', params),
  onCaptureHookUpdate: (callback) => {
    ipcRenderer.on('beside:capture-hook-update', (_event, payload) => callback(payload));
  },
};

contextBridge.exposeInMainWorld('beside', api);

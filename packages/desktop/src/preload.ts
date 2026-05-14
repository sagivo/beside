import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

function onIpc<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  getOverview: () => ipcRenderer.invoke('beside:overview'),
  runDoctor: () => ipcRenderer.invoke('beside:doctor'),
  readConfig: () => ipcRenderer.invoke('beside:read-config'),
  validateConfig: (config: unknown) => ipcRenderer.invoke('beside:validate-config', config),
  saveConfigPatch: (patch: unknown) => ipcRenderer.invoke('beside:save-config-patch', patch),
  listJournalDays: () => ipcRenderer.invoke('beside:list-journal-days'),
  getJournalDay: (day: string) => ipcRenderer.invoke('beside:get-journal-day', day),
  readJournalMarkdown: (day: string) => ipcRenderer.invoke('beside:read-journal-markdown', day),
  searchFrames: (query: unknown) => ipcRenderer.invoke('beside:search-frames', query),
  explainSearchResults: (query: unknown) => ipcRenderer.invoke('beside:explain-search-results', query),
  getFrameIndexDetails: (frameId: string) => ipcRenderer.invoke('beside:get-frame-index-details', frameId),
  assetUrl: (assetPath: string) => ipcRenderer.invoke('beside:asset-url', assetPath),
  readAsset: (assetPath: string) => ipcRenderer.invoke('beside:read-asset', assetPath),
  startRuntime: () => ipcRenderer.invoke('beside:start-runtime'),
  stopRuntime: () => ipcRenderer.invoke('beside:stop-runtime'),
  pauseCapture: () => ipcRenderer.invoke('beside:pause-capture'),
  resumeCapture: () => ipcRenderer.invoke('beside:resume-capture'),
  triggerIndex: () => ipcRenderer.invoke('beside:trigger-index'),
  triggerReorganise: () => ipcRenderer.invoke('beside:trigger-reorganise'),
  triggerFullReindex: (range: { from?: string; to?: string }) => ipcRenderer.invoke('beside:trigger-full-reindex', range),
  bootstrapModel: () => ipcRenderer.invoke('beside:bootstrap-model'),
  updateModel: () => ipcRenderer.invoke('beside:update-model'),
  getStartAtLogin: () => ipcRenderer.invoke('beside:get-start-at-login'),
  setStartAtLogin: (enabled: boolean) => ipcRenderer.invoke('beside:set-start-at-login', enabled),
  openPath: (target: 'config' | 'data' | 'markdown' | { target: 'markdown'; category?: string }) => ipcRenderer.invoke('beside:open-path', target),
  copyText: (text: string) => ipcRenderer.invoke('beside:copy-text', text),
  openExternalUrl: (url: string) => ipcRenderer.invoke('beside:open-external-url', url),
  openAssetPath: (assetPath: string) => ipcRenderer.invoke('beside:open-asset-path', assetPath),
  deleteFrame: (frameId: string) => ipcRenderer.invoke('beside:delete-frame', frameId),
  deleteFrames: (query: { app?: string; urlDomain?: string }) =>
    ipcRenderer.invoke('beside:delete-frames', query),
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
  openPermissionSettings: (kind: 'screen' | 'accessibility' | 'microphone' | 'automation') =>
    ipcRenderer.invoke('beside:open-permission-settings', kind),
  relaunchApp: () => ipcRenderer.invoke('beside:relaunch-app'),
  getOnboardingComplete: (): Promise<boolean> => ipcRenderer.invoke('beside:get-onboarding-complete'),
  setOnboardingComplete: (done: boolean): Promise<boolean> => ipcRenderer.invoke('beside:set-onboarding-complete', done),
  onDesktopLogs: (callback: (logs: string) => void) => {
    return onIpc('beside:desktop-logs', callback);
  },
  onBootstrapProgress: (callback: (progress: unknown) => void) => {
    return onIpc('beside:bootstrap-progress', callback);
  },
  onWhisperInstallProgress: (callback: (event: unknown) => void) => {
    return onIpc('beside:whisper-install-progress', callback);
  },
  onOverview: (callback: (overview: unknown) => void) => {
    return onIpc('beside:overview', callback);
  },
  listMeetings: (query?: { from?: string; to?: string; limit?: number }) =>
    ipcRenderer.invoke('beside:list-meetings', query),
  listDayEvents: (query?: {
    day?: string;
    from?: string;
    to?: string;
    kind?: string;
    limit?: number;
  }) => ipcRenderer.invoke('beside:list-day-events', query),
  triggerEventExtractor: () => ipcRenderer.invoke('beside:trigger-event-extractor'),
  listCaptureHookDefinitions: () => ipcRenderer.invoke('beside:list-capture-hook-definitions'),
  listCaptureHookWidgetManifests: () => ipcRenderer.invoke('beside:list-capture-hook-widget-manifests'),
  getCaptureHookDiagnostics: () => ipcRenderer.invoke('beside:get-capture-hook-diagnostics'),
  queryCaptureHookStorage: (params: { hookId: string; query?: unknown }) =>
    ipcRenderer.invoke('beside:query-capture-hook-storage', params),
  mutateCaptureHookStorage: (params: {
    hookId: string;
    mutation: { collection: string; id: string; data: unknown; evidenceEventIds?: string[]; contentHash?: string | null };
  }) => ipcRenderer.invoke('beside:mutate-capture-hook-storage', params),
  readCaptureHookWidgetBundle: (params: { resolvedBundlePath: string }) =>
    ipcRenderer.invoke('beside:read-capture-hook-widget-bundle', params),
  onCaptureHookUpdate: (callback: (payload: { hookId: string }) => void) => {
    return onIpc('beside:capture-hook-update', callback);
  },
};

contextBridge.exposeInMainWorld('beside', api);

export type BesideDesktopApi = typeof api;

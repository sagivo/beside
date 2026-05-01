export {};

declare global {
  interface Window {
    cofounderos: {
      getOverview: () => Promise<RuntimeOverview>;
      runDoctor: () => Promise<DoctorCheck[]>;
      readConfig: () => Promise<LoadedConfig>;
      validateConfig: (config: unknown) => Promise<ConfigValidation>;
      saveConfigPatch: (patch: unknown) => Promise<LoadedConfig>;
      listJournalDays: () => Promise<string[]>;
      getJournalDay: (day: string) => Promise<JournalDay>;
      searchFrames: (query: unknown) => Promise<Frame[]>;
      readAsset: (assetPath: string) => Promise<Uint8Array>;
      startRuntime: () => Promise<RuntimeOverview>;
      stopRuntime: () => Promise<{ stopped: true }>;
      pauseCapture: () => Promise<RuntimeOverview>;
      resumeCapture: () => Promise<RuntimeOverview>;
      bootstrapModel: () => Promise<{ ready: true }>;
      getStartAtLogin: () => Promise<boolean>;
      setStartAtLogin: (enabled: boolean) => Promise<boolean>;
      openPath: (target: 'config' | 'data' | 'markdown') => Promise<{ opened: string }>;
      copyText: (text: string) => Promise<{ copied: true }>;
      onDesktopLogs?: (callback: (logs: string) => void) => void;
      onBootstrapProgress?: (callback: (progress: ModelBootstrapProgress) => void) => void;
    };
  }
}

export interface RuntimeOverview {
  status: string;
  configPath: string;
  dataDir: string;
  storageRoot: string;
  capture: {
    running: boolean;
    paused: boolean;
    eventsToday: number;
    storageBytesToday?: number;
  };
  storage: {
    totalEvents: number;
    totalAssetBytes: number;
  };
  index: {
    pageCount: number;
    eventsCovered: number;
  };
  indexing: RuntimeIndexingStatus;
  model: {
    name: string;
    ready: boolean;
  };
  exports: Array<{
    name: string;
    running: boolean;
  }>;
}

export interface RuntimeIndexingStatus {
  running: boolean;
  currentJob: string | null;
  startedAt: string | null;
  lastCompletedAt: string | null;
}

export interface DoctorCheck {
  area: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  detail?: string;
  action?: string;
}

export type ModelBootstrapProgress =
  | { kind: string; message?: string; model?: string; status?: string; completed?: number; total?: number; line?: string; tool?: string; host?: string; reason?: string };

export interface LoadedConfig {
  sourcePath: string;
  dataDir: string;
  config: CofounderConfig;
}

export type ConfigValidation =
  | { ok: true; config: CofounderConfig }
  | { ok: false; issues: Array<{ path: string; message: string }> };

export interface CofounderConfig {
  capture: {
    excluded_apps: string[];
    excluded_url_patterns: string[];
    privacy: {
      blur_password_fields: boolean;
      pause_on_screen_lock: boolean;
      sensitive_keywords: string[];
    };
  };
  storage: {
    local: {
      max_size_gb: number;
      retention_days: number;
      vacuum: {
        compress_after_days: number;
        thumbnail_after_days: number;
        delete_after_days: number;
      };
    };
  };
  index: {
    incremental_interval_min: number;
    model: {
      plugin: string;
      ollama?: {
        model: string;
        embedding_model: string;
        host: string;
        auto_install?: boolean;
      };
    };
  };
  export: {
    plugins: Array<Record<string, unknown> & {
      name: string;
      enabled?: boolean;
      path?: string;
      host?: string;
      port?: number;
    }>;
  };
}

export interface JournalDay {
  day: string;
  frames: Frame[];
  sessions: ActivitySession[];
}

export interface Frame {
  id?: string;
  timestamp?: string;
  day?: string;
  app?: string;
  window_title?: string;
  url?: string | null;
  text?: string | null;
  asset_path?: string | null;
  activity_session_id?: string | null;
  entity_path?: string | null;
}

export interface ActivitySession {
  id?: string;
  started_at?: string;
  ended_at?: string;
  primary_entity_path?: string | null;
  primary_app?: string | null;
  active_ms?: number;
  frame_count?: number;
}

export {};

declare global {
  /** App version, injected at build time by Vite from package.json. */
  const __APP_VERSION__: string;

  interface Window {
    cofounderos: {
      getOverview: () => Promise<RuntimeOverview>;
      runDoctor: () => Promise<DoctorCheck[]>;
      readConfig: () => Promise<LoadedConfig>;
      validateConfig: (config: unknown) => Promise<ConfigValidation>;
      saveConfigPatch: (patch: unknown) => Promise<LoadedConfig>;
      listJournalDays: () => Promise<string[]>;
      getJournalDay: (day: string) => Promise<JournalDay>;
      getIndexedJournalDay: (day: string) => Promise<IndexedJournalDay>;
      searchFrames: (query: unknown) => Promise<Frame[]>;
      explainSearchResults: (query: unknown) => Promise<SearchResultExplanation[]>;
      getFrameIndexDetails: (frameId: string) => Promise<FrameIndexDetails | null>;
      assetUrl: (assetPath: string) => Promise<string>;
      readAsset: (assetPath: string) => Promise<Uint8Array>;
      startRuntime: () => Promise<RuntimeOverview>;
      stopRuntime: () => Promise<{ stopped: true }>;
      pauseCapture: () => Promise<RuntimeOverview>;
      resumeCapture: () => Promise<RuntimeOverview>;
      triggerIndex: () => Promise<RuntimeOverview>;
      triggerReorganise: () => Promise<RuntimeOverview>;
      triggerFullReindex: (range: { from?: string; to?: string }) => Promise<RuntimeOverview>;
      bootstrapModel: () => Promise<{ ready: true }>;
      updateModel: () => Promise<{ ready: true }>;
      getStartAtLogin: () => Promise<boolean>;
      setStartAtLogin: (enabled: boolean) => Promise<boolean>;
      openPath: (target: OpenPathTarget) => Promise<{ opened: string }>;
      copyText: (text: string) => Promise<{ copied: true }>;
      deleteFrame: (frameId: string) => Promise<{ assetPath: string | null }>;
      deleteFramesByDay: (day: string) => Promise<{ frames: number; assetPaths: string[] }>;
      deleteAllMemory: () => Promise<{ frames: number; events: number; assetBytes: number }>;
      probeWhisper: () => Promise<WhisperProbe>;
      detectWhisperInstaller: () => Promise<{ installer: WhisperInstaller | null }>;
      installWhisper: () => Promise<{
        started: boolean;
        installer?: WhisperInstaller;
        reason?: string;
      }>;
      probeFfprobe: () => Promise<{ available: boolean; path?: string }>;
      probeMicPermission: () => Promise<MicPermission>;
      requestMicPermission: () => Promise<MicPermission>;
      onDesktopLogs?: (callback: (logs: string) => void) => void;
      onBootstrapProgress?: (callback: (progress: ModelBootstrapProgress) => void) => void;
      onWhisperInstallProgress?: (
        callback: (event: WhisperInstallProgress) => void,
      ) => void;
      onOverview?: (callback: (overview: RuntimeOverview) => void) => void;
      startChat: (params: {
        turnId: string;
        conversationId: string;
        message: string;
        history: Array<{ role: 'user' | 'assistant'; content: string }>;
      }) => Promise<{ turnId: string; completed: boolean }>;
      cancelChat: (turnId: string) => Promise<{ cancelled: boolean }>;
      onChatEvent?: (callback: (event: ChatStreamEvent) => void) => (() => void);
      listMeetings: (query?: { from?: string; to?: string; limit?: number }) => Promise<Meeting[]>;
    };
  }
}

export type ChatIntent =
  | 'daily_briefing'
  | 'calendar_check'
  | 'open_loops'
  | 'recall_preference'
  | 'recall_event'
  | 'project_status'
  | 'people_context'
  | 'time_audit'
  | 'topic_deep_dive'
  | 'general';

export interface ChatDateAnchor {
  day: string;
  label: string;
  fromIso: string;
  toIso: string;
}

export type ChatStreamEvent =
  | { kind: 'phase'; turnId: string; phase: 'classify' | 'plan' | 'execute' | 'compose' }
  | { kind: 'reasoning'; turnId: string; text: string }
  | { kind: 'intent'; turnId: string; intent: ChatIntent; anchor: ChatDateAnchor }
  | {
      kind: 'tool-call';
      turnId: string;
      tool: string;
      args: Record<string, unknown>;
      callId: string;
    }
  | {
      kind: 'tool-result';
      turnId: string;
      callId: string;
      tool: string;
      summary: string;
    }
  | { kind: 'content'; turnId: string; delta: string }
  | { kind: 'done'; turnId: string }
  | { kind: 'error'; turnId: string; message: string };

export interface RuntimeOverview {
  status: string;
  configPath: string;
  dataDir: string;
  storageRoot: string;
  capture: {
    running: boolean;
    paused: boolean;
    eventsToday: number;
    eventsLastHour?: number;
    storageBytesToday?: number;
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
    categories?: RuntimeIndexCategory[];
  };
  indexing: RuntimeIndexingStatus;
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
  backgroundJobs?: RuntimeBackgroundJobStatus[];
  system?: {
    load?: number | null;
    memory?: {
      totalMB: number;
      freeMB: number;
      usedRatio: number;
    };
    power?: {
      source: 'ac' | 'battery' | 'unknown';
      batteryPercent: number | null;
    };
    loadGuardEnabled?: boolean;
    backgroundModelJobs?: 'manual' | 'scheduled';
    overviewGeneratedAt?: string;
    overviewDurationMs?: number;
    overviewCacheTtlMs?: number;
    overviewMode?: 'full' | 'fast';
    overviewTimings?: Record<string, number>;
  };
}

export type OpenPathTarget =
  | 'config'
  | 'data'
  | 'markdown'
  | {
      target: 'markdown';
      category?: string;
    };

export interface RuntimeIndexCategory {
  name: string;
  pageCount: number;
  summaryPath?: string;
  lastUpdated: string | null;
  recentPages?: RuntimeIndexCategoryPage[];
}

export interface RuntimeIndexCategoryPage {
  path: string;
  title: string;
  summary: string | null;
  lastUpdated: string;
}

export interface RuntimeIndexingStatus {
  running: boolean;
  currentJob: string | null;
  startedAt: string | null;
  lastCompletedAt: string | null;
}

export interface RuntimeBackgroundJobStatus {
  name: string;
  kind: 'interval' | 'cron';
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  skippedCount: number;
}

export interface WhisperProbe {
  available: boolean;
  /** Absolute path to the binary, if found. */
  path?: string;
  /** First line of `whisper --help` for sanity-display, if available. */
  version?: string;
  /** When `available` is false, the resolved command name we tried. */
  triedCommand?: string;
}

/**
 * Package managers we can shell out to for the one-click Whisper
 * installer. `null` means we couldn't find any of them — the renderer
 * uses that to fall back to a manual instruction state.
 */
export type WhisperInstaller = 'brew' | 'pipx' | 'pip3' | 'pip';

export type WhisperInstallProgress =
  | { kind: 'started'; installer: WhisperInstaller; message?: string }
  | { kind: 'log'; installer: WhisperInstaller; message: string }
  | {
      kind: 'finished';
      installer: WhisperInstaller;
      available: boolean;
      path?: string;
    }
  | { kind: 'failed'; installer?: WhisperInstaller; reason?: string };

/**
 * macOS reports microphone permission as one of these states. On
 * non-macOS platforms (or before any probe), the renderer treats
 * `unsupported` as "we don't know — try anyway".
 */
export type MicPermission = {
  status: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unsupported';
};

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
    capture_audio?: boolean;
    whisper_model?: string;
    audio?: {
      inbox_path?: string;
      processed_path?: string;
      failed_path?: string;
      tick_interval_sec?: number;
      batch_size?: number;
      whisper_command?: string;
      whisper_language?: string;
      delete_audio_after_transcribe?: boolean;
      max_audio_bytes?: number;
      live_recording?: {
        enabled?: boolean;
        chunk_seconds?: number;
        sample_rate?: number;
        channels?: number;
        system_audio_backend?: 'core_audio_tap' | 'screencapturekit' | 'off';
        activation?: 'other_process_input';
        poll_interval_sec?: number;
      };
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
        keep_alive?: string | number;
        unload_after_idle_min?: number;
        auto_install?: boolean;
        model_revision?: number;
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

export interface IndexedJournalDay {
  day: string;
  markdown: string;
}

export interface Frame {
  id?: string;
  timestamp?: string;
  day?: string;
  app?: string;
  window_title?: string;
  url?: string | null;
  text?: string | null;
  text_source?: string | null;
  asset_path?: string | null;
  perceptual_hash?: string | null;
  trigger?: string | null;
  activity_session_id?: string | null;
  entity_path?: string | null;
  entity_kind?: string | null;
  source_event_ids?: string[];
}

export interface FrameIndexDetails {
  frameId: string;
  caption: string | null;
  indexingText: string | null;
  metadata: Record<string, unknown>;
}

export interface SearchResultExplanation {
  frameId: string;
  explanation: string;
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

export type MeetingPlatform = 'zoom' | 'meet' | 'teams' | 'webex' | 'whereby' | 'around' | 'other';
export type MeetingSummaryStatus = 'pending' | 'running' | 'ready' | 'failed' | 'skipped_short';

export interface MeetingSummaryJson {
  title: string | null;
  tldr: string;
  agenda: string[];
  decisions: Array<{ text: string; evidence_turn_ids: number[] }>;
  action_items: Array<{ task: string; owner: string | null; due: string | null; evidence_turn_ids: number[] }>;
  open_questions: Array<{ text: string; evidence_turn_ids: number[] }>;
  attendees_seen: string[];
  links_shared: string[];
  notes: string | null;
}

export interface Meeting {
  id: string;
  entity_path: string;
  title: string | null;
  platform: MeetingPlatform;
  started_at: string;
  ended_at: string;
  day: string;
  duration_ms: number;
  frame_count: number;
  screenshot_count: number;
  audio_chunk_count: number;
  transcript_chars: number;
  content_hash: string;
  summary_status: MeetingSummaryStatus;
  summary_md: string | null;
  summary_json: MeetingSummaryJson | null;
  attendees: string[];
  links: string[];
  failure_reason: string | null;
  updated_at: string;
}

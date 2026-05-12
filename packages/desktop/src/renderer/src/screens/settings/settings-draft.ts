import type { LoadedConfig } from '@/global';

export type BackgroundModelJobs = 'manual' | 'scheduled';
export type CaptureMode = 'active' | 'all';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ScreenshotFormat = 'webp' | 'jpeg';
export type SystemAudioBackend = 'core_audio_tap' | 'screencapturekit' | 'off';
export type LiveRecordingFormat = 'm4a';
export type McpTransport = 'http' | 'stdio';

export interface SettingsDraft {
  // App
  appName: string;
  appDataDir: string;
  logLevel: LogLevel;
  sessionId: string;
  // Capture
  capturePlugin: string;
  pollIntervalMs: number;
  idlePollIntervalMs: number;
  focusSettleDelayMs: number;
  screenshotDiffThreshold: number;
  idleThresholdSec: number;
  screenshotFormat: ScreenshotFormat;
  screenshotQuality: number;
  jpegQuality: string;
  screenshotMaxDim: number;
  contentChangeMinIntervalMs: number;
  multiScreen: boolean;
  screens: string;
  captureMode: CaptureMode;
  blurPasswordFields: boolean;
  pauseOnScreenLock: boolean;
  sensitiveKeywords: string;
  excludedApps: string;
  excludedUrlPatterns: string;
  accessibilityEnabled: boolean;
  accessibilityTimeoutMs: number;
  accessibilityMaxChars: number;
  accessibilityMaxElements: number;
  accessibilityExcludedApps: string;
  // Storage
  storagePlugin: string;
  storagePath: string;
  maxSizeGb: number;
  retentionDays: number;
  compressAfterDays: number;
  compressAfterMinutes: string;
  compressQuality: number;
  thumbnailAfterDays: number;
  thumbnailAfterMinutes: string;
  thumbnailMaxDim: number;
  deleteAfterDays: number;
  deleteAfterMinutes: string;
  vacuumTickIntervalMin: number;
  vacuumBatchSize: number;
  // Index
  indexStrategy: string;
  indexPath: string;
  incrementalIntervalMin: number;
  reorganiseSchedule: string;
  reorganiseOnIdle: boolean;
  indexIdleTriggerMin: number;
  indexBatchSize: number;
  sessionsIdleThresholdSec: number;
  sessionsAfkThresholdSec: number;
  sessionsMinActiveMs: number;
  sessionsFallbackFrameAttentionMs: number;
  meetingsIdleThresholdSec: number;
  meetingsMinDurationSec: number;
  meetingsAudioGraceSec: number;
  meetingsSummarize: boolean;
  meetingsSummarizeCooldownSec: number;
  meetingsVisionAttachments: number;
  embeddingsEnabled: boolean;
  embeddingsBatchSize: number;
  embeddingsTickIntervalMin: number;
  embeddingsSearchWeight: number;
  // Model / AI
  modelPlugin: string;
  // Model selection is owned by the dedicated picker in the AI tab and
  // saved/applied via its own action (see ModelSettings). We
  // intentionally do NOT include it in this generic draft so the
  // global SaveBar can't quietly trigger a model swap or re-pull as a
  // side-effect of saving e.g. a sensitive_keywords change.
  ollamaHost: string;
  ollamaAutoInstall: boolean;
  ollamaEmbeddingModel: string;
  ollamaVisionModel: string;
  ollamaIndexerModel: string;
  ollamaKeepAlive: string;
  ollamaUnloadAfterIdleMin: number;
  ollamaModelRevision: number;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiVisionModel: string;
  openaiEmbeddingModel: string;
  claudeApiKey: string;
  claudeModel: string;
  // Export
  markdownEnabled: boolean;
  markdownPath: string;
  mcpEnabled: boolean;
  mcpHost: string;
  mcpPort: number;
  mcpTransport: McpTransport;
  mcpTextExcerptChars: number;
  extraExportPlugins: Array<Record<string, unknown> & { name: string; enabled?: boolean }>;
  // Audio
  captureAudio: boolean;
  whisperModel: string;
  audioInboxPath: string;
  audioProcessedPath: string;
  audioFailedPath: string;
  audioTickIntervalSec: number;
  audioBatchSize: number;
  whisperCommand: string;
  whisperLanguage: string;
  maxAudioBytes: number;
  minAudioBytesPerSec: number;
  minAudioRateCheckMs: number;
  liveRecordingEnabled: boolean;
  liveRecordingFormat: LiveRecordingFormat;
  liveRecordingSampleRate: number;
  liveRecordingChannels: number;
  liveRecordingPollIntervalSec: number;
  systemAudioBackend: SystemAudioBackend;
  chunkSeconds: number;
  deleteAudioAfterTranscribe: boolean;
  // System
  backgroundModelJobs: BackgroundModelJobs;
  loadGuardEnabled: boolean;
  loadGuardThreshold: number;
  loadGuardMemoryThreshold: number;
  loadGuardLowBatteryThresholdPct: number;
  loadGuardMaxConsecutiveSkips: number;
}

export function settingsDraftFromConfig(loaded: LoadedConfig): SettingsDraft {
  const cfg = loaded.config;
  const markdown = cfg.export.plugins.find((p) => p.name === 'markdown');
  const mcp = cfg.export.plugins.find((p) => p.name === 'mcp');
  const vacuum = cfg.storage.local.vacuum;
  const audio = cfg.capture.audio;
  const liveRecording = audio?.live_recording;
  const accessibility = cfg.capture.accessibility;
  const ollama = cfg.index.model.ollama;
  const openai = cfg.index.model.openai;
  const claude = cfg.index.model.claude;
  return {
    appName: cfg.app.name,
    appDataDir: cfg.app.data_dir,
    logLevel: cfg.app.log_level,
    sessionId: cfg.app.session_id ?? '',
    capturePlugin: cfg.capture.plugin,
    pollIntervalMs: cfg.capture.poll_interval_ms,
    idlePollIntervalMs: cfg.capture.idle_poll_interval_ms,
    focusSettleDelayMs: cfg.capture.focus_settle_delay_ms,
    screenshotDiffThreshold: cfg.capture.screenshot_diff_threshold,
    idleThresholdSec: cfg.capture.idle_threshold_sec,
    screenshotFormat: cfg.capture.screenshot_format,
    screenshotQuality: cfg.capture.screenshot_quality,
    jpegQuality: cfg.capture.jpeg_quality == null ? '' : String(cfg.capture.jpeg_quality),
    screenshotMaxDim: cfg.capture.screenshot_max_dim,
    contentChangeMinIntervalMs: cfg.capture.content_change_min_interval_ms,
    multiScreen: cfg.capture.multi_screen ?? false,
    screens: Array.isArray(cfg.capture.screens) ? cfg.capture.screens.join(', ') : '',
    captureMode: cfg.capture.capture_mode ?? 'active',
    blurPasswordFields: cfg.capture.privacy.blur_password_fields,
    pauseOnScreenLock: cfg.capture.privacy.pause_on_screen_lock,
    sensitiveKeywords: cfg.capture.privacy.sensitive_keywords.join('\n'),
    excludedApps: cfg.capture.excluded_apps.join('\n'),
    excludedUrlPatterns: cfg.capture.excluded_url_patterns.join('\n'),
    accessibilityEnabled: accessibility?.enabled ?? true,
    accessibilityTimeoutMs: accessibility?.timeout_ms ?? 1500,
    accessibilityMaxChars: accessibility?.max_chars ?? 8000,
    accessibilityMaxElements: accessibility?.max_elements ?? 4000,
    accessibilityExcludedApps: (accessibility?.excluded_apps ?? []).join('\n'),
    storagePlugin: cfg.storage.plugin,
    storagePath: cfg.storage.local.path,
    maxSizeGb: cfg.storage.local.max_size_gb,
    retentionDays: cfg.storage.local.retention_days,
    compressAfterDays: vacuum.compress_after_days,
    compressAfterMinutes:
      vacuum.compress_after_minutes == null ? '' : String(vacuum.compress_after_minutes),
    compressQuality: vacuum.compress_quality,
    thumbnailAfterDays: vacuum.thumbnail_after_days,
    thumbnailAfterMinutes:
      vacuum.thumbnail_after_minutes == null ? '' : String(vacuum.thumbnail_after_minutes),
    thumbnailMaxDim: vacuum.thumbnail_max_dim,
    deleteAfterDays: vacuum.delete_after_days,
    deleteAfterMinutes:
      vacuum.delete_after_minutes == null ? '' : String(vacuum.delete_after_minutes),
    vacuumTickIntervalMin: vacuum.tick_interval_min,
    vacuumBatchSize: vacuum.batch_size,
    indexStrategy: cfg.index.strategy,
    indexPath: cfg.index.index_path,
    incrementalIntervalMin: cfg.index.incremental_interval_min,
    reorganiseSchedule: cfg.index.reorganise_schedule,
    reorganiseOnIdle: cfg.index.reorganise_on_idle,
    indexIdleTriggerMin: cfg.index.idle_trigger_min,
    indexBatchSize: cfg.index.batch_size,
    sessionsIdleThresholdSec: cfg.index.sessions.idle_threshold_sec,
    sessionsAfkThresholdSec: cfg.index.sessions.afk_threshold_sec,
    sessionsMinActiveMs: cfg.index.sessions.min_active_ms,
    sessionsFallbackFrameAttentionMs: cfg.index.sessions.fallback_frame_attention_ms,
    meetingsIdleThresholdSec: cfg.index.meetings.idle_threshold_sec,
    meetingsMinDurationSec: cfg.index.meetings.min_duration_sec,
    meetingsAudioGraceSec: cfg.index.meetings.audio_grace_sec,
    meetingsSummarize: cfg.index.meetings.summarize,
    meetingsSummarizeCooldownSec: cfg.index.meetings.summarize_cooldown_sec,
    meetingsVisionAttachments: cfg.index.meetings.vision_attachments,
    embeddingsEnabled: cfg.index.embeddings.enabled,
    embeddingsBatchSize: cfg.index.embeddings.batch_size,
    embeddingsTickIntervalMin: cfg.index.embeddings.tick_interval_min,
    embeddingsSearchWeight: cfg.index.embeddings.search_weight,
    modelPlugin: cfg.index.model.plugin,
    ollamaHost: ollama?.host ?? 'http://127.0.0.1:11434',
    ollamaAutoInstall: ollama?.auto_install ?? true,
    ollamaEmbeddingModel: ollama?.embedding_model ?? 'nomic-embed-text',
    ollamaVisionModel: ollama?.vision_model ?? '',
    ollamaIndexerModel: ollama?.indexer_model ?? '',
    ollamaKeepAlive: String(ollama?.keep_alive ?? '30s'),
    ollamaUnloadAfterIdleMin: ollama?.unload_after_idle_min ?? 0,
    ollamaModelRevision: ollama?.model_revision ?? 0,
    openaiApiKey: openai?.api_key ?? '',
    openaiBaseUrl: openai?.base_url ?? 'https://api.openai.com/v1',
    openaiModel: openai?.model ?? 'gpt-4o-mini',
    openaiVisionModel: openai?.vision_model ?? '',
    openaiEmbeddingModel: openai?.embedding_model ?? 'text-embedding-3-small',
    claudeApiKey: claude?.api_key ?? '',
    claudeModel: claude?.model ?? 'claude-sonnet-4-6',
    markdownEnabled: markdown?.enabled ?? true,
    markdownPath: typeof markdown?.path === 'string' ? markdown.path : '',
    mcpEnabled: mcp?.enabled ?? true,
    mcpHost: typeof mcp?.host === 'string' ? mcp.host : '127.0.0.1',
    mcpPort: typeof mcp?.port === 'number' ? mcp.port : 3456,
    mcpTransport: mcp?.transport === 'stdio' ? 'stdio' : 'http',
    mcpTextExcerptChars:
      typeof mcp?.text_excerpt_chars === 'number' ? mcp.text_excerpt_chars : 5000,
    extraExportPlugins: cfg.export.plugins.filter((p) => p.name !== 'markdown' && p.name !== 'mcp'),
    captureAudio: cfg.capture.capture_audio ?? true,
    whisperModel: cfg.capture.whisper_model ?? 'base',
    audioInboxPath: audio?.inbox_path ?? '~/.cofounderOS/raw/audio/inbox',
    audioProcessedPath: audio?.processed_path ?? '~/.cofounderOS/raw/audio/processed',
    audioFailedPath: audio?.failed_path ?? '~/.cofounderOS/raw/audio/failed',
    audioTickIntervalSec: audio?.tick_interval_sec ?? 60,
    audioBatchSize: audio?.batch_size ?? 5,
    whisperCommand: audio?.whisper_command ?? 'whisper',
    whisperLanguage: audio?.whisper_language ?? '',
    maxAudioBytes: audio?.max_audio_bytes ?? 500 * 1024 * 1024,
    minAudioBytesPerSec: audio?.min_audio_bytes_per_sec ?? 4096,
    minAudioRateCheckMs: audio?.min_audio_rate_check_ms ?? 5000,
    liveRecordingEnabled: liveRecording?.enabled ?? false,
    liveRecordingFormat: liveRecording?.format ?? 'm4a',
    liveRecordingSampleRate: liveRecording?.sample_rate ?? 16_000,
    liveRecordingChannels: liveRecording?.channels ?? 1,
    liveRecordingPollIntervalSec: liveRecording?.poll_interval_sec ?? 3,
    systemAudioBackend: liveRecording?.system_audio_backend ?? 'core_audio_tap',
    chunkSeconds: liveRecording?.chunk_seconds ?? 300,
    deleteAudioAfterTranscribe: audio?.delete_audio_after_transcribe ?? true,
    backgroundModelJobs: cfg.system.background_model_jobs,
    loadGuardEnabled: cfg.system.load_guard.enabled,
    loadGuardThreshold: cfg.system.load_guard.threshold,
    loadGuardMemoryThreshold: cfg.system.load_guard.memory_threshold,
    loadGuardLowBatteryThresholdPct: cfg.system.load_guard.low_battery_threshold_pct,
    loadGuardMaxConsecutiveSkips: cfg.system.load_guard.max_consecutive_skips,
  };
}

export function configPatchFromDraft(draft: SettingsDraft) {
  const screens = integerList(draft.screens);
  return {
    app: {
      name: draft.appName.trim() || 'CofounderOS',
      data_dir: draft.appDataDir.trim() || '~/.cofounderOS',
      log_level: draft.logLevel,
      session_id: optionalString(draft.sessionId),
    },
    capture: {
      plugin:
        draft.captureAudio && draft.liveRecordingEnabled
          ? 'native'
          : draft.capturePlugin.trim() || 'node',
      poll_interval_ms: clampInt(draft.pollIntervalMs, 1),
      idle_poll_interval_ms: clampInt(draft.idlePollIntervalMs, 1),
      focus_settle_delay_ms: clampInt(draft.focusSettleDelayMs, 0),
      screenshot_diff_threshold: clampNumber(draft.screenshotDiffThreshold, 0, 1),
      idle_threshold_sec: clampInt(draft.idleThresholdSec, 1),
      screenshot_format: draft.screenshotFormat,
      screenshot_quality: clampInt(draft.screenshotQuality, 1, 100),
      jpeg_quality: optionalInt(draft.jpegQuality, 1, 100),
      screenshot_max_dim: clampInt(draft.screenshotMaxDim, 0, 8192),
      content_change_min_interval_ms: clampInt(draft.contentChangeMinIntervalMs, 0),
      multi_screen: draft.multiScreen,
      screens: screens.length > 0 ? screens : null,
      capture_mode: draft.captureMode,
      excluded_apps: lines(draft.excludedApps),
      excluded_url_patterns: lines(draft.excludedUrlPatterns),
      accessibility: {
        enabled: draft.accessibilityEnabled,
        timeout_ms: clampInt(draft.accessibilityTimeoutMs, 1),
        max_chars: clampInt(draft.accessibilityMaxChars, 1),
        max_elements: clampInt(draft.accessibilityMaxElements, 1),
        excluded_apps: lines(draft.accessibilityExcludedApps),
      },
      privacy: {
        blur_password_fields: draft.blurPasswordFields,
        pause_on_screen_lock: draft.pauseOnScreenLock,
        sensitive_keywords: lines(draft.sensitiveKeywords),
      },
      capture_audio: draft.captureAudio,
      whisper_model: draft.whisperModel.trim() || 'base',
      audio: {
        inbox_path: draft.audioInboxPath.trim() || '~/.cofounderOS/raw/audio/inbox',
        processed_path:
          draft.audioProcessedPath.trim() || '~/.cofounderOS/raw/audio/processed',
        failed_path: draft.audioFailedPath.trim() || '~/.cofounderOS/raw/audio/failed',
        tick_interval_sec: clampInt(draft.audioTickIntervalSec, 1),
        batch_size: clampInt(draft.audioBatchSize, 1),
        whisper_command: draft.whisperCommand.trim() || 'whisper',
        whisper_language: optionalString(draft.whisperLanguage),
        delete_audio_after_transcribe: draft.deleteAudioAfterTranscribe,
        max_audio_bytes: clampInt(draft.maxAudioBytes, 0),
        min_audio_bytes_per_sec: clampInt(draft.minAudioBytesPerSec, 0),
        min_audio_rate_check_ms: clampInt(draft.minAudioRateCheckMs, 0),
        live_recording: {
          enabled: draft.liveRecordingEnabled,
          activation: 'other_process_input',
          system_audio_backend: draft.systemAudioBackend,
          poll_interval_sec: clampInt(draft.liveRecordingPollIntervalSec, 1),
          chunk_seconds: clampInt(draft.chunkSeconds, 1),
          format: draft.liveRecordingFormat,
          sample_rate: clampInt(draft.liveRecordingSampleRate, 1),
          channels: clampInt(draft.liveRecordingChannels, 1, 2),
        },
      },
    },
    storage: {
      plugin: draft.storagePlugin.trim() || 'local',
      local: {
        path: draft.storagePath.trim() || '~/.cofounderOS',
        max_size_gb: clampNumber(draft.maxSizeGb, 0.1),
        retention_days: clampInt(draft.retentionDays, 0),
        vacuum: {
          compress_after_days: clampInt(draft.compressAfterDays, 0),
          compress_after_minutes: optionalInt(draft.compressAfterMinutes, 0),
          compress_quality: clampInt(draft.compressQuality, 1, 100),
          thumbnail_after_days: clampInt(draft.thumbnailAfterDays, 0),
          thumbnail_after_minutes: optionalInt(draft.thumbnailAfterMinutes, 0),
          thumbnail_max_dim: clampInt(draft.thumbnailMaxDim, 64, 2048),
          delete_after_days: clampInt(draft.deleteAfterDays, 0),
          delete_after_minutes: optionalInt(draft.deleteAfterMinutes, 0),
          tick_interval_min: clampInt(draft.vacuumTickIntervalMin, 1),
          batch_size: clampInt(draft.vacuumBatchSize, 1),
        },
      },
    },
    index: {
      strategy: draft.indexStrategy.trim() || 'karpathy',
      index_path: draft.indexPath.trim() || '~/.cofounderOS/index',
      incremental_interval_min: clampInt(draft.incrementalIntervalMin, 1),
      reorganise_schedule: draft.reorganiseSchedule.trim() || '0 2 * * *',
      reorganise_on_idle: draft.reorganiseOnIdle,
      idle_trigger_min: clampInt(draft.indexIdleTriggerMin, 1),
      batch_size: clampInt(draft.indexBatchSize, 1),
      sessions: {
        idle_threshold_sec: clampInt(draft.sessionsIdleThresholdSec, 1),
        afk_threshold_sec: clampInt(draft.sessionsAfkThresholdSec, 1),
        min_active_ms: clampInt(draft.sessionsMinActiveMs, 0),
        fallback_frame_attention_ms: clampInt(draft.sessionsFallbackFrameAttentionMs, 1),
      },
      meetings: {
        idle_threshold_sec: clampInt(draft.meetingsIdleThresholdSec, 1),
        min_duration_sec: clampInt(draft.meetingsMinDurationSec, 0),
        audio_grace_sec: clampInt(draft.meetingsAudioGraceSec, 0),
        summarize: draft.meetingsSummarize,
        summarize_cooldown_sec: clampInt(draft.meetingsSummarizeCooldownSec, 0),
        vision_attachments: clampInt(draft.meetingsVisionAttachments, 0),
      },
      embeddings: {
        enabled: draft.embeddingsEnabled,
        batch_size: clampInt(draft.embeddingsBatchSize, 1),
        tick_interval_min: clampInt(draft.embeddingsTickIntervalMin, 1),
        search_weight: clampNumber(draft.embeddingsSearchWeight, 0.01),
      },
      model: {
        plugin: draft.modelPlugin.trim() || 'ollama',
        ollama: {
          // Note: `model` and `model_revision` are managed by the AI
          // tab's dedicated picker (see ModelSettings). The generic
          // SaveBar exposes every other model runtime setting.
          host: draft.ollamaHost.trim(),
          auto_install: draft.ollamaAutoInstall,
          embedding_model: draft.ollamaEmbeddingModel.trim() || 'nomic-embed-text',
          vision_model: optionalString(draft.ollamaVisionModel),
          indexer_model: optionalString(draft.ollamaIndexerModel),
          keep_alive: draft.ollamaKeepAlive.trim() || '30s',
          unload_after_idle_min: clampNumber(draft.ollamaUnloadAfterIdleMin, 0),
          model_revision: clampInt(draft.ollamaModelRevision, 0),
        },
        openai: {
          api_key: optionalString(draft.openaiApiKey),
          base_url: draft.openaiBaseUrl.trim() || 'https://api.openai.com/v1',
          model: draft.openaiModel.trim() || 'gpt-4o-mini',
          vision_model: optionalString(draft.openaiVisionModel),
          embedding_model:
            draft.openaiEmbeddingModel.trim() || 'text-embedding-3-small',
        },
        claude: {
          api_key: optionalString(draft.claudeApiKey),
          model: draft.claudeModel.trim() || 'claude-sonnet-4-6',
        },
      },
    },
    export: {
      plugins: [
        {
          name: 'markdown',
          enabled: draft.markdownEnabled,
          path: draft.markdownPath.trim(),
        },
        {
          name: 'mcp',
          enabled: draft.mcpEnabled,
          host: draft.mcpHost.trim() || '127.0.0.1',
          port: clampInt(draft.mcpPort, 1, 65535),
          transport: draft.mcpTransport,
          text_excerpt_chars: clampInt(draft.mcpTextExcerptChars, 0),
        },
        ...draft.extraExportPlugins,
      ],
    },
    system: {
      background_model_jobs: draft.backgroundModelJobs,
      load_guard: {
        enabled: draft.loadGuardEnabled,
        threshold: clampNumber(draft.loadGuardThreshold, 0.01, 8),
        memory_threshold: clampNumber(draft.loadGuardMemoryThreshold, 0.01, 1),
        low_battery_threshold_pct: clampInt(
          draft.loadGuardLowBatteryThresholdPct,
          0,
          100,
        ),
        max_consecutive_skips: clampInt(draft.loadGuardMaxConsecutiveSkips, 0),
      },
    },
  };
}

function lines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function integerList(s: string): number[] {
  return s
    .split(/[,\s]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0);
}

function optionalString(s: string): string | undefined {
  const value = s.trim();
  return value ? value : undefined;
}

function optionalInt(s: string, min: number, max?: number): number | undefined {
  const value = s.trim();
  if (!value) return undefined;
  return clampInt(Number(value), min, max);
}

function clampInt(value: number, min: number, max?: number): number {
  return Math.round(clampNumber(value, min, max));
}

function clampNumber(value: number, min: number, max?: number): number {
  const finite = Number.isFinite(value) ? value : min;
  const lower = Math.max(finite, min);
  return max == null ? lower : Math.min(lower, max);
}

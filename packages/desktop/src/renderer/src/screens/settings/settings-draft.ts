import type { LoadedConfig } from '@/global';

export type BackgroundModelJobs = 'manual' | 'scheduled';
export type CaptureMode = 'active' | 'all';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ScreenshotFormat = 'webp' | 'jpeg';
export type SystemAudioBackend = 'core_audio_tap' | 'screencapturekit' | 'off';
export type LiveRecordingFormat = 'm4a';
export type McpTransport = 'http' | 'stdio';

export interface SettingsDraft {
  appName: string; appDataDir: string; logLevel: LogLevel; sessionId: string; capturePlugin: string;
  pollIntervalMs: number; idlePollIntervalMs: number; focusSettleDelayMs: number; screenshotDiffThreshold: number;
  idleThresholdSec: number; screenshotFormat: ScreenshotFormat; screenshotQuality: number; jpegQuality: string;
  screenshotMaxDim: number; contentChangeMinIntervalMs: number; multiScreen: boolean; screens: string;
  captureMode: CaptureMode; blurPasswordFields: boolean; pauseOnScreenLock: boolean; sensitiveKeywords: string;
  excludedApps: string; excludedUrlPatterns: string; accessibilityEnabled: boolean; accessibilityTimeoutMs: number;
  accessibilityMaxChars: number; accessibilityMaxElements: number; accessibilityExcludedApps: string; storagePlugin: string;
  storagePath: string; maxSizeGb: number; retentionDays: number; compressAfterDays: number; compressAfterMinutes: string;
  compressQuality: number; thumbnailAfterDays: number; thumbnailAfterMinutes: string; thumbnailMaxDim: number;
  deleteAfterDays: number; deleteAfterMinutes: string; vacuumTickIntervalMin: number; vacuumBatchSize: number;
  indexStrategy: string; indexPath: string; incrementalIntervalMin: number; reorganiseSchedule: string; reorganiseOnIdle: boolean;
  indexIdleTriggerMin: number; indexBatchSize: number; sessionsIdleThresholdSec: number; sessionsAfkThresholdSec: number;
  sessionsMinActiveMs: number; sessionsFallbackFrameAttentionMs: number; meetingsIdleThresholdSec: number; meetingsMinDurationSec: number;
  meetingsAudioGraceSec: number; meetingsSummarize: boolean; meetingsSummarizeCooldownSec: number; meetingsVisionAttachments: number;
  embeddingsEnabled: boolean; embeddingsBatchSize: number; embeddingsTickIntervalMin: number; embeddingsSearchWeight: number;
  modelPlugin: string; ollamaHost: string; ollamaAutoInstall: boolean; ollamaEmbeddingModel: string; ollamaVisionModel: string;
  ollamaIndexerModel: string; ollamaKeepAlive: string; ollamaUnloadAfterIdleMin: number; ollamaModelRevision: number;
  openaiApiKey: string; openaiBaseUrl: string; openaiModel: string; openaiVisionModel: string; openaiEmbeddingModel: string;
  claudeApiKey: string; claudeModel: string; markdownEnabled: boolean; markdownPath: string; mcpEnabled: boolean;
  mcpHost: string; mcpPort: number; mcpTransport: McpTransport; mcpTextExcerptChars: number; extraExportPlugins: any[];
  captureAudio: boolean; whisperModel: string; audioInboxPath: string; audioProcessedPath: string; audioFailedPath: string;
  audioTickIntervalSec: number; audioBatchSize: number; whisperCommand: string; whisperLanguage: string; maxAudioBytes: number;
  minAudioBytesPerSec: number; minAudioRateCheckMs: number; liveRecordingEnabled: boolean; liveRecordingFormat: LiveRecordingFormat;
  liveRecordingSampleRate: number; liveRecordingChannels: number; liveRecordingPollIntervalSec: number; systemAudioBackend: SystemAudioBackend;
  chunkSeconds: number; deleteAudioAfterTranscribe: boolean; backgroundModelJobs: BackgroundModelJobs; loadGuardEnabled: boolean;
  loadGuardThreshold: number; loadGuardMemoryThreshold: number; loadGuardLowBatteryThresholdPct: number; loadGuardMaxConsecutiveSkips: number;
}

export function settingsDraftFromConfig(loaded: LoadedConfig): SettingsDraft {
  const c = loaded.config, md = c.export.plugins.find(p => p.name === 'markdown'), mcp = c.export.plugins.find(p => p.name === 'mcp');
  const v = c.storage.local.vacuum, a = c.capture.audio, lr = a?.live_recording, ax = c.capture.accessibility;
  const ol = c.index.model.ollama, oa = c.index.model.openai, cl = c.index.model.claude;

  return {
    appName: c.app.name, appDataDir: c.app.data_dir, logLevel: c.app.log_level, sessionId: c.app.session_id ?? '',
    capturePlugin: c.capture.plugin, pollIntervalMs: c.capture.poll_interval_ms, idlePollIntervalMs: c.capture.idle_poll_interval_ms,
    focusSettleDelayMs: c.capture.focus_settle_delay_ms, screenshotDiffThreshold: c.capture.screenshot_diff_threshold,
    idleThresholdSec: c.capture.idle_threshold_sec, screenshotFormat: c.capture.screenshot_format,
    screenshotQuality: c.capture.screenshot_quality, jpegQuality: c.capture.jpeg_quality == null ? '' : String(c.capture.jpeg_quality),
    screenshotMaxDim: c.capture.screenshot_max_dim, contentChangeMinIntervalMs: c.capture.content_change_min_interval_ms,
    multiScreen: c.capture.multi_screen ?? false, screens: Array.isArray(c.capture.screens) ? c.capture.screens.join(', ') : '',
    captureMode: c.capture.capture_mode ?? 'active', blurPasswordFields: c.capture.privacy.blur_password_fields,
    pauseOnScreenLock: c.capture.privacy.pause_on_screen_lock, sensitiveKeywords: c.capture.privacy.sensitive_keywords.join('\n'),
    excludedApps: c.capture.excluded_apps.join('\n'), excludedUrlPatterns: c.capture.excluded_url_patterns.join('\n'),
    accessibilityEnabled: ax?.enabled ?? true, accessibilityTimeoutMs: ax?.timeout_ms ?? 1500, accessibilityMaxChars: ax?.max_chars ?? 8000,
    accessibilityMaxElements: ax?.max_elements ?? 4000, accessibilityExcludedApps: (ax?.excluded_apps ?? []).join('\n'),
    storagePlugin: c.storage.plugin, storagePath: c.storage.local.path, maxSizeGb: c.storage.local.max_size_gb, retentionDays: c.storage.local.retention_days,
    compressAfterDays: v.compress_after_days, compressAfterMinutes: v.compress_after_minutes == null ? '' : String(v.compress_after_minutes),
    compressQuality: v.compress_quality, thumbnailAfterDays: v.thumbnail_after_days, thumbnailAfterMinutes: v.thumbnail_after_minutes == null ? '' : String(v.thumbnail_after_minutes),
    thumbnailMaxDim: v.thumbnail_max_dim, deleteAfterDays: v.delete_after_days, deleteAfterMinutes: v.delete_after_minutes == null ? '' : String(v.delete_after_minutes),
    vacuumTickIntervalMin: v.tick_interval_min, vacuumBatchSize: v.batch_size, indexStrategy: c.index.strategy, indexPath: c.index.index_path,
    incrementalIntervalMin: c.index.incremental_interval_min, reorganiseSchedule: c.index.reorganise_schedule, reorganiseOnIdle: c.index.reorganise_on_idle,
    indexIdleTriggerMin: c.index.idle_trigger_min, indexBatchSize: c.index.batch_size, sessionsIdleThresholdSec: c.index.sessions.idle_threshold_sec,
    sessionsAfkThresholdSec: c.index.sessions.afk_threshold_sec, sessionsMinActiveMs: c.index.sessions.min_active_ms,
    sessionsFallbackFrameAttentionMs: c.index.sessions.fallback_frame_attention_ms, meetingsIdleThresholdSec: c.index.meetings.idle_threshold_sec,
    meetingsMinDurationSec: c.index.meetings.min_duration_sec, meetingsAudioGraceSec: c.index.meetings.audio_grace_sec,
    meetingsSummarize: c.index.meetings.summarize, meetingsSummarizeCooldownSec: c.index.meetings.summarize_cooldown_sec,
    meetingsVisionAttachments: c.index.meetings.vision_attachments, embeddingsEnabled: c.index.embeddings.enabled,
    embeddingsBatchSize: c.index.embeddings.batch_size, embeddingsTickIntervalMin: c.index.embeddings.tick_interval_min,
    embeddingsSearchWeight: c.index.embeddings.search_weight, modelPlugin: c.index.model.plugin, ollamaHost: ol?.host ?? 'http://127.0.0.1:11434',
    ollamaAutoInstall: ol?.auto_install ?? true, ollamaEmbeddingModel: ol?.embedding_model ?? 'nomic-embed-text',
    ollamaVisionModel: ol?.vision_model ?? '', ollamaIndexerModel: ol?.indexer_model ?? '', ollamaKeepAlive: String(ol?.keep_alive ?? '30s'),
    ollamaUnloadAfterIdleMin: ol?.unload_after_idle_min ?? 0, ollamaModelRevision: ol?.model_revision ?? 0, openaiApiKey: oa?.api_key ?? '',
    openaiBaseUrl: oa?.base_url ?? 'https://api.openai.com/v1', openaiModel: oa?.model ?? 'gpt-4o-mini', openaiVisionModel: oa?.vision_model ?? '',
    openaiEmbeddingModel: oa?.embedding_model ?? 'text-embedding-3-small', claudeApiKey: cl?.api_key ?? '', claudeModel: cl?.model ?? 'claude-sonnet-4-6',
    markdownEnabled: md?.enabled ?? true, markdownPath: typeof md?.path === 'string' ? md.path : '', mcpEnabled: mcp?.enabled ?? true,
    mcpHost: typeof mcp?.host === 'string' ? mcp.host : '127.0.0.1', mcpPort: typeof mcp?.port === 'number' ? mcp.port : 3456,
    mcpTransport: mcp?.transport === 'stdio' ? 'stdio' : 'http', mcpTextExcerptChars: typeof mcp?.text_excerpt_chars === 'number' ? mcp.text_excerpt_chars : 5000,
    extraExportPlugins: c.export.plugins.filter(p => !['markdown', 'mcp'].includes(p.name)), captureAudio: c.capture.capture_audio ?? true,
    whisperModel: c.capture.whisper_model ?? 'base', audioInboxPath: a?.inbox_path ?? '~/.cofounderOS/raw/audio/inbox',
    audioProcessedPath: a?.processed_path ?? '~/.cofounderOS/raw/audio/processed', audioFailedPath: a?.failed_path ?? '~/.cofounderOS/raw/audio/failed',
    audioTickIntervalSec: a?.tick_interval_sec ?? 60, audioBatchSize: a?.batch_size ?? 5, whisperCommand: a?.whisper_command ?? 'whisper',
    whisperLanguage: a?.whisper_language ?? '', maxAudioBytes: a?.max_audio_bytes ?? 500 * 1024 * 1024, minAudioBytesPerSec: a?.min_audio_bytes_per_sec ?? 4096,
    minAudioRateCheckMs: a?.min_audio_rate_check_ms ?? 5000, liveRecordingEnabled: lr?.enabled ?? false, liveRecordingFormat: lr?.format ?? 'm4a',
    liveRecordingSampleRate: lr?.sample_rate ?? 16000, liveRecordingChannels: lr?.channels ?? 1, liveRecordingPollIntervalSec: lr?.poll_interval_sec ?? 3,
    systemAudioBackend: lr?.system_audio_backend ?? 'core_audio_tap', chunkSeconds: lr?.chunk_seconds ?? 300, deleteAudioAfterTranscribe: a?.delete_audio_after_transcribe ?? true,
    backgroundModelJobs: c.system.background_model_jobs, loadGuardEnabled: c.system.load_guard.enabled, loadGuardThreshold: c.system.load_guard.threshold,
    loadGuardMemoryThreshold: c.system.load_guard.memory_threshold, loadGuardLowBatteryThresholdPct: c.system.load_guard.low_battery_threshold_pct,
    loadGuardMaxConsecutiveSkips: c.system.load_guard.max_consecutive_skips
  };
}

export function configPatchFromDraft(d: SettingsDraft) {
  const scr = integerList(d.screens);
  return {
    app: { name: d.appName.trim() || 'CofounderOS', data_dir: d.appDataDir.trim() || '~/.cofounderOS', log_level: d.logLevel, session_id: optionalString(d.sessionId) },
    capture: {
      plugin: d.captureAudio && d.liveRecordingEnabled ? 'native' : d.capturePlugin.trim() || 'node', poll_interval_ms: clampInt(d.pollIntervalMs, 1),
      idle_poll_interval_ms: clampInt(d.idlePollIntervalMs, 1), focus_settle_delay_ms: clampInt(d.focusSettleDelayMs, 0), screenshot_diff_threshold: clampNumber(d.screenshotDiffThreshold, 0, 1),
      idle_threshold_sec: clampInt(d.idleThresholdSec, 1), screenshot_format: d.screenshotFormat, screenshot_quality: clampInt(d.screenshotQuality, 1, 100),
      jpeg_quality: optionalInt(d.jpegQuality, 1, 100), screenshot_max_dim: clampInt(d.screenshotMaxDim, 0, 8192), content_change_min_interval_ms: clampInt(d.contentChangeMinIntervalMs, 0),
      multi_screen: d.multiScreen, screens: scr.length ? scr : null, capture_mode: d.captureMode, excluded_apps: lines(d.excludedApps), excluded_url_patterns: lines(d.excludedUrlPatterns),
      accessibility: { enabled: d.accessibilityEnabled, timeout_ms: clampInt(d.accessibilityTimeoutMs, 1), max_chars: clampInt(d.accessibilityMaxChars, 1), max_elements: clampInt(d.accessibilityMaxElements, 1), excluded_apps: lines(d.accessibilityExcludedApps) },
      privacy: { blur_password_fields: d.blurPasswordFields, pause_on_screen_lock: d.pauseOnScreenLock, sensitive_keywords: lines(d.sensitiveKeywords) },
      capture_audio: d.captureAudio, whisper_model: d.whisperModel.trim() || 'base',
      audio: {
        inbox_path: d.audioInboxPath.trim() || '~/.cofounderOS/raw/audio/inbox', processed_path: d.audioProcessedPath.trim() || '~/.cofounderOS/raw/audio/processed',
        failed_path: d.audioFailedPath.trim() || '~/.cofounderOS/raw/audio/failed', tick_interval_sec: clampInt(d.audioTickIntervalSec, 1), batch_size: clampInt(d.audioBatchSize, 1),
        whisper_command: d.whisperCommand.trim() || 'whisper', whisper_language: optionalString(d.whisperLanguage), delete_audio_after_transcribe: d.deleteAudioAfterTranscribe,
        max_audio_bytes: clampInt(d.maxAudioBytes, 0), min_audio_bytes_per_sec: clampInt(d.minAudioBytesPerSec, 0), min_audio_rate_check_ms: clampInt(d.minAudioRateCheckMs, 0),
        live_recording: { enabled: d.liveRecordingEnabled, activation: 'other_process_input', system_audio_backend: d.systemAudioBackend, poll_interval_sec: clampInt(d.liveRecordingPollIntervalSec, 1), chunk_seconds: clampInt(d.chunkSeconds, 1), format: d.liveRecordingFormat, sample_rate: clampInt(d.liveRecordingSampleRate, 1), channels: clampInt(d.liveRecordingChannels, 1, 2) }
      }
    },
    storage: {
      plugin: d.storagePlugin.trim() || 'local',
      local: {
        path: d.storagePath.trim() || '~/.cofounderOS', max_size_gb: clampNumber(d.maxSizeGb, 0.1), retention_days: clampInt(d.retentionDays, 0),
        vacuum: { compress_after_days: clampInt(d.compressAfterDays, 0), compress_after_minutes: optionalInt(d.compressAfterMinutes, 0), compress_quality: clampInt(d.compressQuality, 1, 100), thumbnail_after_days: clampInt(d.thumbnailAfterDays, 0), thumbnail_after_minutes: optionalInt(d.thumbnailAfterMinutes, 0), thumbnail_max_dim: clampInt(d.thumbnailMaxDim, 64, 2048), delete_after_days: clampInt(d.deleteAfterDays, 0), delete_after_minutes: optionalInt(d.deleteAfterMinutes, 0), tick_interval_min: clampInt(d.vacuumTickIntervalMin, 1), batch_size: clampInt(d.vacuumBatchSize, 1) }
      }
    },
    index: {
      strategy: d.indexStrategy.trim() || 'karpathy', index_path: d.indexPath.trim() || '~/.cofounderOS/index', incremental_interval_min: clampInt(d.incrementalIntervalMin, 1),
      reorganise_schedule: d.reorganiseSchedule.trim() || '0 2 * * *', reorganise_on_idle: d.reorganiseOnIdle, index_idle_trigger_min: clampInt(d.indexIdleTriggerMin, 1), batch_size: clampInt(d.indexBatchSize, 1),
      sessions: { idle_threshold_sec: clampInt(d.sessionsIdleThresholdSec, 1), afk_threshold_sec: clampInt(d.sessionsAfkThresholdSec, 1), min_active_ms: clampInt(d.sessionsMinActiveMs, 0), fallback_frame_attention_ms: clampInt(d.sessionsFallbackFrameAttentionMs, 1) },
      meetings: { idle_threshold_sec: clampInt(d.meetingsIdleThresholdSec, 1), min_duration_sec: clampInt(d.meetingsMinDurationSec, 0), audio_grace_sec: clampInt(d.meetingsAudioGraceSec, 0), summarize: d.meetingsSummarize, summarize_cooldown_sec: clampInt(d.meetingsSummarizeCooldownSec, 0), vision_attachments: clampInt(d.meetingsVisionAttachments, 0) },
      embeddings: { enabled: d.embeddingsEnabled, batch_size: clampInt(d.embeddingsBatchSize, 1), tick_interval_min: clampInt(d.embeddingsTickIntervalMin, 1), search_weight: clampNumber(d.embeddingsSearchWeight, 0.01) },
      model: {
        plugin: d.modelPlugin.trim() || 'ollama',
        ollama: { host: d.ollamaHost.trim(), auto_install: d.ollamaAutoInstall, embedding_model: d.ollamaEmbeddingModel.trim() || 'nomic-embed-text', vision_model: optionalString(d.ollamaVisionModel), indexer_model: optionalString(d.ollamaIndexerModel), keep_alive: d.ollamaKeepAlive.trim() || '30s', unload_after_idle_min: clampNumber(d.ollamaUnloadAfterIdleMin, 0), model_revision: clampInt(d.ollamaModelRevision, 0) },
        openai: { api_key: optionalString(d.openaiApiKey), base_url: d.openaiBaseUrl.trim() || 'https://api.openai.com/v1', model: d.openaiModel.trim() || 'gpt-4o-mini', vision_model: optionalString(d.openaiVisionModel), embedding_model: d.openaiEmbeddingModel.trim() || 'text-embedding-3-small' },
        claude: { api_key: optionalString(d.claudeApiKey), model: d.claudeModel.trim() || 'claude-sonnet-4-6' }
      }
    },
    export: { plugins: [{ name: 'markdown', enabled: d.markdownEnabled, path: d.markdownPath.trim() }, { name: 'mcp', enabled: d.mcpEnabled, host: d.mcpHost.trim() || '127.0.0.1', port: clampInt(d.mcpPort, 1, 65535), transport: d.mcpTransport, text_excerpt_chars: clampInt(d.mcpTextExcerptChars, 0) }, ...d.extraExportPlugins] },
    system: { background_model_jobs: d.backgroundModelJobs, load_guard: { enabled: d.loadGuardEnabled, threshold: clampNumber(d.loadGuardThreshold, 0.01, 8), memory_threshold: clampNumber(d.loadGuardMemoryThreshold, 0.01, 1), low_battery_threshold_pct: clampInt(d.loadGuardLowBatteryThresholdPct, 0, 100), max_consecutive_skips: clampInt(d.loadGuardMaxConsecutiveSkips, 0) } }
  };
}

function lines(s: string) { return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean); }
function integerList(s: string) { return s.split(/[,\s]+/).map(v => Number(v.trim())).filter(v => Number.isInteger(v) && v >= 0); }
function optionalString(s: string) { const v = s.trim(); return v || undefined; }
function optionalInt(s: string, min: number, max?: number) { const v = s.trim(); return v ? clampInt(Number(v), min, max) : undefined; }
function clampInt(v: number, min: number, max?: number) { return Math.round(clampNumber(v, min, max)); }
function clampNumber(v: number, min: number, max?: number) { const f = Number.isFinite(v) ? v : min, l = Math.max(f, min); return max == null ? l : Math.min(l, max); }

import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { defaultDataDir, expandPath } from './paths.js';

const PluginRefSchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional().default(true),
}).passthrough();

const AppSchema = z.object({
  name: z.string().default('CofounderOS'),
  data_dir: z.string().default('~/.cofounderOS'),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  session_id: z.string().optional(),
});

const CaptureSchema = z.object({
  plugin: z.string().default('node'),
  poll_interval_ms: z.number().int().positive().default(3000),
  idle_poll_interval_ms: z.number().int().positive().default(30_000),
  focus_settle_delay_ms: z.number().int().nonnegative().default(900),
  screenshot_diff_threshold: z.number().min(0).max(1).default(0.15),
  idle_threshold_sec: z.number().int().positive().default(60),
  capture_audio: z.boolean().default(true),
  whisper_model: z.string().default('base'),
  audio: z.object({
    inbox_path: z.string().default('~/.cofounderOS/raw/audio/inbox'),
    processed_path: z.string().default('~/.cofounderOS/raw/audio/processed'),
    failed_path: z.string().default('~/.cofounderOS/raw/audio/failed'),
    tick_interval_sec: z.number().int().positive().default(60),
    batch_size: z.number().int().positive().default(5),
    whisper_command: z.string().default('whisper'),
    whisper_language: z.string().optional(),
    delete_audio_after_transcribe: z.boolean().default(true),
    max_audio_bytes: z.number().int().nonnegative().default(500 * 1024 * 1024),
    min_audio_bytes_per_sec: z.number().int().nonnegative().default(4096),
    min_audio_rate_check_ms: z.number().int().nonnegative().default(5000),
    live_recording: z.object({
      enabled: z.boolean().default(true),
      chunk_seconds: z.number().int().positive().default(300),
      format: z.enum(['m4a']).default('m4a'),
      sample_rate: z.number().int().positive().default(16_000),
      channels: z.number().int().positive().max(2).default(1),
      activation: z.enum(['other_process_input', 'always']).default('other_process_input'),
      system_audio_backend: z.enum(['core_audio_tap', 'screencapturekit', 'off']).default('core_audio_tap'),
      poll_interval_sec: z.number().int().positive().default(3),
    }).default({ enabled: true, chunk_seconds: 300, format: 'm4a', sample_rate: 16_000, channels: 1, activation: 'other_process_input', system_audio_backend: 'core_audio_tap', poll_interval_sec: 3 }),
  }).default({ inbox_path: '~/.cofounderOS/raw/audio/inbox', processed_path: '~/.cofounderOS/raw/audio/processed', failed_path: '~/.cofounderOS/raw/audio/failed', tick_interval_sec: 60, batch_size: 5, whisper_command: 'whisper', delete_audio_after_transcribe: true, max_audio_bytes: 500 * 1024 * 1024, min_audio_bytes_per_sec: 4096, min_audio_rate_check_ms: 5000, live_recording: { enabled: true, chunk_seconds: 300, format: 'm4a', sample_rate: 16_000, channels: 1, activation: 'other_process_input', system_audio_backend: 'core_audio_tap', poll_interval_sec: 3 } }),
  screenshot_format: z.enum(['webp', 'jpeg']).default('webp'),
  screenshot_quality: z.number().int().min(1).max(100).default(45),
  screenshot_max_dim: z.number().int().nonnegative().max(8192).default(1100),
  content_change_min_interval_ms: z.number().int().nonnegative().default(60_000),
  jpeg_quality: z.number().int().min(1).max(100).optional(),
  excluded_apps: z.array(z.string()).default(['1Password', 'Bitwarden', 'Keychain Access']),
  excluded_url_patterns: z.array(z.string()).default([]),
  accessibility: z.object({
    enabled: z.boolean().default(true),
    timeout_ms: z.number().int().positive().default(1500),
    max_chars: z.number().int().positive().default(8000),
    max_elements: z.number().int().positive().default(4000),
    excluded_apps: z.array(z.string()).default([]),
  }).default({ enabled: true, timeout_ms: 1500, max_chars: 8000, max_elements: 4000, excluded_apps: [] }),
  privacy: z.object({
    blur_password_fields: z.boolean().default(true),
    pause_on_screen_lock: z.boolean().default(true),
    sensitive_keywords: z.array(z.string()).default(['password', 'api_key', 'secret']),
  }).default({ blur_password_fields: true, pause_on_screen_lock: true, sensitive_keywords: ['password', 'api_key', 'secret'] }),
}).passthrough();

const StorageSchema = z.object({
  plugin: z.string().default('local'),
  local: z.object({
    path: z.string().default('~/.cofounderOS'),
    max_size_gb: z.number().positive().default(50),
    retention_days: z.number().int().nonnegative().default(365),
    vacuum: z.object({
      compress_after_days: z.number().int().nonnegative().default(1),
      compress_after_minutes: z.number().int().nonnegative().optional(),
      compress_quality: z.number().int().min(1).max(100).default(40),
      thumbnail_after_days: z.number().int().nonnegative().default(30),
      thumbnail_after_minutes: z.number().int().nonnegative().optional(),
      thumbnail_max_dim: z.number().int().min(64).max(2048).default(480),
      delete_after_days: z.number().int().nonnegative().default(180),
      delete_after_minutes: z.number().int().nonnegative().optional(),
      tick_interval_min: z.number().int().positive().default(15),
      batch_size: z.number().int().positive().default(50),
    }).default({ compress_after_days: 0, compress_after_minutes: 60, compress_quality: 40, thumbnail_after_days: 30, thumbnail_max_dim: 480, delete_after_days: 180, tick_interval_min: 15, batch_size: 50 }),
  }).default({ path: '~/.cofounderOS', max_size_gb: 50, retention_days: 365, vacuum: { compress_after_days: 0, compress_after_minutes: 60, compress_quality: 40, thumbnail_after_days: 30, thumbnail_max_dim: 480, delete_after_days: 180, tick_interval_min: 15, batch_size: 50 } }),
}).passthrough();

const IndexSchema = z.object({
  strategy: z.string().default('karpathy'),
  index_path: z.string().default('~/.cofounderOS/index'),
  incremental_interval_min: z.number().int().positive().default(30),
  reorganise_schedule: z.string().default('0 2 * * *'),
  reorganise_on_idle: z.boolean().default(true),
  idle_trigger_min: z.number().int().positive().default(10),
  batch_size: z.number().int().positive().default(50),
  sessions: z.object({
    idle_threshold_sec: z.number().int().positive().default(300),
    afk_threshold_sec: z.number().int().positive().default(120),
    min_active_ms: z.number().int().nonnegative().default(30_000),
    fallback_frame_attention_ms: z.number().int().positive().default(5_000),
  }).default({ idle_threshold_sec: 300, afk_threshold_sec: 120, min_active_ms: 30_000, fallback_frame_attention_ms: 5_000 }),
  meetings: z.object({
    idle_threshold_sec: z.number().int().positive().default(300),
    min_duration_sec: z.number().int().nonnegative().default(180),
    audio_grace_sec: z.number().int().nonnegative().default(60),
    summarize: z.boolean().default(true),
    summarize_cooldown_sec: z.number().int().nonnegative().default(300),
    vision_attachments: z.number().int().nonnegative().default(4),
  }).default({ idle_threshold_sec: 300, min_duration_sec: 180, audio_grace_sec: 60, summarize: true, summarize_cooldown_sec: 300, vision_attachments: 4 }),
  events: z.object({
    llm_enabled: z.boolean().default(true),
    lookback_days: z.number().int().positive().default(7),
    min_text_chars: z.number().int().nonnegative().default(80),
    max_frames_per_bucket: z.number().int().positive().default(30),
  }).default({ llm_enabled: true, lookback_days: 7, min_text_chars: 80, max_frames_per_bucket: 30 }),
  embeddings: z.object({
    enabled: z.boolean().default(true),
    batch_size: z.number().int().positive().default(32),
    tick_interval_min: z.number().int().positive().default(5),
    search_weight: z.number().positive().default(0.35),
  }).default({ enabled: true, batch_size: 32, tick_interval_min: 5, search_weight: 0.35 }),
  model: z.object({
    plugin: z.string().default('ollama'),
    ollama: z.object({
      model: z.string().default('gemma4:e4b'),
      embedding_model: z.string().default('nomic-embed-text'),
      host: z.string().default('http://127.0.0.1:11434'),
      vision_model: z.string().optional(),
      indexer_model: z.string().optional(),
      keep_alive: z.union([z.string(), z.number()]).default('30s'),
      unload_after_idle_min: z.number().nonnegative().default(0),
      auto_install: z.boolean().default(true),
      model_revision: z.number().int().nonnegative().default(3),
    }).default({ model: 'gemma4:e4b', embedding_model: 'nomic-embed-text', host: 'http://127.0.0.1:11434', keep_alive: '30s', unload_after_idle_min: 0, auto_install: true, model_revision: 3 }),
    claude: z.object({ api_key: z.string().optional(), model: z.string().default('claude-sonnet-4-6') }).optional(),
    openai: z.object({ api_key: z.string().optional(), base_url: z.string().default('https://api.openai.com/v1'), model: z.string().default('gpt-4o-mini'), vision_model: z.string().optional(), embedding_model: z.string().default('text-embedding-3-small') }).optional(),
  }).default({ plugin: 'ollama', ollama: { model: 'gemma4:e4b', embedding_model: 'nomic-embed-text', host: 'http://127.0.0.1:11434' } }),
}).passthrough();

const SystemSchema = z.object({
  background_model_jobs: z.enum(['manual', 'scheduled']).default('manual'),
  load_guard: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().positive().max(8).default(0.7),
    memory_threshold: z.number().positive().max(1).default(0.9),
    low_battery_threshold_pct: z.number().int().min(0).max(100).default(25),
    max_consecutive_skips: z.number().int().nonnegative().default(0),
  }).default({ enabled: true, threshold: 0.7, memory_threshold: 0.9, low_battery_threshold_pct: 25, max_consecutive_skips: 0 }),
}).default({ background_model_jobs: 'manual', load_guard: { enabled: true, threshold: 0.7, memory_threshold: 0.9, low_battery_threshold_pct: 25, max_consecutive_skips: 0 } });

const ExportPluginSchema = z.object({ name: z.string(), enabled: z.boolean().optional().default(true) }).passthrough();

const ExportSchema = z.object({
  plugins: z.array(ExportPluginSchema).default([{ name: 'markdown', enabled: true }, { name: 'mcp', enabled: true }]),
}).passthrough();

export const ConfigSchema = z.object({
  app: AppSchema.default({}),
  capture: CaptureSchema.default({}),
  storage: StorageSchema.default({}),
  index: IndexSchema.default({}),
  export: ExportSchema.default({}),
  system: SystemSchema,
});

export type CofounderOSConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_FILENAME = 'config.yaml';

export const DEFAULT_CONFIG_YAML = `app:
  name: CofounderOS
  data_dir: ~/.cofounderOS
  log_level: info

capture:
  plugin: node
  poll_interval_ms: 3000
  idle_poll_interval_ms: 30000
  focus_settle_delay_ms: 900
  screenshot_diff_threshold: 0.15
  idle_threshold_sec: 60
  screenshot_format: webp
  screenshot_quality: 45
  screenshot_max_dim: 1100
  content_change_min_interval_ms: 60000
  capture_audio: true
  whisper_model: base
  audio:
    inbox_path: ~/.cofounderOS/raw/audio/inbox
    processed_path: ~/.cofounderOS/raw/audio/processed
    failed_path: ~/.cofounderOS/raw/audio/failed
    tick_interval_sec: 60
    batch_size: 5
    whisper_command: whisper
    delete_audio_after_transcribe: true
    max_audio_bytes: 524288000
    min_audio_bytes_per_sec: 4096
    min_audio_rate_check_ms: 5000
    live_recording:
      enabled: true
      activation: other_process_input
      system_audio_backend: core_audio_tap
      poll_interval_sec: 3
      chunk_seconds: 300
      format: m4a
      sample_rate: 16000
      channels: 1
  excluded_apps:
    - 1Password
    - Bitwarden
    - Keychain Access
  excluded_url_patterns: []
  multi_screen: false
  capture_mode: active
  accessibility:
    enabled: true
    timeout_ms: 1500
    max_chars: 8000
  privacy:
    blur_password_fields: true
    pause_on_screen_lock: true
    sensitive_keywords:
      - password
      - api_key
      - secret

storage:
  plugin: local
  local:
    path: ~/.cofounderOS
    max_size_gb: 50
    retention_days: 365
    vacuum:
      compress_after_minutes: 60
      compress_quality: 40
      thumbnail_after_days: 30
      thumbnail_max_dim: 480
      delete_after_days: 180
      tick_interval_min: 15
      batch_size: 50

index:
  strategy: karpathy
  index_path: ~/.cofounderOS/index
  incremental_interval_min: 30
  reorganise_schedule: "0 2 * * *"
  reorganise_on_idle: true
  idle_trigger_min: 10
  batch_size: 50
  sessions:
    idle_threshold_sec: 300
    afk_threshold_sec: 120
    min_active_ms: 30000
  meetings:
    idle_threshold_sec: 300
    min_duration_sec: 180
    audio_grace_sec: 60
    summarize: true
    summarize_cooldown_sec: 300
    vision_attachments: 4
  embeddings:
    enabled: true
    batch_size: 32
    tick_interval_min: 5
    search_weight: 0.35
  model:
    plugin: ollama
    ollama:
      model: gemma4:e4b
      embedding_model: nomic-embed-text
      host: http://127.0.0.1:11434
      keep_alive: 30s
      unload_after_idle_min: 0
      auto_install: true
      model_revision: 3

system:
  background_model_jobs: manual
  load_guard:
    enabled: true
    threshold: 0.7
    memory_threshold: 0.9
    low_battery_threshold_pct: 25
    max_consecutive_skips: 0

export:
  plugins:
    - name: markdown
      path: ~/.cofounderOS/export/markdown
    - name: mcp
      port: 3456
      host: 127.0.0.1
      text_excerpt_chars: 5000
`;

export interface LoadedConfig {
  config: CofounderOSConfig;
  dataDir: string;
  sourcePath: string;
}

export async function loadConfig(configPath?: string): Promise<LoadedConfig> {
  const resolved = await resolveConfigPath(configPath);
  let raw: unknown = {}, sourcePath = resolved;

  try {
    raw = YAML.parse(await fs.readFile(resolved, 'utf8')) ?? {};
  } catch (err: any) {
    if (err.code === 'ENOENT') { raw = {}; sourcePath = '<defaults>'; } else throw err;
  }

  const config = ConfigSchema.parse(raw);
  rerootStockPaths(config);
  return { config, dataDir: expandPath(config.app.data_dir), sourcePath };
}

export function validateConfig(raw: unknown) {
  const parsed = ConfigSchema.safeParse(raw);
  if (parsed.success) return { ok: true as const, config: parsed.data };
  return { ok: false as const, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
}

export async function writeConfig(config: CofounderOSConfig, configPath?: string): Promise<{ path: string }> {
  const target = await resolveConfigPath(configPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, YAML.stringify(ConfigSchema.parse(config)), 'utf8');
  return { path: target };
}

function rerootStockPaths(config: CofounderOSConfig): void {
  const envRoot = process.env.COFOUNDEROS_DATA_DIR;
  if (!envRoot || envRoot.trim().length === 0) return;
  const STOCK = '~/.cofounderOS';

  const swap = (val: string): string => val === STOCK ? envRoot : val.startsWith(`${STOCK}/`) ? `${envRoot}/${val.slice(STOCK.length + 1)}` : val;

  config.app.data_dir = swap(config.app.data_dir);
  const storageBlock = (config.storage as any)[config.storage.plugin];
  if (storageBlock && typeof storageBlock.path === 'string') storageBlock.path = swap(storageBlock.path);
  if (typeof config.index.index_path === 'string') config.index.index_path = swap(config.index.index_path);
  for (const plugin of config.export.plugins) {
    for (const [k, v] of Object.entries(plugin)) if (typeof v === 'string') (plugin as any)[k] = swap(v);
  }
}

async function resolveConfigPath(explicit?: string): Promise<string> {
  return expandPath(explicit || process.env.COFOUNDEROS_CONFIG || path.join(defaultDataDir(), DEFAULT_CONFIG_FILENAME));
}

export async function writeDefaultConfigIfMissing(dataDir: string = defaultDataDir()): Promise<{ created: boolean; path: string }> {
  const target = path.join(dataDir, DEFAULT_CONFIG_FILENAME);
  await fs.mkdir(dataDir, { recursive: true });
  try { await fs.access(target); return { created: false, path: target }; }
  catch { await fs.writeFile(target, DEFAULT_CONFIG_YAML, 'utf8'); return { created: true, path: target }; }
}

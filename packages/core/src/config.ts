import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { defaultDataDir, expandPath } from './paths.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

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
  poll_interval_ms: z.number().int().positive().default(1500),
  // Soft-trigger sensitivity. Bumped from 0.05 → 0.10 because at the
  // old threshold even pixel-level noise (e.g. blinking cursor, clock
  // ticking) triggered captures. 0.10 is still well below "human
  // notices a difference".
  screenshot_diff_threshold: z.number().min(0).max(1).default(0.1),
  idle_threshold_sec: z.number().int().positive().default(60),
  capture_audio: z.boolean().default(false),
  whisper_model: z.string().default('tiny'),
  audio: z.object({
    inbox_path: z.string().default('~/.cofounderOS/raw/audio/inbox'),
    processed_path: z.string().default('~/.cofounderOS/raw/audio/processed'),
    failed_path: z.string().default('~/.cofounderOS/raw/audio/failed'),
    tick_interval_sec: z.number().int().positive().default(60),
    batch_size: z.number().int().positive().default(5),
    whisper_command: z.string().default('whisper'),
    whisper_language: z.string().optional(),
    live_recording: z.object({
      enabled: z.boolean().default(false),
      chunk_seconds: z.number().int().positive().default(300),
      format: z.enum(['m4a']).default('m4a'),
      sample_rate: z.number().int().positive().default(16_000),
      channels: z.number().int().positive().max(2).default(1),
    }).default({
      enabled: false,
      chunk_seconds: 300,
      format: 'm4a',
      sample_rate: 16_000,
      channels: 1,
    }),
  }).default({
    inbox_path: '~/.cofounderOS/raw/audio/inbox',
    processed_path: '~/.cofounderOS/raw/audio/processed',
    failed_path: '~/.cofounderOS/raw/audio/failed',
    tick_interval_sec: 60,
    batch_size: 5,
    whisper_command: 'whisper',
    live_recording: {
      enabled: false,
      chunk_seconds: 300,
      format: 'm4a',
      sample_rate: 16_000,
      channels: 1,
    },
  }),
  // Output format for screenshots. WebP is ~40% smaller than JPEG at
  // visually identical quality. JPEG is kept as an option for callers
  // that need OS-native compatibility (e.g., older Quick Look stacks).
  screenshot_format: z.enum(['webp', 'jpeg']).default('webp'),
  // Initial encoding quality (1-100). For screen content (UI, text,
  // flat colors) WebP-55 is visually indistinguishable from 75 and
  // ~30-40% smaller. Photographs would warrant ~75; we don't shoot
  // those.
  screenshot_quality: z.number().int().min(1).max(100).default(55),
  // Cap the longest edge of every screenshot at capture time. Native
  // Retina captures are ~3000+ px wide — 4-5× more pixels than any
  // downstream consumer (OCR, perceptual hash, markdown thumbnails)
  // actually uses. 0 disables the resize.
  screenshot_max_dim: z.number().int().nonnegative().max(8192).default(1280),
  // Floor between two soft-trigger (`content_change`) captures of the
  // same display, in ms. Hard triggers (window_focus / url_change /
  // idle_end) bypass this. 0 disables the throttle.
  content_change_min_interval_ms: z.number().int().nonnegative().default(20_000),
  /** @deprecated kept for backward-compat; if set, overrides quality when format=jpeg. */
  jpeg_quality: z.number().int().min(1).max(100).optional(),
  excluded_apps: z.array(z.string()).default([
    '1Password',
    'Bitwarden',
    'Keychain Access',
  ]),
  excluded_url_patterns: z.array(z.string()).default([]),
  // macOS Accessibility-text reader. When enabled, every screenshot also
  // pulls visible text from the focused app's AX tree via a small native
  // helper — far better than OCR for any app with real text widgets
  // (Slack, Mail, Cursor, browser content, Notion, Linear, etc.).
  accessibility: z.object({
    enabled: z.boolean().default(true),
    timeout_ms: z.number().int().positive().default(1500),
    max_chars: z.number().int().positive().default(8000),
    max_elements: z.number().int().positive().default(4000),
    excluded_apps: z.array(z.string()).default([]),
  }).default({
    enabled: true,
    timeout_ms: 1500,
    max_chars: 8000,
    max_elements: 4000,
    excluded_apps: [],
  }),
  privacy: z.object({
    blur_password_fields: z.boolean().default(true),
    pause_on_screen_lock: z.boolean().default(true),
    sensitive_keywords: z.array(z.string()).default(['password', 'api_key', 'secret']),
  }).default({
    blur_password_fields: true,
    pause_on_screen_lock: true,
    sensitive_keywords: ['password', 'api_key', 'secret'],
  }),
}).passthrough();

const StorageSchema = z.object({
  plugin: z.string().default('local'),
  local: z.object({
    // Storage root. raw/, checkpoints/ and cofounderOS.db live inside it.
    path: z.string().default('~/.cofounderOS'),
    max_size_gb: z.number().positive().default(50),
    retention_days: z.number().int().nonnegative().default(365),
    // Vacuum policy applied to screenshot assets in raw/. Three sliding
    // windows: ORIGINAL (full resolution, full quality), COMPRESSED
    // (full resolution, low quality), THUMBNAIL (downscaled). Past the
    // delete window, the asset is removed entirely; the frame's text
    // and metadata stay in SQLite forever.
    //
    // 0 disables that stage. Stages compose: a 14-day-old asset is
    // compressed (because compress_after_days=7) but not yet thumbnailed.
    vacuum: z.object({
      // Each stage accepts either *_minutes (precise, finer-grained,
      // wins if both are set) or *_days (coarse, legacy). 0 disables
      // the stage entirely. The ms-resolved value is what
      // StorageVacuum actually uses internally.
      compress_after_days: z.number().int().nonnegative().default(1),
      compress_after_minutes: z.number().int().nonnegative().optional(),
      compress_quality: z.number().int().min(1).max(100).default(40),
      thumbnail_after_days: z.number().int().nonnegative().default(7),
      thumbnail_after_minutes: z.number().int().nonnegative().optional(),
      thumbnail_max_dim: z.number().int().min(64).max(2048).default(480),
      delete_after_days: z.number().int().nonnegative().default(30),
      delete_after_minutes: z.number().int().nonnegative().optional(),
      // How often the vacuum scheduler ticks. Cheap when there's no work.
      tick_interval_min: z.number().int().positive().default(15),
      // Per-tick batch size. Vacuum is IO + CPU-heavy (sharp re-encode);
      // small batches keep it from starving capture.
      batch_size: z.number().int().positive().default(50),
    }).default({
      compress_after_days: 1,
      compress_quality: 40,
      thumbnail_after_days: 7,
      thumbnail_max_dim: 480,
      delete_after_days: 30,
      tick_interval_min: 15,
      batch_size: 50,
    }),
  }).default({
    path: '~/.cofounderOS',
    max_size_gb: 50,
    retention_days: 365,
    vacuum: {
      compress_after_days: 1,
      compress_quality: 40,
      thumbnail_after_days: 7,
      thumbnail_max_dim: 480,
      delete_after_days: 30,
      tick_interval_min: 15,
      batch_size: 50,
    },
  }),
}).passthrough();

const IndexSchema = z.object({
  strategy: z.string().default('karpathy'),
  index_path: z.string().default('~/.cofounderOS/index'),
  // Ceiling on how stale the index can be during idle. The scheduler's
  // single-flight guard prevents overlap, and `runIncremental` is a
  // near-no-op (~20ms) when there are no new events, so a tight default
  // is safe. Active capture also nudges this job out-of-band via the
  // event bus, so this is effectively the *idle* upper bound.
  incremental_interval_min: z.number().int().positive().default(5),
  reorganise_schedule: z.string().default('0 2 * * *'),
  reorganise_on_idle: z.boolean().default(true),
  idle_trigger_min: z.number().int().positive().default(10),
  batch_size: z.number().int().positive().default(50),
  // Activity sessions (V2). The SessionBuilder groups frames into
  // continuous focus runs separated by idle gaps. Tightening
  // `idle_threshold_sec` produces more, shorter sessions; loosening it
  // merges nearby work into longer ones. `afk_threshold_sec` only
  // affects journal rendering — gaps below it stay implicit, gaps
  // above it surface as visible "idle" markers between sessions.
  sessions: z.object({
    idle_threshold_sec: z.number().int().positive().default(300),
    afk_threshold_sec: z.number().int().positive().default(120),
    min_active_ms: z.number().int().nonnegative().default(30_000),
    fallback_frame_attention_ms: z.number().int().positive().default(5_000),
  }).default({
    idle_threshold_sec: 300,
    afk_threshold_sec: 120,
    min_active_ms: 30_000,
    fallback_frame_attention_ms: 5_000,
  }),
  // Semantic embeddings (V2). Embeddings are derived from frame
  // text/title/url and blended into MCP search for conceptual matches
  // that keyword FTS would miss.
  embeddings: z.object({
    enabled: z.boolean().default(true),
    batch_size: z.number().int().positive().default(32),
    tick_interval_min: z.number().int().positive().default(5),
    search_weight: z.number().positive().default(0.35),
  }).default({
    enabled: true,
    batch_size: 32,
    tick_interval_min: 5,
    search_weight: 0.35,
  }),
  model: z.object({
    plugin: z.string().default('ollama'),
    ollama: z.object({
      model: z.string().default('gemma2:2b'),
      embedding_model: z.string().default('nomic-embed-text'),
      host: z.string().default('http://127.0.0.1:11434'),
      vision_model: z.string().optional(),
      // First-run UX: auto-install Ollama and auto-pull the model the
      // first time the agent loads. Set to false to require manual setup.
      auto_install: z.boolean().default(true),
    }).default({
      model: 'gemma2:2b',
      embedding_model: 'nomic-embed-text',
      host: 'http://127.0.0.1:11434',
      auto_install: true,
    }),
    claude: z.object({
      api_key: z.string().optional(),
      model: z.string().default('claude-sonnet-4-6'),
    }).optional(),
    openai: z.object({
      api_key: z.string().optional(),
      base_url: z.string().default('https://api.openai.com/v1'),
      model: z.string().default('gpt-4o'),
    }).optional(),
  }).default({
    plugin: 'ollama',
    ollama: {
      model: 'gemma2:2b',
      embedding_model: 'nomic-embed-text',
      host: 'http://127.0.0.1:11434',
    },
  }),
}).passthrough();

/**
 * System-level guards that apply across layers. The `load_guard` skips
 * heavy scheduled work (incremental index, reorganise, vacuum) when the
 * machine is already under load, so CofounderOS never competes with the
 * user's foreground tasks.
 *
 * The signal is the 1-minute load average normalised by CPU count. A
 * threshold of `0.7` means: skip when the box has been running at >=70%
 * of its cores for the last minute. Cheap jobs (frame builder, OCR,
 * entity resolver) are *not* gated — they're small and keep search
 * results fresh.
 *
 * Note: `os.loadavg()` is not implemented on Windows (returns zeros);
 * the guard auto-disables there so we never block forever.
 */
const SystemSchema = z.object({
  load_guard: z.object({
    enabled: z.boolean().default(true),
    // Normalised 1-min load average (loadavg[0] / cpuCount). 0.7 = 70%.
    threshold: z.number().positive().max(8).default(0.7),
    // Hard cap on how long we'll keep deferring a single job. After this
    // many consecutive skips, we run it anyway so the index can never
    // fall arbitrarily far behind on a chronically busy machine.
    max_consecutive_skips: z.number().int().nonnegative().default(6),
  }).default({
    enabled: true,
    threshold: 0.7,
    max_consecutive_skips: 6,
  }),
}).default({
  load_guard: {
    enabled: true,
    threshold: 0.7,
    max_consecutive_skips: 6,
  },
});

const ExportPluginSchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional().default(true),
}).passthrough();

const ExportSchema = z.object({
  plugins: z.array(ExportPluginSchema).default([
    { name: 'markdown', enabled: true },
    { name: 'mcp', enabled: true },
  ]),
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

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG_FILENAME = 'config.yaml';

/**
 * Default config.yaml — written verbatim by `cofounderos init`. Comments
 * preserved.
 */
export const DEFAULT_CONFIG_YAML = `# ~/.cofounderOS/config.yaml
# CofounderOS configuration. Restart the agent after editing.

app:
  name: CofounderOS
  data_dir: ~/.cofounderOS
  log_level: info

# Layer 1 — Capture
capture:
  plugin: node                    # default Node-based capture; "rust" once available
  poll_interval_ms: 1500          # how often to poll for window/url changes
  screenshot_diff_threshold: 0.10 # skip screenshots with < 10% visual change
  idle_threshold_sec: 60
  screenshot_format: webp         # 'webp' (smaller) or 'jpeg'
  screenshot_quality: 55          # 1-100; 55 is plenty for screen content
  screenshot_max_dim: 1280        # cap longest edge at capture (0 = native res)
  content_change_min_interval_ms: 20000 # min ms between soft-trigger captures
  capture_audio: false            # V2
  whisper_model: tiny             # V2
  audio:
    inbox_path: ~/.cofounderOS/raw/audio/inbox
    processed_path: ~/.cofounderOS/raw/audio/processed
    failed_path: ~/.cofounderOS/raw/audio/failed
    tick_interval_sec: 60
    batch_size: 5
    whisper_command: whisper      # OpenAI Whisper CLI; .txt/.vtt/.srt files import without it
    live_recording:
      enabled: false              # native plugin only; records mic/input chunks into inbox
      chunk_seconds: 300
      format: m4a
      sample_rate: 16000
      channels: 1
  excluded_apps:
    - 1Password
    - Bitwarden
    - Keychain Access
  excluded_url_patterns: []
  # Multi-monitor capture. Off by default — one screenshot per trigger
  # from the primary display. When enabled, every detected display is
  # captured on each trigger and emitted as its own screenshot event
  # with a distinct screen_index. Optionally constrain to a subset by
  # zero-based index, e.g. \`screens: [0, 1]\` to skip a third monitor.
  multi_screen: false
  # screens: [0, 1]
  # How to pick displays per trigger when multi_screen is true:
  #   active - capture only the display that owns the focused window
  #            (default). Cuts storage/CPU ~N× without losing acted-on
  #            signal, since reasoning is keyed off the active window.
  #   all    - capture every configured display every time. Use when
  #            secondary monitors carry independent signal you'll
  #            reference later (dashboards, reference docs).
  capture_mode: active
  # macOS Accessibility-text reader (V2). Pulls visible text from the
  # focused app's AX tree on every screenshot — much better than OCR
  # for apps with real text widgets (Slack, Mail, Cursor, browsers,
  # Notion, Linear, etc.). Falls back to OCR cleanly if unavailable.
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

# Layer 2 — Storage
storage:
  plugin: local
  local:
    path: ~/.cofounderOS         # storage root; raw/ + checkpoints/ + .db inside
    max_size_gb: 50
    retention_days: 365            # 0 = keep forever
    # Sliding-window retention for screenshot assets. SQLite metadata
    # (frames + OCR text) is kept forever; only the image files are
    # downsized or deleted.
    vacuum:
      # Each stage accepts *_days OR *_minutes (minutes wins if set).
      # 0 disables a stage. Defaults below are tuned for personal use;
      # for scale testing try compress_after_minutes: 30,
      # thumbnail_after_minutes: 360, delete_after_days: 14.
      compress_after_days: 1       # re-encode older originals at lower quality
      compress_quality: 40
      thumbnail_after_days: 7      # downscale once an asset is this old
      thumbnail_max_dim: 480
      delete_after_days: 30        # 0 = keep image forever
      tick_interval_min: 15
      batch_size: 50

# Layer 3 — Index
index:
  strategy: karpathy
  index_path: ~/.cofounderOS/index
  incremental_interval_min: 5      # idle ceiling; active capture triggers indexing out-of-band
  reorganise_schedule: "0 2 * * *"
  reorganise_on_idle: true
  idle_trigger_min: 10
  batch_size: 50
  # Activity sessions (V2). Frames separated by a gap larger than
  # idle_threshold_sec start a new session. afk_threshold_sec is the
  # journal-only cosmetic threshold for showing "idle for N min"
  # markers between sessions. min_active_ms drops trivially short
  # sessions from the primary list.
  sessions:
    idle_threshold_sec: 300
    afk_threshold_sec: 120
    min_active_ms: 30000
  # Semantic embeddings (V2). Generated from frame text/title/url and
  # blended into MCP search so conceptual matches work even when the
  # exact keyword is absent.
  embeddings:
    enabled: true
    batch_size: 32
    tick_interval_min: 5
    search_weight: 0.35
  model:
    plugin: ollama
    ollama:
      model: gemma2:2b           # swap for gemma4:e4b once your Ollama has it
      embedding_model: nomic-embed-text
      host: http://127.0.0.1:11434
      auto_install: true         # auto-install Ollama + pull model on first run

# Cross-cutting system guards
system:
  # Skip heavy scheduled work (indexing, reorganise, vacuum) when the
  # machine is already busy, so CofounderOS never competes with your
  # foreground apps. Disable to always run on schedule.
  load_guard:
    enabled: true
    threshold: 0.7              # normalised 1-min load (loadavg / cpu_count)
    max_consecutive_skips: 6    # safety valve — run anyway after this many skips

# Layer 4 — Export
export:
  plugins:
    - name: markdown
      path: ~/.cofounderOS/export/markdown
    - name: mcp
      port: 3456
      host: 127.0.0.1
      text_excerpt_chars: 5000       # max OCR/AX text chars returned per frame preview
`;

export interface LoadedConfig {
  config: CofounderOSConfig;
  /** Absolute path to the data directory (already expanded). */
  dataDir: string;
  /** Absolute path to the config file used. */
  sourcePath: string;
}

/**
 * Load and validate config.yaml. If `path` is omitted, looks at
 * $COFOUNDEROS_CONFIG, then ~/.cofounderOS/config.yaml (or
 * $COFOUNDEROS_DATA_DIR/config.yaml when set). If no file exists,
 * returns the schema defaults.
 *
 * When $COFOUNDEROS_DATA_DIR is set and the loaded config still uses
 * the stock '~/.cofounderOS' tree (i.e. user hasn't customised paths),
 * we re-root every default-shaped path under the env value. That makes
 * the env var a real "redirect everything" knob — useful for sandboxed
 * tests, multi-tenant setups, and per-OS install conventions
 * (e.g. pointing at $XDG_DATA_HOME/cofounderos on Linux or
 * %APPDATA%/cofounderos on Windows).
 */
export async function loadConfig(configPath?: string): Promise<LoadedConfig> {
  const resolved = await resolveConfigPath(configPath);

  let raw: unknown = {};
  let sourcePath = resolved;

  try {
    const text = await fs.readFile(resolved, 'utf8');
    raw = YAML.parse(text) ?? {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      raw = {};
      sourcePath = '<defaults>';
    } else {
      throw err;
    }
  }

  const config = ConfigSchema.parse(raw);
  rerootStockPaths(config);
  const dataDir = expandPath(config.app.data_dir);
  return { config, dataDir, sourcePath };
}

/**
 * If $COFOUNDEROS_DATA_DIR is set, rewrite any path on the parsed
 * config that still equals the stock `~/.cofounderOS` default to the
 * env value. Touches only paths the user hasn't customised — anything
 * the YAML explicitly overrides is left alone.
 */
function rerootStockPaths(config: CofounderOSConfig): void {
  const envRoot = process.env.COFOUNDEROS_DATA_DIR;
  if (!envRoot || envRoot.trim().length === 0) return;
  const STOCK = '~/.cofounderOS';

  const swap = (val: string): string => {
    if (val === STOCK) return envRoot;
    if (val.startsWith(`${STOCK}/`)) return `${envRoot}/${val.slice(STOCK.length + 1)}`;
    return val;
  };

  config.app.data_dir = swap(config.app.data_dir);
  // Storage / index defaults follow the same convention.
  const storageBlock = (config.storage as unknown as Record<string, Record<string, unknown>>)[
    config.storage.plugin
  ];
  if (storageBlock && typeof storageBlock.path === 'string') {
    storageBlock.path = swap(storageBlock.path);
  }
  if (typeof config.index.index_path === 'string') {
    config.index.index_path = swap(config.index.index_path);
  }
  // Export plugins each get their own free-form config; rewrite any
  // string field that looks like a stock-rooted path.
  for (const plugin of config.export.plugins) {
    for (const [k, v] of Object.entries(plugin)) {
      if (typeof v === 'string') (plugin as Record<string, unknown>)[k] = swap(v);
    }
  }
}

async function resolveConfigPath(explicit?: string): Promise<string> {
  if (explicit) return expandPath(explicit);
  const env = process.env.COFOUNDEROS_CONFIG;
  if (env) return expandPath(env);
  return path.join(defaultDataDir(), DEFAULT_CONFIG_FILENAME);
}

/** Write the default config.yaml to disk if it doesn't exist. */
export async function writeDefaultConfigIfMissing(
  dataDir: string = defaultDataDir(),
): Promise<{ created: boolean; path: string }> {
  const target = path.join(dataDir, DEFAULT_CONFIG_FILENAME);
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(target);
    return { created: false, path: target };
  } catch {
    await fs.writeFile(target, DEFAULT_CONFIG_YAML, 'utf8');
    return { created: true, path: target };
  }
}

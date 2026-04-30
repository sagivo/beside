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
  screenshot_diff_threshold: z.number().min(0).max(1).default(0.05),
  idle_threshold_sec: z.number().int().positive().default(60),
  capture_audio: z.boolean().default(false),
  whisper_model: z.string().default('tiny'),
  // Output format for screenshots. WebP is ~40% smaller than JPEG at
  // visually identical quality. JPEG is kept as an option for callers
  // that need OS-native compatibility (e.g., older Quick Look stacks).
  screenshot_format: z.enum(['webp', 'jpeg']).default('webp'),
  // Initial encoding quality (1-100). For WebP, 75 is the sweet spot;
  // for JPEG, 85.
  screenshot_quality: z.number().int().min(1).max(100).default(75),
  /** @deprecated kept for backward-compat; if set, overrides quality when format=jpeg. */
  jpeg_quality: z.number().int().min(1).max(100).optional(),
  excluded_apps: z.array(z.string()).default([
    '1Password',
    'Bitwarden',
    'Keychain Access',
  ]),
  excluded_url_patterns: z.array(z.string()).default([]),
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
      compress_after_days: z.number().int().nonnegative().default(7),
      compress_quality: z.number().int().min(1).max(100).default(45),
      thumbnail_after_days: z.number().int().nonnegative().default(30),
      thumbnail_max_dim: z.number().int().min(64).max(2048).default(480),
      delete_after_days: z.number().int().nonnegative().default(180),
      // How often the vacuum scheduler ticks. Cheap when there's no work.
      tick_interval_min: z.number().int().positive().default(60),
      // Per-tick batch size. Vacuum is IO + CPU-heavy (sharp re-encode);
      // small batches keep it from starving capture.
      batch_size: z.number().int().positive().default(50),
    }).default({
      compress_after_days: 7,
      compress_quality: 45,
      thumbnail_after_days: 30,
      thumbnail_max_dim: 480,
      delete_after_days: 180,
      tick_interval_min: 60,
      batch_size: 50,
    }),
  }).default({
    path: '~/.cofounderOS',
    max_size_gb: 50,
    retention_days: 365,
    vacuum: {
      compress_after_days: 7,
      compress_quality: 45,
      thumbnail_after_days: 30,
      thumbnail_max_dim: 480,
      delete_after_days: 180,
      tick_interval_min: 60,
      batch_size: 50,
    },
  }),
}).passthrough();

const IndexSchema = z.object({
  strategy: z.string().default('karpathy'),
  index_path: z.string().default('~/.cofounderOS/index'),
  incremental_interval_min: z.number().int().positive().default(30),
  reorganise_schedule: z.string().default('0 2 * * *'),
  reorganise_on_idle: z.boolean().default(true),
  idle_trigger_min: z.number().int().positive().default(10),
  batch_size: z.number().int().positive().default(50),
  model: z.object({
    plugin: z.string().default('ollama'),
    ollama: z.object({
      model: z.string().default('gemma2:2b'),
      host: z.string().default('http://localhost:11434'),
      vision_model: z.string().optional(),
      // First-run UX: auto-install Ollama and auto-pull the model the
      // first time the agent loads. Set to false to require manual setup.
      auto_install: z.boolean().default(true),
    }).default({
      model: 'gemma2:2b',
      host: 'http://localhost:11434',
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
    ollama: { model: 'gemma2:2b', host: 'http://localhost:11434' },
  }),
}).passthrough();

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
  screenshot_diff_threshold: 0.05 # skip screenshots with < 5% visual change
  idle_threshold_sec: 60
  screenshot_format: webp         # 'webp' (smaller) or 'jpeg'
  screenshot_quality: 75          # 1-100; 75 is a good WebP default
  capture_audio: false            # V2
  whisper_model: tiny             # V2
  excluded_apps:
    - 1Password
    - Bitwarden
    - Keychain Access
  excluded_url_patterns: []
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
      compress_after_days: 7       # re-encode older originals at lower quality
      compress_quality: 45
      thumbnail_after_days: 30     # downscale once an asset is this old
      thumbnail_max_dim: 480
      delete_after_days: 180       # 0 = keep image forever
      tick_interval_min: 60
      batch_size: 50

# Layer 3 — Index
index:
  strategy: karpathy
  index_path: ~/.cofounderOS/index
  incremental_interval_min: 30
  reorganise_schedule: "0 2 * * *"
  reorganise_on_idle: true
  idle_trigger_min: 10
  batch_size: 50
  model:
    plugin: ollama
    ollama:
      model: gemma2:2b           # swap for gemma4:e4b once your Ollama has it
      host: http://localhost:11434
      auto_install: true         # auto-install Ollama + pull model on first run

# Layer 4 — Export
export:
  plugins:
    - name: markdown
      path: ~/.cofounderOS/export/markdown
    - name: mcp
      port: 3456
      host: localhost
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
 * $COFOUNDEROS_CONFIG, then ~/.cofounderOS/config.yaml. If no file exists,
 * returns the schema defaults.
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
  const dataDir = expandPath(config.app.data_dir);
  return { config, dataDir, sourcePath };
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

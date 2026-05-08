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
  poll_interval_ms: z.number().int().positive().default(3000),
  // Polling cadence to use while the user is idle (`idle_start` fired,
  // before `idle_end`). The active-window poll, screenshot probe, and
  // perceptual-hash diff loop are all wasted CPU when the user isn't
  // touching the machine. 30 s is fine because the next user
  // interaction will fire `idle_end` within one tick — and that tick
  // immediately produces a fresh screenshot, so the perceived recovery
  // latency is bounded by this value. Set <= `poll_interval_ms` to
  // disable the backoff.
  idle_poll_interval_ms: z.number().int().positive().default(30_000),
  focus_settle_delay_ms: z.number().int().nonnegative().default(900),
  // Soft-trigger sensitivity. Bumped above the historic 0.05/0.10
  // defaults because pixel-level noise (blinking cursor, ticking clock,
  // tiny animations) otherwise produced frequent screenshots. Hard
  // triggers still capture focus/url/idle transitions immediately.
  screenshot_diff_threshold: z.number().min(0).max(1).default(0.15),
  idle_threshold_sec: z.number().int().positive().default(60),
  capture_audio: z.boolean().default(true),
  // `tiny` is fast but produces noticeably bad transcripts on
  // conversational audio; `base` is the smallest model that's actually
  // usable for a "memory of what I did" product. Trade-off vs `tiny`:
  // ~3× slower, ~5× more RAM, ~150 MB of weights instead of ~75 MB.
  whisper_model: z.string().default('base'),
  audio: z.object({
    inbox_path: z.string().default('~/.cofounderOS/raw/audio/inbox'),
    processed_path: z.string().default('~/.cofounderOS/raw/audio/processed'),
    failed_path: z.string().default('~/.cofounderOS/raw/audio/failed'),
    tick_interval_sec: z.number().int().positive().default(60),
    batch_size: z.number().int().positive().default(5),
    whisper_command: z.string().default('whisper'),
    whisper_language: z.string().optional(),
    // Delete the source audio file after a successful transcription.
    // The transcript is PII-redacted and durable; retaining raw audio
    // indefinitely would undo that. Set false if you want to keep the
    // m4a/wav for re-processing or manual review.
    delete_audio_after_transcribe: z.boolean().default(true),
    // Reject audio files larger than this before invoking whisper.
    // A user dropping a long screen recording into the inbox would
    // otherwise hit the 30-minute whisper timeout and silently fail.
    // Direct text imports (.txt/.vtt/.srt) are not subject to this cap.
    // Default 500 MiB. Set 0 to disable.
    max_audio_bytes: z.number().int().nonnegative().default(500 * 1024 * 1024),
    // Pre-flight silence floor: if ffprobe reports the file's byte
    // rate (size ÷ duration) is below this, skip whisper entirely
    // and treat as silent. Avoids a 30-min whisper timeout on a chunk
    // that was guaranteed to transcribe to empty (room-tone / muted
    // mic / corrupted recorder). 0 disables. Default 4096 (4 KB/s),
    // well below the AAC floor for real speech (~8–12 KB/s at 16 kHz
    // mono / medium quality).
    min_audio_bytes_per_sec: z.number().int().nonnegative().default(4096),
    // Skip the rate check for clips shorter than this — short files
    // are dominated by container overhead and the rate metric is
    // noisy. Default 5000 (5 s).
    min_audio_rate_check_ms: z.number().int().nonnegative().default(5000),
    // Live mic/input recording. OFF by default for two reasons:
    //   1. Privacy. Continuous mic capture is a meaningfully more
    //      sensitive surface than screenshots; users should opt in
    //      explicitly rather than discover it post-install.
    //   2. CPU. Whisper transcription runs every audio tick; on
    //      machines without GPU acceleration it's the heaviest worker
    //      in the system. Off-by-default keeps idle CPU near zero
    //      until the user wants meeting capture.
    // Set `enabled: true` in config.yaml to record (native plugin only).
    live_recording: z.object({
      enabled: z.boolean().default(false),
      chunk_seconds: z.number().int().positive().default(300),
      format: z.enum(['m4a']).default('m4a'),
      sample_rate: z.number().int().positive().default(16_000),
      channels: z.number().int().positive().max(2).default(1),
      activation: z.enum(['other_process_input', 'always']).default('other_process_input'),
      system_audio_backend: z.enum(['core_audio_tap', 'screencapturekit', 'off']).default('core_audio_tap'),
      poll_interval_sec: z.number().int().positive().default(3),
    }).default({
      enabled: false,
      chunk_seconds: 300,
      format: 'm4a',
      sample_rate: 16_000,
      channels: 1,
      activation: 'other_process_input',
      system_audio_backend: 'core_audio_tap',
      poll_interval_sec: 3,
    }),
  }).default({
    inbox_path: '~/.cofounderOS/raw/audio/inbox',
    processed_path: '~/.cofounderOS/raw/audio/processed',
    failed_path: '~/.cofounderOS/raw/audio/failed',
    tick_interval_sec: 60,
    batch_size: 5,
    whisper_command: 'whisper',
    delete_audio_after_transcribe: true,
    max_audio_bytes: 500 * 1024 * 1024,
    min_audio_bytes_per_sec: 4096,
    min_audio_rate_check_ms: 5000,
    live_recording: {
      enabled: false,
      chunk_seconds: 300,
      format: 'm4a',
      sample_rate: 16_000,
      channels: 1,
      activation: 'other_process_input',
      system_audio_backend: 'core_audio_tap',
      poll_interval_sec: 3,
    },
  }),
  // Output format for screenshots. WebP is ~40% smaller than JPEG at
  // visually identical quality. JPEG is kept as an option for callers
  // that need OS-native compatibility (e.g., older Quick Look stacks).
  screenshot_format: z.enum(['webp', 'jpeg']).default('webp'),
  // Initial encoding quality (1-100). For screen content (UI, text,
  // flat colors) WebP-45 is still readable for OCR/human review while
  // reducing encode work and disk churn further than the old WebP-55.
  // Photographs would warrant ~75; we don't shoot those.
  screenshot_quality: z.number().int().min(1).max(100).default(45),
  // Cap the longest edge of every screenshot at capture time. Native
  // Retina captures are ~3000+ px wide — roughly 7× more pixels than any
  // downstream consumer (OCR, perceptual hash, markdown thumbnails)
  // actually uses. 0 disables the resize.
  screenshot_max_dim: z.number().int().nonnegative().max(8192).default(1100),
  // Floor between two soft-trigger (`content_change`) captures of the
  // same display, in ms. Hard triggers (window_focus / url_change /
  // idle_end) bypass this. 0 disables the throttle.
  content_change_min_interval_ms: z.number().int().nonnegative().default(60_000),
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
      //
      // Defaults are tuned for "the screenshot mostly serves OCR +
      // embeddings + occasional vision recall". OCR/AX text is
      // extracted within ~60-90s; embeddings within minutes; the
      // information value of the original-quality WebP drops sharply
      // after that. Compressing within 4h instead of 24h saves
      // gigabytes/month on a continuously-captured machine without
      // affecting any indexing path. Thumbnailing after 3 days (vs 7)
      // matches typical search/recall horizons; older frames are
      // overwhelmingly accessed via the markdown export which already
      // serves at 480px.
      // NOTE: per-field defaults intentionally preserve legacy
      // semantics (`compress_after_days: 1`, no `compress_after_minutes`)
      // for users who already have a partial `vacuum:` block in their
      // config — we only adjust the *fresh-install* defaults below.
      // The orchestrator's `stageMs(days, minutes)` lets minutes win
      // when set, otherwise falls back to days.
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
      compress_after_days: 0,
      compress_after_minutes: 240,
      compress_quality: 40,
      thumbnail_after_days: 3,
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
      compress_after_days: 0,
      compress_after_minutes: 240,
      compress_quality: 40,
      thumbnail_after_days: 3,
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
  // Ceiling on how stale the LLM-backed index can be when scheduled
  // background model jobs are enabled. The laptop-friendly default is
  // `system.background_model_jobs: manual`, so this only applies after
  // a user explicitly opts back into always-on organisation.
  incremental_interval_min: z.number().int().positive().default(30),
  reorganise_schedule: z.string().default('0 2 * * *'),
  // When true, idle-on-power catch-up may run the expensive indexing
  // leg after deterministic capture processing has drained.
  reorganise_on_idle: z.boolean().default(true),
  // Minutes of OS idle time before the idle-on-power catch-up path
  // wakes deferred heavy work.
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
  // Meetings (V2). The MeetingBuilder groups consecutive
  // meeting-kind frames (Zoom / Meet / Teams / Webex / ...) into
  // first-class Meeting rows and fuses overlapping audio_transcript
  // frames into them. The MeetingSummarizer then produces a
  // structured TL;DR + decisions + action items per meeting via the
  // model adapter. Set `summarize: false` to disable the LLM step
  // and keep only the deterministic Stage A summary (still useful).
  meetings: z.object({
    idle_threshold_sec: z.number().int().positive().default(300),
    min_duration_sec: z.number().int().nonnegative().default(180),
    audio_grace_sec: z.number().int().nonnegative().default(60),
    summarize: z.boolean().default(true),
    summarize_cooldown_sec: z.number().int().nonnegative().default(300),
    vision_attachments: z.number().int().nonnegative().default(4),
  }).default({
    idle_threshold_sec: 300,
    min_duration_sec: 180,
    audio_grace_sec: 60,
    summarize: true,
    summarize_cooldown_sec: 300,
    vision_attachments: 4,
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
      model: z.string().default('gemma4:e4b'),
      embedding_model: z.string().default('nomic-embed-text'),
      host: z.string().default('http://127.0.0.1:11434'),
      vision_model: z.string().optional(),
      // Optional smaller model used for the indexing path
      // (Karpathy strategy summarisation/categorisation,
      // reorganisation). When set and different from `model`, the
      // orchestrator loads a second adapter and uses it for those
      // calls. Chat and vision recall (`completeWithVision`) keep
      // running on the primary `model`. Big practical win: the
      // smaller indexer model loads in seconds and uses ~3 GB of RAM
      // instead of ~9 GB, while the better model is reserved for
      // user-facing answers. Default unset (legacy behaviour: one
      // adapter for everything). Recommended: `gemma4:e2b` when the
      // primary is `gemma4:e4b`.
      indexer_model: z.string().optional(),
      keep_alive: z.union([z.string(), z.number()]).default('30s'),
      // Host-side idle unload timer. The previous default of 2 minutes
      // double-buffered Ollama's own `keep_alive` (30s) — meaning even
      // after Ollama would have evicted the model, the host kept it
      // pinned for another 90s. With `0` we trust Ollama's `keep_alive`,
      // and a fully idle machine drops the ~9 GB model from RAM
      // ~30s after the last request instead of ~2 minutes. Set to a
      // positive number to opt back into the host backstop (useful if
      // you're running Ollama with `keep_alive: -1` for warm-loading).
      unload_after_idle_min: z.number().nonnegative().default(0),
      // First-run UX: auto-install Ollama and auto-pull the model the
      // first time the agent loads. Set to false to require manual setup.
      auto_install: z.boolean().default(true),
      // Bumping this number forces the orchestrator to re-pull the
      // configured model + embedding model on the next start, even if
      // they are already present locally. Use it to pick up freshly
      // re-published weights under the same Ollama tag (e.g. an updated
      // gemma4:e4b manifest). Compared against a marker file in the
      // data dir; the bootstrap writes the new value on success.
      model_revision: z.number().int().nonnegative().default(3),
    }).default({
      model: 'gemma4:e4b',
      embedding_model: 'nomic-embed-text',
      host: 'http://127.0.0.1:11434',
      keep_alive: '30s',
      unload_after_idle_min: 0,
      auto_install: true,
      model_revision: 3,
    }),
    claude: z.object({
      api_key: z.string().optional(),
      model: z.string().default('claude-sonnet-4-6'),
    }).optional(),
    openai: z.object({
      api_key: z.string().optional(),
      base_url: z.string().default('https://api.openai.com/v1'),
      model: z.string().default('gpt-4o-mini'),
      vision_model: z.string().optional(),
      embedding_model: z.string().default('text-embedding-3-small'),
    }).optional(),
  }).default({
    plugin: 'ollama',
    ollama: {
      model: 'gemma4:e4b',
      embedding_model: 'nomic-embed-text',
      host: 'http://127.0.0.1:11434',
    },
  }),
}).passthrough();

/**
 * System-level guards that apply across layers. `background_model_jobs`
 * controls whether scheduled LLM/embedding work runs automatically at
 * all. The `load_guard` then skips any enabled heavy scheduled work
 * (OCR, Whisper transcription, embeddings, index maintenance, meeting
 * summaries, vacuum) when the machine is already under load or low on
 * battery, so CofounderOS never competes with foreground tasks.
 *
 * The signal is the 1-minute load average normalised by CPU count. A
 * threshold of `0.7` means: skip when the box has been running at >=70%
 * of its cores for the last minute. Cheap jobs (frame builder, entity
 * resolver, session grouping) are *not* gated — they're small and keep
 * the captured substrate fresh.
 *
 * Note: `os.loadavg()` is not implemented on Windows (returns zeros);
 * the guard auto-disables there so we never block forever.
 */
const SystemSchema = z.object({
  // `manual` keeps deterministic capture preparation (frames, OCR/AX
  // text, entities, sessions) fresh but does not run scheduled
  // LLM/embedding jobs by itself. Chat still uses the model; manual
  // "Organize now", MCP reindex requests, and explicit meeting
  // summarisation run only when the resource guard allows heavy work.
  // Set `scheduled` for the old always-organising behavior.
  background_model_jobs: z.enum(['manual', 'scheduled']).default('manual'),
  load_guard: z.object({
    enabled: z.boolean().default(true),
    // Normalised 1-min load average (loadavg[0] / cpuCount). 0.7 = 70%.
    threshold: z.number().positive().max(8).default(0.7),
    // Approximate used/total memory ratio. 0.9 = skip heavy work when
    // the machine has less than ~10% free memory.
    memory_threshold: z.number().positive().max(1).default(0.9),
    // Battery percentage below which heavy work is deferred while
    // unplugged. 0 disables the low-battery brake.
    low_battery_threshold_pct: z.number().int().min(0).max(100).default(25),
    // Legacy CPU-only safety valve. 0 means never force background work
    // while overloaded; low-battery and memory-pressure skips are never
    // forced regardless of this value.
    max_consecutive_skips: z.number().int().nonnegative().default(0),
  }).default({
    enabled: true,
    threshold: 0.7,
    memory_threshold: 0.9,
    low_battery_threshold_pct: 25,
    max_consecutive_skips: 0,
  }),
}).default({
  background_model_jobs: 'manual',
  load_guard: {
    enabled: true,
    threshold: 0.7,
    memory_threshold: 0.9,
    low_battery_threshold_pct: 25,
    max_consecutive_skips: 0,
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
  poll_interval_ms: 3000          # how often to poll for window/url changes
  idle_poll_interval_ms: 30000    # cadence while idle (>= poll_interval_ms; lower = faster idle_end recovery, higher = less idle CPU)
  focus_settle_delay_ms: 900      # wait after app switch before screenshot
  screenshot_diff_threshold: 0.15 # skip screenshots with < 15% visual change
  idle_threshold_sec: 60
  screenshot_format: webp         # 'webp' (smaller) or 'jpeg'
  screenshot_quality: 45          # 1-100; 45 is plenty for screen content
  screenshot_max_dim: 1100        # cap longest edge at capture (0 = native res)
  content_change_min_interval_ms: 60000 # min ms between soft-trigger captures
  capture_audio: true             # V2; processes ~/.cofounderOS/raw/audio/inbox into audio_transcript events
  whisper_model: base             # V2; tiny is faster but transcripts are noticeably worse
  audio:
    inbox_path: ~/.cofounderOS/raw/audio/inbox
    processed_path: ~/.cofounderOS/raw/audio/processed
    failed_path: ~/.cofounderOS/raw/audio/failed
    tick_interval_sec: 60
    batch_size: 5
    whisper_command: whisper      # OpenAI Whisper CLI; .txt/.vtt/.srt files import without it
    delete_audio_after_transcribe: true # transcript is durable+redacted; raw audio is not retained by default
    max_audio_bytes: 524288000    # 500 MiB; reject larger audio files before whisper (0 = unlimited)
    min_audio_bytes_per_sec: 4096 # silence floor; chunks below this byte rate skip whisper and are deleted (0 = disable)
    min_audio_rate_check_ms: 5000 # skip the silence floor check for clips shorter than this (ms)
    live_recording:
      enabled: false              # off by default — mic capture is opt-in (privacy + CPU). Set true on the native plugin to record mic/input chunks into the inbox.
      # activation controls when microphone recording starts:
      #   other_process_input — record only while another process is actively using audio input
      #     (reliable on wired headsets; may miss Bluetooth/AirPods or virtual audio devices)
      #   always              — record whenever capture is running (recommended for calls)
      activation: other_process_input
      # Remote participant audio:
      #   core_audio_tap  — macOS 14.2+ audio-only system output capture; no screen-sharing indicator
      #   screencapturekit — legacy remote audio capture; shows macOS "Currently Sharing"
      #   off             — mic-only meeting capture
      system_audio_backend: core_audio_tap
      poll_interval_sec: 3        # how often to check whether another process still has mic input
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
      # 0 disables a stage. The defaults below are tuned for "the
      # screenshot mostly serves OCR + embeddings + occasional vision
      # recall": OCR/AX text is extracted within ~60-90s, embeddings
      # within minutes, so the original-quality WebP loses most of its
      # information value after a few hours. Compressing at 4h saves
      # gigabytes/month vs the previous 1-day window without affecting
      # any indexing path; thumbnailing at 3 days matches typical
      # search/recall horizons.
      compress_after_minutes: 240  # re-encode older originals at lower quality (~4h)
      compress_quality: 40
      thumbnail_after_days: 3      # downscale once an asset is this old
      thumbnail_max_dim: 480
      delete_after_days: 30        # 0 = keep image forever
      tick_interval_min: 15
      batch_size: 50

# Layer 3 — Index
index:
  strategy: karpathy
  index_path: ~/.cofounderOS/index
  incremental_interval_min: 30     # used only when system.background_model_jobs: scheduled
  reorganise_schedule: "0 2 * * *"
  reorganise_on_idle: true         # allow idle-on-power catch-up to run expensive indexing work
  idle_trigger_min: 10             # minutes idle before deferred heavy work wakes
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
  # Meetings (V2). Group consecutive Zoom/Meet/Teams/Webex frames
  # into first-class meeting rows; fuse overlapping audio chunks;
  # summarise via the model adapter when summarize: true. Setting
  # summarize: false keeps the deterministic Stage A summary
  # (attendees, links, key screens) but skips the LLM call.
  meetings:
    idle_threshold_sec: 300     # gap that closes an active meeting
    min_duration_sec: 180       # below this, the meeting is flagged short and skipped for summary
    audio_grace_sec: 60         # audio chunks arriving up to N sec after the meeting still attach
    summarize: true             # set false to skip the LLM step
    summarize_cooldown_sec: 300 # wait this long after meeting close before summarising (lets whisper drain)
    vision_attachments: 4       # number of key screenshots to send to the vision model
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
      model: gemma4:e4b           # default Gemma 4 variant — vision + 128K context; swap for gemma4:e2b for the fastest small model
      # Optional smaller model used only for the indexing path
      # (summarisation, reorganisation). Chat and vision recall keep
      # using \`model\` above. Big RAM win — e2b is ~3 GB vs e4b ~9 GB —
      # and idle indexing ticks load and unload faster. Uncomment to opt in:
      # indexer_model: gemma4:e2b
      embedding_model: nomic-embed-text
      host: http://127.0.0.1:11434
      keep_alive: 30s            # keep local models warm briefly after real work
      unload_after_idle_min: 0    # 0 = rely entirely on Ollama's keep_alive (~30s).
                                  # set > 0 only if you run Ollama with keep_alive: -1
                                  # and want a host-side backstop unload.
      auto_install: true         # auto-install Ollama + pull model on first run
      model_revision: 3          # bump to force a re-pull on next start (picks up updated weights under the same tag)
    # To use a hosted OpenAI-compatible model instead:
    # plugin: openai
    # openai:
    #   api_key: \${OPENAI_API_KEY}
    #   base_url: https://api.openai.com/v1
    #   model: gpt-4o-mini
    #   embedding_model: text-embedding-3-small

# Cross-cutting system guards
system:
  # \`manual\` is the laptop-friendly default: capture/text/session work
  # stays current, while LLM indexing, embeddings, and meeting summaries
  # run only from explicit actions (Organize now, MCP reindex,
  # summarize meeting, chat/search explanations). Set to \`scheduled\`
  # for always-on background organization.
  background_model_jobs: manual
  # Skip heavy work (OCR, Whisper audio transcription, embeddings,
  # indexing, meeting summaries, and vacuum) when the machine is already
  # busy or low on battery, so CofounderOS never competes with your
  # foreground apps. Screenshots and raw audio recording continue; the
  # expensive processing catches up later when idle on wall power.
  load_guard:
    enabled: true
    threshold: 0.7              # normalised 1-min load (loadavg / cpu_count)
    memory_threshold: 0.9       # skip when used memory is at/above 90%
    low_battery_threshold_pct: 25 # skip while unplugged below this battery %
    max_consecutive_skips: 0    # 0 = never force a CPU-overload run

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

export function validateConfig(raw: unknown): {
  ok: true;
  config: CofounderOSConfig;
} | {
  ok: false;
  issues: Array<{ path: string; message: string }>;
} {
  const parsed = ConfigSchema.safeParse(raw);
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

export async function writeConfig(
  config: CofounderOSConfig,
  configPath?: string,
): Promise<{ path: string }> {
  const target = await resolveConfigPath(configPath);
  const validated = ConfigSchema.parse(config);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, YAML.stringify(validated), 'utf8');
  return { path: target };
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

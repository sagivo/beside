import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileP = promisify(execFile);
import type {
  ICapture,
  CaptureStatus,
  CaptureConfig,
  RawEvent,
  RawEventHandler,
  PluginFactory,
  Logger,
} from '@cofounderos/interfaces';
import {
  newEventId,
  newSessionId,
  isoTimestamp,
  dayKey,
  timeKey,
  expandPath,
  ensureDir,
} from '@cofounderos/core';
import { dHash, hashDiff } from './perceptual-hash.js';
import { AccessibilityTextReader } from './accessibility-text.js';

interface CaptureNodeConfig {
  poll_interval_ms?: number;
  screenshot_diff_threshold?: number;
  idle_threshold_sec?: number;
  screenshot_format?: 'webp' | 'jpeg';
  screenshot_quality?: number;
  /**
   * Cap the longest edge of every screenshot at capture time. Native
   * Retina captures are ~3000+ px wide; that's ~4-5× more pixels than
   * any downstream consumer (OCR, perceptual hash, markdown export
   * thumbnails) actually uses. Resizing here is the single biggest
   * win for on-disk size — typical reductions are 4-6×. Set to 0 to
   * keep native resolution.
   */
  screenshot_max_dim?: number;
  /**
   * Minimum delay between two `content_change`-triggered screenshots
   * for the same display, in ms. Hard triggers (window_focus,
   * url_change, idle_end) ignore this floor. Pairs with
   * `screenshot_diff_threshold` to stop a slowly-mutating but visually
   * stable screen (clock ticking, blinking cursor) from generating
   * one frame per poll.
   */
  content_change_min_interval_ms?: number;
  /** @deprecated kept for backward-compat with old config files. */
  jpeg_quality?: number;
  excluded_apps?: string[];
  excluded_url_patterns?: string[];
  capture_audio?: boolean;
  whisper_model?: string;
  /**
   * macOS Accessibility-text reader. When enabled (default on macOS), every
   * screenshot trigger also asks the focused app's AX tree for visible
   * text and attaches it to the event's `metadata.ax_text`. Far better
   * than OCR for any app with real text widgets.
   */
  accessibility?: {
    enabled?: boolean;
    timeout_ms?: number;
    max_chars?: number;
    max_elements?: number;
    excluded_apps?: string[];
  };
  privacy?: {
    blur_password_fields?: boolean;
    pause_on_screen_lock?: boolean;
    sensitive_keywords?: string[];
  };
  raw_root?: string;
  /**
   * Multi-screen capture. When `false` (default) only the primary display
   * is screenshotted. When `true`, every display returned by
   * `screenshot.listDisplays()` is captured on each trigger, producing one
   * `screenshot` event per display with a distinct `screen_index`.
   *
   * Optionally constrain to a subset by zero-based index:
   *   `screens: [0, 1]`  -> capture only displays at index 0 and 1.
   * If omitted while `multi_screen: true`, all detected displays are used.
   */
  multi_screen?: boolean;
  screens?: number[];
  /**
   * How to choose which displays to capture on each trigger when
   * `multi_screen: true`:
   *
   *   - `'active'` (default): capture only the display that owns the
   *                focused window — resolved from `active-win` window
   *                bounds against `listDisplays()` rectangles. Cuts
   *                storage and CPU roughly by N (number of displays)
   *                without losing any signal you can act on, since
   *                reasoning is keyed off the active window anyway.
   *   - `'all'`:    capture every configured display every time.
   *                Best for "record everything I look at" workflows
   *                where secondary monitors carry independent signal
   *                (e.g. dashboards you actually reference later).
   *
   * Triggers without a meaningful active window (idle_end, pre-probe,
   * lookup failures) gracefully fall back to capturing all configured
   * displays so we don't silently miss frames.
   */
  capture_mode?: 'all' | 'active';
}

/**
 * Per-display state used to dedupe screenshots independently for each
 * monitor. A change on the laptop screen shouldn't suppress a capture on
 * the external monitor, and vice versa.
 */
interface DisplayInfo {
  /** Stable index in the listDisplays() result (cross-platform). */
  index: number;
  /** Underlying id (string on linux, number on macOS/win) — diagnostic only. */
  id: string | number | null;
  name: string | null;
  /**
   * Display rectangle in global screen coordinates. Used to hit-test the
   * active window's bounds so we can attribute it to the right monitor.
   * `null` when `listDisplays()` didn't return positional info (older
   * `screenshot-desktop` versions, or platforms where it's unsupported).
   */
  rect: { left: number; top: number; width: number; height: number } | null;
  /**
   * macOS-only: 1-based ordinal accepted by `screencapture -D`. Set by
   * the JXA-based enumerator so we can grab pixels from the *correct*
   * physical display directly via `screencapture`, sidestepping the
   * `screenshot-desktop` darwin path's broken display selection (which
   * ignores `-D` entirely and mis-orders displays whenever the OS'
   * `screencapture` ordering disagrees with `system_profiler`'s — the
   * common case on multi-monitor setups). `null` on Linux/Windows or
   * when JXA enumeration fails and we fall back to `screenshot-desktop`.
   */
  macOrdinal: number | null;
  lastHash: string | null;
  lastApp: string | null;
  /**
   * Wall-clock ms of the last screenshot we actually wrote to disk for
   * this display. Used by `content_change_min_interval_ms` to throttle
   * the soft-trigger path so a slowly mutating but visually stable
   * screen can't generate one frame per poll. Hard triggers
   * (window_focus / url_change / idle_end) bypass this floor.
   */
  lastShotAt: number | null;
}

interface ActiveWindowInfo {
  app: string;
  bundleId: string;
  title: string;
  url: string | null;
  screenIndex: number;
  pid: number | null;
}

const SAFE_APP = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
const FIXTURE_CAPTURE =
  process.env.COFOUNDEROS_CAPTURE_FIXTURE === '1' ||
  process.env.COFOUNDEROS_FAKE_DISPLAYS === '1';

/**
 * Encode a raw screenshot buffer to the configured output format. WebP
 * is the default — at quality 75 it produces files ~40-50% smaller than
 * JPEG-85 with no perceptible difference for screen content. JPEG is
 * still available for tools that don't speak WebP.
 */
async function encodeScreenshot(
  buf: Buffer,
  format: 'webp' | 'jpeg',
  quality: number,
  maxDim: number,
): Promise<Buffer> {
  let pipeline = sharp(buf);
  if (maxDim > 0) {
    pipeline = pipeline.resize({
      width: maxDim,
      height: maxDim,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  if (format === 'webp') {
    return pipeline.webp({ quality }).toBuffer();
  }
  return pipeline.jpeg({ quality }).toBuffer();
}

/**
 * Browser → AppleScript snippet that extracts the URL of the current tab
 * or front document. Each snippet is hard-coded with a literal `tell
 * application "X"` so AppleScript can resolve `URL` against that app's
 * dictionary at parse time (otherwise `URL` is treated as a reserved
 * word and the script fails with -2741).
 *
 * Firefox and its forks (LibreWolf, Floorp, Zen, Tor, Waterfox, Mullvad)
 * are intentionally absent: the Mozilla AppleScript dictionary does not
 * expose tab URLs. They are detected by name in `queryBrowserUrlOsascript`
 * to emit a one-time explanatory log.
 */
const BROWSER_URL_SCRIPTS: Record<string, string> = {
  // Chromium family
  'Google Chrome':
    'tell application "Google Chrome" to return URL of active tab of front window',
  'Google Chrome Canary':
    'tell application "Google Chrome Canary" to return URL of active tab of front window',
  'Google Chrome Beta':
    'tell application "Google Chrome Beta" to return URL of active tab of front window',
  'Brave Browser':
    'tell application "Brave Browser" to return URL of active tab of front window',
  'Brave Browser Beta':
    'tell application "Brave Browser Beta" to return URL of active tab of front window',
  'Brave Browser Nightly':
    'tell application "Brave Browser Nightly" to return URL of active tab of front window',
  'Microsoft Edge':
    'tell application "Microsoft Edge" to return URL of active tab of front window',
  'Microsoft Edge Beta':
    'tell application "Microsoft Edge Beta" to return URL of active tab of front window',
  'Microsoft Edge Dev':
    'tell application "Microsoft Edge Dev" to return URL of active tab of front window',
  Arc: 'tell application "Arc" to return URL of active tab of front window',
  Vivaldi: 'tell application "Vivaldi" to return URL of active tab of front window',
  Chromium: 'tell application "Chromium" to return URL of active tab of front window',
  Opera: 'tell application "Opera" to return URL of active tab of front window',
  'Opera GX': 'tell application "Opera GX" to return URL of active tab of front window',
  Sidekick: 'tell application "Sidekick" to return URL of active tab of front window',
  // WebKit family
  Safari: 'tell application "Safari" to return URL of front document',
  'Safari Technology Preview':
    'tell application "Safari Technology Preview" to return URL of front document',
  Orion: 'tell application "Orion" to return URL of front document',
  'Orion RC': 'tell application "Orion RC" to return URL of front document',
};

const LOOKS_LIKE_BROWSER =
  /\b(?:browser|chrome|chromium|safari|edge|brave|firefox|mozilla|tor|opera|vivaldi|arc|orion|librewolf|floorp|zen|waterfox|mullvad)\b/i;

/**
 * Reduce an osascript failure to its meaningful one-line message. Node's
 * `execFile` rejection embeds the full command (and therefore the entire
 * AppleScript source) in `error.message`, which makes log lines unreadable.
 * osascript itself prints its real diagnostic to stderr in the form
 * `<line>:<col>: execution error: <message> (<code>)`; if we have it, that's
 * all the operator needs.
 */
function extractOsascriptError(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown; code?: unknown } | null;
  const stderr =
    typeof e?.stderr === 'string'
      ? e.stderr
      : Buffer.isBuffer(e?.stderr)
      ? e!.stderr.toString('utf8')
      : '';
  const match = stderr.match(/execution error:[^\n]*/);
  if (match) return match[0].trim();
  if (stderr.trim()) return stderr.trim().split('\n').pop()!.trim();
  if (typeof e?.code === 'string' && e.code) return `osascript ${e.code}`;
  if (typeof e?.message === 'string') {
    // Strip the "Command failed: osascript -e <huge script>" prefix.
    const m = e.message.match(/^Command failed:[^\n]*\n([\s\S]*)$/);
    return (m ? m[1] : e.message).trim().split('\n').pop()!.trim();
  }
  return String(err);
}

class NodeCapture implements ICapture {
  private readonly logger: Logger;
  private readonly config: Required<
    Omit<CaptureNodeConfig, 'privacy' | 'screens' | 'capture_mode' | 'accessibility'>
  > & {
    privacy: NonNullable<CaptureNodeConfig['privacy']>;
    raw_root: string;
    /** Optional whitelist of display indexes to capture in multi-screen mode. */
    screens: number[] | undefined;
    capture_mode: 'all' | 'active';
    accessibility: Required<NonNullable<CaptureNodeConfig['accessibility']>>;
  };
  private readonly handlers = new Set<RawEventHandler>();

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private paused = false;

  private readonly sessionId = newSessionId();
  private readonly startedAt = Date.now();

  private lastWindow: ActiveWindowInfo | null = null;
  private lastWindowEnteredAt = Date.now();
  private lastInteractionAt = Date.now();
  private idleNotified = false;
  /**
   * Per-display dedupe state. Always contains at least one entry (the
   * primary display, index 0) so the single-screen path stays a drop-in
   * for the previous flat fields. Populated for real after
   * `listDisplays()` resolves on first capture.
   */
  private displays: DisplayInfo[] = [
    { index: 0, id: null, name: null, rect: null, macOrdinal: null, lastHash: null, lastApp: null, lastShotAt: null },
  ];
  private displaysProbed = false;
  /**
   * Single-slot memoization of `resolveScreenIndex`. The active screen
   * almost never changes between ticks — typing/scrolling/clicking inside
   * the same window keeps `bounds` identical — so caching the last
   * `(bounds → index)` pair lets us skip the per-display rect arithmetic
   * on the common path. The math itself is cheap; the real value is that
   * downstream `displaysForTrigger()` becomes a pure lookup, which keeps
   * the hot path tighter and easier to reason about.
   *
   * Cache is automatically invalidated when bounds change (window moved
   * or resized) and when display geometry is re-probed (`probeDisplays`
   * resets it via `resetScreenCache`).
   */
  private lastBoundsKey: string | null = null;
  private lastResolvedScreen = 0;
  private eventsToday = 0;
  private storageBytesToday = 0;
  private lastDay = dayKey();

  // Loaded lazily — the libraries are ESM-incompatible / native and we only
  // want to pay the import cost when capture actually starts.
  // Typed as `unknown` because the export shape varies between CJS/ESM
  // and the public types don't match what dynamic import() returns.
  private screenshotMod: unknown = null;
  private activeWinMod: unknown = null;
  private activeWinFailed = false;
  private osascriptFallbackNotified = false;
  private osascriptErrorNotified = false;
  // One-time diagnostics for browser URL extraction. We don't want to spam
  // the log on every poll, but we also don't want users wondering why
  // `frame.url` is permanently null.
  private readonly unsupportedBrowserNotified = new Set<string>();
  private readonly browserPermissionDeniedNotified = new Set<string>();
  private readonly fixtureMode = FIXTURE_CAPTURE;

  /**
   * Native AX-text reader. Only present on macOS when the helper binary
   * built successfully; null otherwise. Treated as best-effort by the
   * capture path: if it returns null/empty, OCR fills in later.
   */
  private readonly axReader: AccessibilityTextReader | null;

  constructor(config: CaptureNodeConfig, logger: Logger) {
    this.logger = logger.child('capture-node');
    // Resolve format + quality with sensible back-compat. If the user has
    // an old config with `jpeg_quality` set but no new keys, honor it.
    const format = config.screenshot_format ?? 'webp';
    const explicitQuality = config.screenshot_quality;
    const fallbackQuality = format === 'jpeg' ? config.jpeg_quality : undefined;
    // Lower default than the historic 75 — for screen content (UI, text,
    // flat colors) the quality floor before visible artifacts is much
    // lower than for photographs. 55 cuts ~30-40% off file size with no
    // perceptible loss for OCR or human review.
    const quality =
      explicitQuality ?? fallbackQuality ?? (format === 'webp' ? 55 : 80);
    this.config = {
      poll_interval_ms: config.poll_interval_ms ?? 1500,
      screenshot_diff_threshold: config.screenshot_diff_threshold ?? 0.1,
      idle_threshold_sec: config.idle_threshold_sec ?? 60,
      screenshot_format: format,
      screenshot_quality: quality,
      screenshot_max_dim: config.screenshot_max_dim ?? 1280,
      content_change_min_interval_ms:
        config.content_change_min_interval_ms ?? 20_000,
      jpeg_quality: format === 'jpeg' ? quality : 80,
      excluded_apps: config.excluded_apps ?? [],
      excluded_url_patterns: config.excluded_url_patterns ?? [],
      capture_audio: config.capture_audio ?? false,
      whisper_model: config.whisper_model ?? 'base',
      raw_root: expandPath(config.raw_root ?? '~/.cofounderOS'),
      privacy: config.privacy ?? {
        blur_password_fields: true,
        pause_on_screen_lock: true,
        sensitive_keywords: ['password', 'api_key', 'secret'],
      },
      multi_screen: config.multi_screen ?? false,
      screens: config.screens,
      capture_mode: config.capture_mode ?? 'active',
      accessibility: {
        enabled: config.accessibility?.enabled ?? true,
        timeout_ms: config.accessibility?.timeout_ms ?? 1500,
        max_chars: config.accessibility?.max_chars ?? 8000,
        max_elements: config.accessibility?.max_elements ?? 4000,
        excluded_apps: config.accessibility?.excluded_apps ?? [],
      },
    };

    // Set up the AX reader only if the user hasn't disabled it. The
    // reader does its own platform / binary-presence check internally
    // and degrades to a no-op when either is missing.
    if (this.config.accessibility.enabled) {
      this.axReader = new AccessibilityTextReader({
        logger: this.logger,
        timeoutMs: this.config.accessibility.timeout_ms,
        maxChars: this.config.accessibility.max_chars,
        maxElements: this.config.accessibility.max_elements,
        excludedApps: [
          ...this.config.excluded_apps,
          ...this.config.accessibility.excluded_apps,
        ],
      });
      const status = this.axReader.getStatus();
      if (status.enabled) {
        this.logger.info(`accessibility text reader ready (${status.binary})`);
      }
    } else {
      this.axReader = null;
    }
  }

  onEvent(handler: RawEventHandler): void {
    this.handlers.add(handler);
  }

  getStatus(): CaptureStatus {
    return {
      running: this.running,
      paused: this.paused,
      eventsToday: this.eventsToday,
      storageBytesToday: this.storageBytesToday,
      cpuPercent: 0, // not measured in node MVP — Rust agent will fill this in
      memoryMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    };
  }

  getConfig(): CaptureConfig {
    return {
      pluginName: 'node',
      poll_interval_ms: this.config.poll_interval_ms,
      screenshot_diff_threshold: this.config.screenshot_diff_threshold,
      idle_threshold_sec: this.config.idle_threshold_sec,
      screenshot_format: this.config.screenshot_format,
      screenshot_quality: this.config.screenshot_quality,
      screenshot_max_dim: this.config.screenshot_max_dim,
      content_change_min_interval_ms: this.config.content_change_min_interval_ms,
      jpeg_quality: this.config.jpeg_quality,
      excluded_apps: this.config.excluded_apps,
      excluded_url_patterns: this.config.excluded_url_patterns,
      capture_audio: this.config.capture_audio,
      privacy: {
        blur_password_fields: this.config.privacy.blur_password_fields ?? true,
        pause_on_screen_lock: this.config.privacy.pause_on_screen_lock ?? true,
        sensitive_keywords: this.config.privacy.sensitive_keywords ?? [],
      },
      raw_root: this.config.raw_root,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.loadNativeMods();
    this.running = true;
    this.paused = false;

    // Emit an app_launch for the agent itself — useful as a session marker.
    await this.emit({
      type: 'app_launch',
      app: 'CofounderOS',
      app_bundle_id: 'os.cofounder.agent',
      window_title: 'capture-node started',
      url: null,
      content: null,
      asset_path: null,
      duration_ms: null,
      idle_before_ms: null,
      screen_index: 0,
      metadata: { session_id: this.sessionId },
    });

    this.scheduleNext();
    this.logger.info(`capture started (session ${this.sessionId})`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    // Final blur for whatever was last focused.
    if (this.lastWindow) {
      await this.emitBlur(this.lastWindow, Date.now() - this.lastWindowEnteredAt);
    }
    await this.emit({
      type: 'app_quit',
      app: 'CofounderOS',
      app_bundle_id: 'os.cofounder.agent',
      window_title: 'capture-node stopped',
      url: null,
      content: null,
      asset_path: null,
      duration_ms: Date.now() - this.startedAt,
      idle_before_ms: null,
      screen_index: 0,
      metadata: { session_id: this.sessionId },
    });
    this.logger.info('capture stopped');
  }

  async pause(): Promise<void> {
    this.paused = true;
    this.logger.info('capture paused');
  }

  async resume(): Promise<void> {
    this.paused = false;
    this.lastInteractionAt = Date.now(); // assume the user just touched something
    this.logger.info('capture resumed');
  }

  /**
   * Run a single capture cycle. Useful for the CLI `capture --once` so users
   * can sanity-check permissions before running the full background loop.
   */
  async tickOnce(): Promise<void> {
    await this.loadNativeMods();
    await this.tick();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void (async () => {
        try {
          if (!this.paused) await this.tick();
        } catch (err) {
          this.logger.error('tick failed', { err: String(err) });
        }
        this.scheduleNext();
      })();
    }, this.config.poll_interval_ms);
  }

  private async tick(): Promise<void> {
    this.rolloverDayIfNeeded();
    const win = await this.queryActiveWindow();
    if (!win) return;

    if (this.isExcluded(win)) {
      // Treat excluded apps as fully invisible — but still detect blur from
      // a previous non-excluded window so durations aren't lost.
      if (this.lastWindow && !this.isExcluded(this.lastWindow)) {
        await this.emitBlur(this.lastWindow, Date.now() - this.lastWindowEnteredAt);
      }
      this.lastWindow = win;
      this.lastWindowEnteredAt = Date.now();
      return;
    }

    const now = Date.now();
    let trigger: string | null = null;

    const focusChanged =
      !this.lastWindow ||
      this.lastWindow.app !== win.app ||
      this.lastWindow.title !== win.title;
    const urlChanged =
      this.lastWindow && this.lastWindow.url !== win.url && win.url !== null;

    if (focusChanged) {
      if (this.lastWindow) {
        await this.emitBlur(this.lastWindow, now - this.lastWindowEnteredAt);
      }
      await this.emit({
        type: 'window_focus',
        app: win.app,
        app_bundle_id: win.bundleId,
        window_title: win.title,
        url: win.url,
        content: null,
        asset_path: null,
        duration_ms: null,
        idle_before_ms: this.idleSince(),
        screen_index: win.screenIndex,
        metadata: { session_id: this.sessionId, pid: win.pid },
      });
      this.lastWindow = win;
      this.lastWindowEnteredAt = now;
      trigger = 'window_focus';
      this.lastInteractionAt = now;
    }

    if (urlChanged) {
      await this.emit({
        type: 'url_change',
        app: win.app,
        app_bundle_id: win.bundleId,
        window_title: win.title,
        url: win.url,
        content: null,
        asset_path: null,
        duration_ms: null,
        idle_before_ms: null,
        screen_index: win.screenIndex,
        metadata: { session_id: this.sessionId, previous_url: this.lastWindow?.url ?? null },
      });
      trigger = trigger ?? 'url_change';
      this.lastInteractionAt = now;
    }

    // Idle detection — using the last interaction we observed (focus/url
    // change / explicit resume). The Rust agent will replace this with a
    // proper OS-level CGEventSourceSecondsSinceLastEventType call.
    const idleSec = (now - this.lastInteractionAt) / 1000;
    if (!this.idleNotified && idleSec >= this.config.idle_threshold_sec) {
      this.idleNotified = true;
      await this.emit({
        type: 'idle_start',
        app: win.app,
        app_bundle_id: win.bundleId,
        window_title: win.title,
        url: win.url,
        content: null,
        asset_path: null,
        duration_ms: null,
        idle_before_ms: null,
        screen_index: win.screenIndex,
        metadata: { session_id: this.sessionId, threshold_sec: this.config.idle_threshold_sec },
      });
    } else if (this.idleNotified && idleSec < 1) {
      this.idleNotified = false;
      await this.emit({
        type: 'idle_end',
        app: win.app,
        app_bundle_id: win.bundleId,
        window_title: win.title,
        url: win.url,
        content: null,
        asset_path: null,
        duration_ms: Math.round((now - this.lastInteractionAt + idleSec * 1000)),
        idle_before_ms: Math.round(idleSec * 1000),
        screen_index: win.screenIndex,
        metadata: { session_id: this.sessionId },
      });
      trigger = trigger ?? 'idle_end';
    }

    // Skip screenshots while idle.
    if (this.idleNotified) return;

    // Periodically check for content change even when window/url didn't
    // change — e.g. scrolling to new content, modal opens.
    let perceptualTrigger = false;
    if (!trigger) {
      perceptualTrigger = await this.shouldShootForContentChange(win);
      if (perceptualTrigger) trigger = 'content_change';
    }

    if (trigger) {
      await this.captureScreenshot(win, trigger);
    }
  }

  private async loadNativeMods(): Promise<void> {
    if (this.fixtureMode) {
      await this.loadFixtureMods();
      return;
    }

    if (!this.activeWinMod && !this.activeWinFailed) {
      try {
        this.activeWinMod = await import('active-win');
      } catch (err) {
        this.activeWinFailed = true;
        const usingFallback = process.platform === 'darwin';
        this.logger.warn(
          'active-win unavailable; ' +
            (usingFallback
              ? 'falling back to osascript for window metadata (app + title only). '
              : 'window metadata will be a stub. ') +
            'On macOS grant Accessibility + Screen Recording permissions to your terminal. ' +
            'Tip: this often happens on Node >= 23 because active-win@9 ships only napi-v9 prebuilds — try Node 22 LTS.',
          { err: String(err) },
        );
      }
    }
    if (!this.screenshotMod) {
      try {
        this.screenshotMod = await import('screenshot-desktop');
      } catch (err) {
        this.logger.warn('screenshot-desktop unavailable; screenshots disabled', {
          err: String(err),
        });
      }
    }
    await this.probeDisplays();
  }

  /**
   * Headless capture fixture used by CI and smoke tests. It exercises the
   * same event/storage/image-encoding path as a real `capture --once`, but
   * avoids desktop APIs (`active-win`, `screenshot-desktop`, permissions,
   * X11/Wayland/Windows desktop sessions). Enable with:
   *
   *   COFOUNDEROS_CAPTURE_FIXTURE=1
   *
   * `COFOUNDEROS_FAKE_DISPLAYS=1` is accepted as a compatibility alias
   * because older spike docs used that name.
   */
  private async loadFixtureMods(): Promise<void> {
    if (!this.activeWinMod) {
      this.activeWinMod = async () => ({
        title: 'CofounderOS Capture Fixture',
        url: 'https://example.invalid/cofounderos-fixture',
        owner: {
          name: 'CofounderOS Fixture',
          bundleId: 'os.cofounder.fixture',
          processId: process.pid,
        },
        bounds: { x: 20, y: 20, width: 760, height: 520 },
      });
    }
    if (!this.screenshotMod) {
      const shot = Object.assign(
        async () => sharp({
          create: {
            width: 800,
            height: 600,
            channels: 3,
            background: { r: 32, g: 42, b: 56 },
          },
        })
          .composite([
            {
              input: Buffer.from(
                `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
                  <rect width="800" height="600" fill="#202a38"/>
                  <text x="48" y="84" fill="#e5eefc" font-family="Arial, sans-serif" font-size="34">
                    CofounderOS capture fixture
                  </text>
                  <text x="48" y="138" fill="#9fb3cc" font-family="Arial, sans-serif" font-size="22">
                    ${new Date().toISOString()}
                  </text>
                </svg>`,
              ),
            },
          ])
          .png()
          .toBuffer(),
        {
          listDisplays: async () => [
            {
              id: 'fixture-0',
              name: 'Fixture Display',
              left: 0,
              top: 0,
              width: 800,
              height: 600,
            },
          ],
        },
      );
      this.screenshotMod = shot;
      this.logger.info('capture fixture mode enabled (COFOUNDEROS_CAPTURE_FIXTURE=1)');
    }
    await this.probeDisplays();
  }

  /**
   * Probe attached displays via `screenshot.listDisplays()` and populate
   * `this.displays`. In single-screen mode we still call this once so the
   * log line confirms how many monitors the user has — useful when
   * debugging "I enabled multi_screen but only see one image".
   *
   * Failure to enumerate is non-fatal: we keep the default single-display
   * entry and continue. macOS' `system_profiler`-based enumeration can be
   * slow (~500ms) but only runs once.
   */
  private async probeDisplays(): Promise<void> {
    if (this.displaysProbed) return;
    this.displaysProbed = true;

    // macOS: prefer the JXA-based enumerator. It returns real rectangles
    // (`screenshot-desktop`'s `system_profiler` parser exposes none) AND
    // an ordinal that matches `screencapture -D`, which we use directly
    // for the actual pixel grab. This sidesteps two long-standing bugs
    // in `screenshot-desktop`'s darwin path: it never passes -D, and its
    // multi-shot-then-pick-by-index trick mis-attributes shots whenever
    // `screencapture`'s display order disagrees with `system_profiler`'s
    // (the typical case on multi-monitor setups, which is *exactly* the
    // bug users hit: filename right, pixels from the wrong display).
    if (process.platform === 'darwin') {
      const macDisplays = await this.enumerateMacDisplays();
      if (macDisplays && macDisplays.length > 0) {
        this.applyDisplaySelection(macDisplays);
        return;
      }
      this.logger.warn(
        'JXA display enumeration failed on macOS; falling back to system_profiler. ' +
          'Multi-monitor capture may attribute shots to the wrong display.',
      );
    }

    if (!this.screenshotMod) return;
    const ss = (this.screenshotMod as { default?: unknown }).default
      ?? (this.screenshotMod as unknown);
    const listFn = (ss as { listDisplays?: () => Promise<unknown[]> }).listDisplays;
    if (typeof listFn !== 'function') return;
    let raw: unknown[];
    try {
      raw = await listFn();
    } catch (err) {
      this.logger.warn('listDisplays() failed; falling back to single-display capture', {
        err: String(err),
      });
      return;
    }
    if (!Array.isArray(raw) || raw.length === 0) return;
    const all: DisplayInfo[] = raw.map((d, i) => {
      const obj = (d ?? {}) as Record<string, unknown>;
      // screenshot-desktop reports rect fields with slightly different
      // names on different platforms / versions. Probe both flat
      // (`top`/`left`/`width`/`height`) and nested (`bounds.{x,y,width,height}`)
      // shapes; if neither is present we leave rect=null and fall back
      // to capturing every display when capture_mode='active'.
      const flatLeft = obj.left ?? obj.x;
      const flatTop = obj.top ?? obj.y;
      const flatW = obj.width;
      const flatH = obj.height;
      const bounds = obj.bounds as Record<string, unknown> | undefined;
      let rect: DisplayInfo['rect'] = null;
      if (
        typeof flatLeft === 'number' &&
        typeof flatTop === 'number' &&
        typeof flatW === 'number' &&
        typeof flatH === 'number'
      ) {
        rect = { left: flatLeft, top: flatTop, width: flatW, height: flatH };
      } else if (bounds) {
        const bx = bounds.x ?? bounds.left;
        const by = bounds.y ?? bounds.top;
        const bw = bounds.width;
        const bh = bounds.height;
        if (
          typeof bx === 'number' &&
          typeof by === 'number' &&
          typeof bw === 'number' &&
          typeof bh === 'number'
        ) {
          rect = { left: bx, top: by, width: bw, height: bh };
        }
      }
      return {
        index: i,
        id: (obj.id as string | number | undefined) ?? null,
        name: (obj.name as string | undefined) ?? null,
        rect,
        macOrdinal: null,
        lastHash: null,
        lastApp: null,
        lastShotAt: null,
      };
    });

    this.applyDisplaySelection(all);
  }

  /**
   * Apply `multi_screen` / `screens` config against an enumerated set of
   * displays. Shared between the JXA-based macOS path and the
   * `screenshot-desktop` cross-platform fallback so both end up with the
   * same selection / logging / cache-invalidation behavior.
   */
  private applyDisplaySelection(all: DisplayInfo[]): void {
    if (this.config.multi_screen) {
      const wanted = this.config.screens;
      const selected = wanted
        ? all.filter((d) => wanted.includes(d.index))
        : all;
      if (selected.length === 0) {
        this.logger.warn(
          `multi_screen enabled but screens=${JSON.stringify(wanted)} matched no displays; ` +
            `falling back to display 0`,
        );
        this.displays = [all[0]!];
      } else {
        this.displays = selected;
      }
      this.logger.info(
        `multi_screen capture: ${this.displays.length}/${all.length} display(s) ` +
          `[mode=${this.config.capture_mode}]`,
        {
          displays: this.displays.map((d) => ({
            index: d.index,
            id: d.id,
            name: d.name,
            rect: d.rect,
            macOrdinal: d.macOrdinal,
          })),
        },
      );
      if (this.config.capture_mode === 'active' && this.displays.every((d) => d.rect === null)) {
        this.logger.warn(
          'capture_mode=active but no display rectangles were reported; ' +
            'cannot map active window to a screen — falling back to capturing all displays.',
        );
      }
    } else {
      // Single-screen: keep the default index-0 entry, but record metadata
      // so screenshot events can still report a meaningful screen_index.
      this.displays = [all[0]!];
      if (all.length > 1) {
        this.logger.info(
          `${all.length} displays detected; capturing only display 0. ` +
            `Set capture.multi_screen: true to record all of them.`,
        );
      }
    }
    // Display geometry just changed; previously cached bounds→screen
    // mappings are no longer valid.
    this.lastBoundsKey = null;
    this.lastResolvedScreen = 0;
  }

  /**
   * macOS-only: enumerate displays via JXA reading `NSScreen.screens`.
   * Returns one entry per display with proper rectangles (in the global
   * virtual coordinate space — same space `active-win`'s `bounds`
   * report) and a 1-based `macOrdinal` that maps directly to
   * `screencapture -D`. The first entry is always the main display, so
   * `macOrdinal: 1` is the primary screen, matching macOS conventions.
   *
   * Returns null if osascript or AppKit aren't available, or the script
   * fails for any reason — caller falls back to the cross-platform path.
   */
  private async enumerateMacDisplays(): Promise<DisplayInfo[] | null> {
    const script = `
      ObjC.import("AppKit");
      const screens = $.NSScreen.screens;
      const out = [];
      for (let i = 0; i < screens.count; i++) {
        const s = screens.objectAtIndex(i);
        const f = s.frame;
        out.push({
          x: f.origin.x,
          y: f.origin.y,
          w: f.size.width,
          h: f.size.height,
          name: (s.localizedName ? ObjC.unwrap(s.localizedName) : null)
        });
      }
      JSON.stringify(out)
    `;
    try {
      const { stdout } = await execFileP('osascript', ['-l', 'JavaScript', '-e', script], {
        timeout: 2000,
      });
      const parsed = JSON.parse(stdout.trim()) as Array<{
        x: number;
        y: number;
        w: number;
        h: number;
        name: string | null;
      }>;
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      // Coordinate-space conversion. NSScreen.frame uses AppKit's
      // bottom-left-origin, Y-up convention with the primary display's
      // bottom-left at (0, 0). But every consumer of `rect` (active-win
      // bounds, AppleScript `position of front window`) reports window
      // positions in the OS' top-left-origin, Y-down convention with
      // the primary display's top-left at (0, 0). Mixing them silently
      // breaks hit-testing for any secondary display positioned *above*
      // the primary (the secondary's NSScreen y is positive, but in
      // window-coord space it's negative). Convert here once so all
      // downstream rect math is in the same space windows live in.
      const primaryHeight = parsed[0]?.h ?? 0;
      return parsed.map((s, i) => {
        const topYDown = primaryHeight - (s.y + s.h);
        return {
          index: i,
          id: i, // diagnostic only — the real selector is macOrdinal
          name: s.name ?? null,
          rect: { left: s.x, top: topYDown, width: s.w, height: s.h },
          macOrdinal: i + 1, // `screencapture -D` is 1-based; -D 1 = main
          lastHash: null,
          lastApp: null,
          lastShotAt: null,
        };
      });
    } catch (err) {
      this.logger.debug('NSScreen JXA enumeration failed', { err: String(err) });
      return null;
    }
  }

  /**
   * Map a window rectangle (in global screen coordinates) to one of our
   * known displays. Uses majority-area overlap so a window straddling
   * two monitors is attributed to whichever screen contains most of it.
   * Falls back to center-point hit-test when overlaps are zero (can
   * happen during Mission Control transitions when bounds briefly land
   * off-screen). Returns 0 when no display has rect info — the caller
   * is expected to interpret that as "screen unknown" and bypass the
   * active-screen filter.
   */
  private resolveScreenIndex(win: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): number {
    if (
      typeof win.x !== 'number' ||
      typeof win.y !== 'number' ||
      typeof win.width !== 'number' ||
      typeof win.height !== 'number' ||
      win.width <= 0 ||
      win.height <= 0
    ) {
      return 0;
    }
    // Single-slot cache: identical bounds map to the identical screen
    // (display rects are immutable between probes). The vast majority of
    // ticks reuse the same focused window, so this skips the per-display
    // overlap math on the hot path.
    const key = `${win.x},${win.y},${win.width},${win.height}`;
    if (key === this.lastBoundsKey) return this.lastResolvedScreen;

    let resolved = 0;
    let bestArea = 0;
    for (const d of this.displays) {
      if (!d.rect) continue;
      const ix = Math.max(win.x, d.rect.left);
      const iy = Math.max(win.y, d.rect.top);
      const ax = Math.min(win.x + win.width, d.rect.left + d.rect.width);
      const ay = Math.min(win.y + win.height, d.rect.top + d.rect.height);
      const overlap = Math.max(0, ax - ix) * Math.max(0, ay - iy);
      if (overlap > bestArea) {
        bestArea = overlap;
        resolved = d.index;
      }
    }
    if (bestArea === 0) {
      // No overlap — try center point against each rect.
      const cx = win.x + win.width / 2;
      const cy = win.y + win.height / 2;
      for (const d of this.displays) {
        if (!d.rect) continue;
        if (
          cx >= d.rect.left &&
          cx < d.rect.left + d.rect.width &&
          cy >= d.rect.top &&
          cy < d.rect.top + d.rect.height
        ) {
          resolved = d.index;
          break;
        }
      }
    }

    this.lastBoundsKey = key;
    this.lastResolvedScreen = resolved;
    return resolved;
  }

  private async queryActiveWindow(): Promise<ActiveWindowInfo | null> {
    if (!this.activeWinMod) {
      if (process.platform === 'darwin') {
        const fallback = await this.queryActiveWindowOsascript();
        if (fallback) return fallback;
      }
      return {
        app: 'unknown',
        bundleId: 'unknown',
        title: 'unknown',
        url: null,
        screenIndex: 0,
        pid: null,
      };
    }
    try {
      const fn = (this.activeWinMod as { default?: () => Promise<unknown> }).default
        ?? (this.activeWinMod as unknown as () => Promise<unknown>);
      const win = (await (fn as () => Promise<Record<string, unknown> | undefined>)()) ?? undefined;
      if (!win) return null;
      const owner = (win.owner as Record<string, unknown> | undefined) ?? {};
      const url = typeof win.url === 'string' ? (win.url as string) : null;
      const bounds = (win.bounds as Record<string, unknown> | undefined) ?? {};
      const screenIndex = this.resolveScreenIndex({
        x: typeof bounds.x === 'number' ? (bounds.x as number) : undefined,
        y: typeof bounds.y === 'number' ? (bounds.y as number) : undefined,
        width: typeof bounds.width === 'number' ? (bounds.width as number) : undefined,
        height: typeof bounds.height === 'number' ? (bounds.height as number) : undefined,
      });
      return {
        app: (owner.name as string) ?? 'unknown',
        bundleId: (owner.bundleId as string) ?? (owner.path as string) ?? 'unknown',
        title: (win.title as string) ?? '',
        url,
        screenIndex,
        pid: typeof owner.processId === 'number' ? (owner.processId as number) : null,
      };
    } catch (err) {
      this.logger.debug('active-win query failed', { err: String(err) });
      return null;
    }
  }

  /**
   * macOS-only fallback when the `active-win` native binary fails to load
   * (e.g. Node ABI mismatch). Uses AppleScript via `osascript` to extract
   * the frontmost app, its bundle id, pid, the focused window title, and —
   * for Chrome / Safari / Arc / Brave / Edge — the active tab URL.
   *
   * Output format is a single line of NUL-separated fields:
   *   app \0 bundleId \0 pid \0 title \0 url
   * `url` may be empty.
   */
  private async queryActiveWindowOsascript(): Promise<ActiveWindowInfo | null> {
    if (!this.osascriptFallbackNotified) {
      this.logger.info('using osascript fallback for active window metadata');
      this.osascriptFallbackNotified = true;
    }
    // Also pulls the front window's position+size when available so the
    // capture loop can attribute it to a display in `capture_mode='active'`.
    // Fields are NUL-separated; position/size are space-separated pairs and
    // may be empty strings if AppleScript can't read them (e.g. fullscreen
    // Spaces, login window).
    //
    // The whole `tell System Events` block is wrapped in a try because
    // `first application process whose frontmost is true` transiently throws
    // error -1719 ("Invalid index") when there is no frontmost process at the
    // exact instant we query — common during Spaces switches, screen-lock
    // transitions, screensaver, login window, and wake-from-sleep. In those
    // cases we return all-empty fields and the JS side treats it as "no
    // active window right now", which is the correct semantic.
    const metaScript = `
      set sep to (ASCII character 0)
      set appName to ""
      set bid to ""
      set appPid to "0"
      set winTitle to ""
      set posStr to ""
      set sizeStr to ""
      try
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          set appPid to (unix id of frontApp) as text
          try
            set bid to bundle identifier of frontApp
          end try
          try
            set winTitle to name of front window of frontApp
          end try
          try
            set winPos to position of front window of frontApp
            set posStr to ((item 1 of winPos) as text) & " " & ((item 2 of winPos) as text)
          end try
          try
            set winSize to size of front window of frontApp
            set sizeStr to ((item 1 of winSize) as text) & " " & ((item 2 of winSize) as text)
          end try
        end tell
      end try
      return appName & sep & bid & sep & appPid & sep & winTitle & sep & posStr & sep & sizeStr
    `;
    try {
      const { stdout } = await execFileP('osascript', ['-e', metaScript], { timeout: 1500 });
      const parts = stdout.replace(/\n$/, '').split('\u0000');
      if (parts.length < 4) return null;
      const [app, bundleId, pidStr, title, posStr, sizeStr] = parts;
      // No frontmost process at this instant (transient: Spaces switch,
      // lock screen, screensaver, login window). Caller falls back to the
      // 'unknown' placeholder; we don't warn since this is expected.
      if (!app) return null;
      const pid = Number.parseInt(pidStr ?? '', 10);
      const url = await this.queryBrowserUrlOsascript(app);
      let screenIndex = 0;
      if (posStr && sizeStr) {
        const [pxStr, pyStr] = posStr.split(' ');
        const [pwStr, phStr] = sizeStr.split(' ');
        const px = Number.parseInt(pxStr ?? '', 10);
        const py = Number.parseInt(pyStr ?? '', 10);
        const pw = Number.parseInt(pwStr ?? '', 10);
        const ph = Number.parseInt(phStr ?? '', 10);
        if ([px, py, pw, ph].every(Number.isFinite)) {
          screenIndex = this.resolveScreenIndex({ x: px, y: py, width: pw, height: ph });
        }
      }
      return {
        app,
        bundleId: bundleId || 'unknown',
        title: title ?? '',
        url,
        screenIndex,
        pid: Number.isFinite(pid) ? pid : null,
      };
    } catch (err) {
      if (!this.osascriptErrorNotified) {
        this.osascriptErrorNotified = true;
        this.logger.warn('osascript active-window fallback failed (will retry silently)', {
          err: extractOsascriptError(err),
        });
      }
      return null;
    }
  }

  private async queryBrowserUrlOsascript(appName: string): Promise<string | null> {
    const script = BROWSER_URL_SCRIPTS[appName];
    if (!script) {
      // Unknown app — only warn if the name *looks* like a browser so we
      // don't emit noise for every focused window in a normal day. Firefox
      // and its forks land here because the Mozilla AppleScript dictionary
      // does not expose tab URLs; users on Firefox should expect null URLs
      // until the native capture agent ships.
      if (
        LOOKS_LIKE_BROWSER.test(appName) &&
        !this.unsupportedBrowserNotified.has(appName)
      ) {
        this.unsupportedBrowserNotified.add(appName);
        const isFirefoxFamily = /firefox|mozilla|tor browser|librewolf|waterfox|zen|floorp|mullvad/i.test(appName);
        this.logger.info(
          `URL extraction not supported for "${appName}"` +
            (isFirefoxFamily
              ? ' — Firefox and its forks do not expose tab URLs via AppleScript. ' +
                'URLs for these browsers will appear once the native capture agent (V2) ships.'
              : ' — add an entry to BROWSER_URL_SCRIPTS in capture-node to enable.'),
        );
      }
      return null;
    }
    try {
      const { stdout } = await execFileP('osascript', ['-e', script], { timeout: 1500 });
      const url = stdout.replace(/\n$/, '').trim();
      return url || null;
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      // -1743 = "Not authorized to send Apple events to <app>". This is the
      // most common silent failure: the user has never granted Automation
      // permission to the terminal / Cursor / electron host running us.
      // Surface it once with actionable instructions.
      if (
        stderr.includes('-1743') ||
        stderr.includes('not allowed assistive access') ||
        stderr.includes('Not authorized')
      ) {
        if (!this.browserPermissionDeniedNotified.has(appName)) {
          this.browserPermissionDeniedNotified.add(appName);
          this.logger.warn(
            `Automation permission denied for "${appName}". ` +
              `URL capture will return null until you grant access in ` +
              `System Settings → Privacy & Security → Automation → ` +
              `<host app> → enable "${appName}". Restart afterwards.`,
          );
        }
        return null;
      }
      // Other errors (app not running, no front window, etc.) are noisy
      // and self-resolving — debug-level only.
      this.logger.debug(`URL extraction for "${appName}" failed`, {
        err: stderr || String(err),
      });
      return null;
    }
  }

  /**
   * Capture a raw screenshot of a single display. Returns null on
   * failure. We intentionally keep this thin — every higher-level concern
   * (encoding, hashing, dedupe, emit) lives in the caller so it is shared
   * by both the trigger path and the perceptual-probe path.
   */
  private async grabRawForDisplay(display: DisplayInfo): Promise<Buffer | null> {
    // macOS: bypass `screenshot-desktop` whenever we have a real ordinal.
    // The library's darwin path doesn't pass `-D` to `screencapture` and
    // instead grabs every display then picks the Nth file by index, which
    // mis-attributes pixels whenever `screencapture`'s ordering disagrees
    // with `system_profiler`'s (the typical multi-monitor case).
    // Calling `screencapture -D <ordinal>` directly fixes the attribution.
    if (process.platform === 'darwin' && display.macOrdinal !== null) {
      return this.grabRawDarwin(display);
    }

    if (!this.screenshotMod) return null;
    const ss = (this.screenshotMod as { default?: unknown }).default
      ?? (this.screenshotMod as unknown);
    type ShotOpts = { format?: string; screen?: string | number };
    try {
      // Pass `screen` only when we actually have multiple displays
      // configured; this preserves the legacy "default display" behaviour
      // on single-screen setups where the index-0 entry may have a null id.
      const opts: ShotOpts = { format: 'jpg' };
      if (this.displays.length > 1 && display.id !== null) {
        opts.screen = display.id;
      }
      return (await (ss as (o?: ShotOpts) => Promise<Buffer>)(opts)) as Buffer;
    } catch (err) {
      this.logger.warn(
        `screenshot failed for display ${display.index}` +
          (display.name ? ` (${display.name})` : ''),
        { err: String(err) },
      );
      return null;
    }
  }

  /**
   * macOS-only: capture a single display via `screencapture -D <ordinal>`.
   * This is the *correct* way to address a specific display on macOS —
   * `-D 1` is the main display, `-D 2` the next, and so on. We write to
   * a tempfile (the `-x` flag suppresses the shutter sound) and read it
   * back as a Buffer to match the cross-platform contract.
   *
   * The 1.5s execFile timeout is generous: on a quiet machine
   * `screencapture` returns in <100ms, but Mission Control transitions
   * can briefly stall it. We never want to hold up the capture loop on
   * a wedged grab — the next tick will retry.
   */
  private async grabRawDarwin(display: DisplayInfo): Promise<Buffer | null> {
    const ord = display.macOrdinal;
    if (ord === null) return null;
    // Lazy import — `node:os` is cheap but keeping the imports section tidy
    // matters more than micro-optimizing the cold path.
    const { tmpdir } = await import('node:os');
    const tmpFile = path.join(
      tmpdir(),
      `cofounderos-shot-${process.pid}-${ord}-${Date.now()}.jpg`,
    );
    try {
      await execFileP(
        'screencapture',
        ['-x', '-t', 'jpg', `-D${ord}`, tmpFile],
        { timeout: 1500 },
      );
      const buf = await fs.readFile(tmpFile);
      return buf;
    } catch (err) {
      this.logger.warn(
        `screencapture -D${ord} failed for display ${display.index}` +
          (display.name ? ` (${display.name})` : ''),
        { err: String(err) },
      );
      return null;
    } finally {
      // Best-effort cleanup; tempdir gets purged regardless.
      fs.unlink(tmpFile).catch(() => undefined);
    }
  }

  private async captureScreenshot(win: ActiveWindowInfo, trigger: string): Promise<void> {
    if (!this.screenshotMod) return;
    for (const display of this.displaysForTrigger(win, trigger)) {
      await this.captureForDisplay(win, trigger, display);
    }
  }

  /**
   * Pick the displays to capture for a given trigger. In `capture_mode='all'`
   * (or single-screen setups) this is just every configured display.
   *
   * In `capture_mode='active'` we narrow to the display owning the active
   * window — but only when that's well-defined. Triggers that aren't tied
   * to a specific window (idle_end, no rect info on any display) fall back
   * to all displays so we don't silently lose frames. Same for the case
   * where the window's resolved screenIndex doesn't match any configured
   * display (e.g. user enabled `screens: [0]` but is working on display 1):
   * we'd rather record the whitelisted display than nothing.
   */
  private displaysForTrigger(win: ActiveWindowInfo, trigger: string): DisplayInfo[] {
    if (this.config.capture_mode !== 'active') return this.displays;
    if (this.displays.length <= 1) return this.displays;
    if (this.displays.every((d) => d.rect === null)) return this.displays;
    // Idle transitions aren't bound to a focused window; capture all to
    // match the previous semantics (a wake-up frame per monitor).
    if (trigger === 'idle_end') return this.displays;
    const match = this.displays.find((d) => d.index === win.screenIndex);
    return match ? [match] : this.displays;
  }

  private async captureForDisplay(
    win: ActiveWindowInfo,
    trigger: string,
    display: DisplayInfo,
  ): Promise<void> {
    const buf = await this.grabRawForDisplay(display);
    if (!buf) return;

    // Re-query the focused window *after* the screenshot grab. Several
    // hundred ms can elapse between the start of `tick()` and this point
    // (active-window query → optional perceptual probe grab → real grab),
    // and on a busy machine the user may have switched apps in that
    // window. We trust whatever was focused at the moment the pixels
    // were captured, since that's what the image actually reflects —
    // anything else produces filenames like `..._Finder.webp` for shots
    // showing Mail (the original bug). Falls back to the original
    // metadata when the re-query fails so we never drop a frame.
    const winAtCapture = (await this.queryActiveWindow()) ?? win;
    const effective: ActiveWindowInfo =
      winAtCapture.screenIndex === display.index ? winAtCapture : win;

    // Kick the AX-text query off in parallel with screenshot encoding —
    // both involve enough I/O that overlapping them shaves real wall-clock
    // time off the capture path. The promise resolves to `null` when the
    // reader is disabled or the app exposes nothing useful.
    const axPromise = effective.pid && this.axReader
      ? this.axReader.query({ pid: effective.pid, app: effective.app }).catch(() => null)
      : Promise.resolve(null);

    const compressed = await encodeScreenshot(
      buf,
      this.config.screenshot_format,
      this.config.screenshot_quality,
      this.config.screenshot_max_dim,
    );
    const phash = await dHash(compressed);
    const diff = display.lastHash ? hashDiff(display.lastHash, phash) : 1;

    if (
      display.lastApp === effective.app &&
      display.lastHash &&
      diff < this.config.screenshot_diff_threshold &&
      trigger !== 'window_focus' &&
      trigger !== 'url_change'
    ) {
      // Below the visual change threshold and not a hard trigger — skip.
      this.logger.debug(
        `skip screenshot (display ${display.index}, diff ${diff.toFixed(3)} < threshold)`,
      );
      return;
    }

    const day = dayKey();
    const tk = timeKey();
    const ext = this.config.screenshot_format === 'webp' ? 'webp' : 'jpg';
    // Suffix with the display index when capturing multiple monitors so two
    // simultaneous shots can't collide on the same `tk_app` filename.
    const screenSuffix = this.displays.length > 1 ? `_s${display.index}` : '';
    const filename = `${tk}_${SAFE_APP(effective.app)}${screenSuffix}.${ext}`;
    const relPath = path.join('raw', day, 'screenshots', filename);
    const absPath = path.join(this.config.raw_root, relPath);
    await ensureDir(path.dirname(absPath));
    await fs.writeFile(absPath, compressed);
    this.storageBytesToday += compressed.byteLength;

    display.lastHash = phash;
    display.lastApp = effective.app;
    display.lastShotAt = Date.now();

    // Await the AX query *after* the file write so we don't gate disk
    // IO on a slow accessibility tree walk.
    const axResult = await axPromise;

    const metadata: Record<string, unknown> = {
      session_id: this.sessionId,
      trigger,
      perceptual_hash: phash,
      hash_diff_from_previous: diff,
      bytes: compressed.byteLength,
      display_id: display.id,
      display_name: display.name,
    };
    if (effective !== win) {
      metadata.focus_app_at_trigger = win.app;
      metadata.focus_app_at_capture = effective.app;
    }
    if (axResult && axResult.text) {
      metadata.ax_text = axResult.text;
      metadata.ax_text_chars = axResult.text.length;
      metadata.ax_text_truncated = axResult.truncated;
      metadata.ax_text_duration_ms = axResult.durationMs;
    }

    await this.emit({
      type: 'screenshot',
      app: effective.app,
      app_bundle_id: effective.bundleId,
      window_title: effective.title,
      url: effective.url,
      content: null,
      asset_path: relPath,
      duration_ms: null,
      idle_before_ms: null,
      screen_index: display.index,
      metadata,
    });
  }

  private async shouldShootForContentChange(win: ActiveWindowInfo): Promise<boolean> {
    if (!this.screenshotMod) return false;
    // Any display whose content has changed enough is reason to fire — and
    // crucially, a display we haven't shot yet always counts as "changed".
    // We probe each display independently so a static external monitor
    // doesn't suppress capture of an active laptop screen, and vice versa.
    //
    // In `capture_mode='active'` we only probe the focused display. This
    // both saves work and avoids spurious 'content_change' triggers fired
    // by background monitors the user isn't looking at — exactly the noise
    // active mode is meant to suppress.
    const probeSet = this.displaysForTrigger(win, 'content_change');
    for (const display of probeSet) {
      if (await this.displayHasContentChange(display)) return true;
    }
    return false;
  }

  private async displayHasContentChange(display: DisplayInfo): Promise<boolean> {
    if (!display.lastHash) return true;
    // Time-floor: if we shot this display very recently, don't even
    // bother re-screenshotting it for a soft-trigger probe. This is
    // cheap and bypasses the expensive `screenshot-desktop` round trip
    // for a static screen between two polls.
    const floor = this.config.content_change_min_interval_ms;
    if (
      floor > 0 &&
      display.lastShotAt !== null &&
      Date.now() - display.lastShotAt < floor
    ) {
      return false;
    }
    const buf = await this.grabRawForDisplay(display);
    if (!buf) return false;
    try {
      // Hash directly off raw pixels — no need to JPEG-encode just to
      // throw the bytes away. dHash works on any sharp-compatible
      // input, so we hand it the original buffer; captureForDisplay
      // will redo the (resized + WebP) encode at full quality if this
      // returns true.
      const phash = await dHash(buf);
      const diff = hashDiff(display.lastHash, phash);
      return diff >= this.config.screenshot_diff_threshold;
    } catch {
      return false;
    }
  }

  private async emitBlur(win: ActiveWindowInfo, durationMs: number): Promise<void> {
    await this.emit({
      type: 'window_blur',
      app: win.app,
      app_bundle_id: win.bundleId,
      window_title: win.title,
      url: win.url,
      content: null,
      asset_path: null,
      duration_ms: durationMs,
      idle_before_ms: null,
      screen_index: win.screenIndex,
      metadata: { session_id: this.sessionId, duration_ms: durationMs },
    });
  }

  private idleSince(): number | null {
    const dt = Date.now() - this.lastInteractionAt;
    return dt > 5000 ? dt : null;
  }

  private rolloverDayIfNeeded(): void {
    const today = dayKey();
    if (today !== this.lastDay) {
      this.eventsToday = 0;
      this.storageBytesToday = 0;
      this.lastDay = today;
      for (const d of this.displays) {
        d.lastHash = null;
        d.lastApp = null;
        d.lastShotAt = null;
      }
    }
  }

  private isExcluded(win: ActiveWindowInfo): boolean {
    const appHit = this.config.excluded_apps.some(
      (e) =>
        win.app.toLowerCase().includes(e.toLowerCase()) ||
        win.bundleId.toLowerCase().includes(e.toLowerCase()),
    );
    if (appHit) return true;
    if (win.url) {
      const urlHit = this.config.excluded_url_patterns.some((pat) =>
        wildcardMatch(win.url ?? '', pat),
      );
      if (urlHit) return true;
    }
    return false;
  }

  private async emit(partial: Omit<RawEvent, 'id' | 'timestamp' | 'session_id' | 'privacy_filtered' | 'capture_plugin'>): Promise<void> {
    const event: RawEvent = {
      id: newEventId(),
      timestamp: isoTimestamp(),
      session_id: this.sessionId,
      privacy_filtered: false,
      capture_plugin: 'node',
      ...partial,
    };
    this.eventsToday += 1;
    for (const h of this.handlers) {
      try {
        await h(event);
      } catch (err) {
        this.logger.error('handler failed', { err: String(err), eventId: event.id });
      }
    }
  }
}

function wildcardMatch(haystack: string, pattern: string): boolean {
  // Convert simple "*.banking.com" style to regex.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(haystack);
}

const factory: PluginFactory<ICapture> = (ctx) => {
  return new NodeCapture(ctx.config as CaptureNodeConfig, ctx.logger);
};

export default factory;
export { NodeCapture };

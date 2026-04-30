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

interface CaptureNodeConfig {
  poll_interval_ms?: number;
  screenshot_diff_threshold?: number;
  idle_threshold_sec?: number;
  screenshot_format?: 'webp' | 'jpeg';
  screenshot_quality?: number;
  /** @deprecated kept for backward-compat with old config files. */
  jpeg_quality?: number;
  excluded_apps?: string[];
  excluded_url_patterns?: string[];
  capture_audio?: boolean;
  whisper_model?: string;
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
  lastHash: string | null;
  lastApp: string | null;
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
): Promise<Buffer> {
  if (format === 'webp') {
    return sharp(buf).webp({ quality }).toBuffer();
  }
  return sharp(buf).jpeg({ quality }).toBuffer();
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

class NodeCapture implements ICapture {
  private readonly logger: Logger;
  private readonly config: Required<Omit<CaptureNodeConfig, 'privacy' | 'screens'>> & {
    privacy: NonNullable<CaptureNodeConfig['privacy']>;
    raw_root: string;
    /** Optional whitelist of display indexes to capture in multi-screen mode. */
    screens: number[] | undefined;
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
    { index: 0, id: null, name: null, lastHash: null, lastApp: null },
  ];
  private displaysProbed = false;
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

  constructor(config: CaptureNodeConfig, logger: Logger) {
    this.logger = logger.child('capture-node');
    // Resolve format + quality with sensible back-compat. If the user has
    // an old config with `jpeg_quality` set but no new keys, honor it.
    const format = config.screenshot_format ?? 'webp';
    const explicitQuality = config.screenshot_quality;
    const fallbackQuality = format === 'jpeg' ? config.jpeg_quality : undefined;
    const quality =
      explicitQuality ?? fallbackQuality ?? (format === 'webp' ? 75 : 85);
    this.config = {
      poll_interval_ms: config.poll_interval_ms ?? 1500,
      screenshot_diff_threshold: config.screenshot_diff_threshold ?? 0.05,
      idle_threshold_sec: config.idle_threshold_sec ?? 60,
      screenshot_format: format,
      screenshot_quality: quality,
      jpeg_quality: format === 'jpeg' ? quality : 85,
      excluded_apps: config.excluded_apps ?? [],
      excluded_url_patterns: config.excluded_url_patterns ?? [],
      capture_audio: config.capture_audio ?? false,
      whisper_model: config.whisper_model ?? 'tiny',
      raw_root: expandPath(config.raw_root ?? '~/.cofounderOS'),
      privacy: config.privacy ?? {
        blur_password_fields: true,
        pause_on_screen_lock: true,
        sensitive_keywords: ['password', 'api_key', 'secret'],
      },
      multi_screen: config.multi_screen ?? false,
      screens: config.screens,
    };
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
      return {
        index: i,
        id: (obj.id as string | number | undefined) ?? null,
        name: (obj.name as string | undefined) ?? null,
        lastHash: null,
        lastApp: null,
      };
    });

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
        `multi_screen capture: ${this.displays.length}/${all.length} display(s)`,
        {
          displays: this.displays.map((d) => ({
            index: d.index,
            id: d.id,
            name: d.name,
          })),
        },
      );
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
      return {
        app: (owner.name as string) ?? 'unknown',
        bundleId: (owner.bundleId as string) ?? (owner.path as string) ?? 'unknown',
        title: (win.title as string) ?? '',
        url,
        screenIndex: 0,
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
    const metaScript = `
      set sep to (ASCII character 0)
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set appPid to unix id of frontApp
        try
          set bid to bundle identifier of frontApp
        on error
          set bid to ""
        end try
        try
          set winTitle to name of front window of frontApp
        on error
          set winTitle to ""
        end try
      end tell
      return appName & sep & bid & sep & (appPid as text) & sep & winTitle
    `;
    try {
      const { stdout } = await execFileP('osascript', ['-e', metaScript], { timeout: 1500 });
      const parts = stdout.replace(/\n$/, '').split('\u0000');
      if (parts.length < 4) return null;
      const [app, bundleId, pidStr, title] = parts;
      const pid = Number.parseInt(pidStr ?? '', 10);
      const url = await this.queryBrowserUrlOsascript(app ?? '');
      return {
        app: app || 'unknown',
        bundleId: bundleId || 'unknown',
        title: title ?? '',
        url,
        screenIndex: 0,
        pid: Number.isFinite(pid) ? pid : null,
      };
    } catch (err) {
      if (!this.osascriptErrorNotified) {
        this.osascriptErrorNotified = true;
        this.logger.warn('osascript active-window fallback failed (will retry silently)', {
          err: String(err),
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

  private async captureScreenshot(win: ActiveWindowInfo, trigger: string): Promise<void> {
    if (!this.screenshotMod) return;
    for (const display of this.displays) {
      await this.captureForDisplay(win, trigger, display);
    }
  }

  private async captureForDisplay(
    win: ActiveWindowInfo,
    trigger: string,
    display: DisplayInfo,
  ): Promise<void> {
    const buf = await this.grabRawForDisplay(display);
    if (!buf) return;

    const compressed = await encodeScreenshot(
      buf,
      this.config.screenshot_format,
      this.config.screenshot_quality,
    );
    const phash = await dHash(compressed);
    const diff = display.lastHash ? hashDiff(display.lastHash, phash) : 1;

    if (
      display.lastApp === win.app &&
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
    const filename = `${tk}_${SAFE_APP(win.app)}${screenSuffix}.${ext}`;
    const relPath = path.join('raw', day, 'screenshots', filename);
    const absPath = path.join(this.config.raw_root, relPath);
    await ensureDir(path.dirname(absPath));
    await fs.writeFile(absPath, compressed);
    this.storageBytesToday += compressed.byteLength;

    display.lastHash = phash;
    display.lastApp = win.app;

    await this.emit({
      type: 'screenshot',
      app: win.app,
      app_bundle_id: win.bundleId,
      window_title: win.title,
      url: win.url,
      content: null,
      asset_path: relPath,
      duration_ms: null,
      idle_before_ms: null,
      screen_index: display.index,
      metadata: {
        session_id: this.sessionId,
        trigger,
        perceptual_hash: phash,
        hash_diff_from_previous: diff,
        bytes: compressed.byteLength,
        display_id: display.id,
        display_name: display.name,
      },
    });
  }

  private async shouldShootForContentChange(win: ActiveWindowInfo): Promise<boolean> {
    if (!this.screenshotMod) return false;
    // Any display whose content has changed enough is reason to fire — and
    // crucially, a display we haven't shot yet always counts as "changed".
    // We probe each display independently so a static external monitor
    // doesn't suppress capture of an active laptop screen, and vice versa.
    for (const display of this.displays) {
      if (await this.displayHasContentChange(display)) return true;
    }
    return false;
  }

  private async displayHasContentChange(display: DisplayInfo): Promise<boolean> {
    if (!display.lastHash) return true;
    const buf = await this.grabRawForDisplay(display);
    if (!buf) return false;
    try {
      // Lowered-quality JPEG probe — we only want a fast hash, not a
      // usable image. captureForDisplay will redo the encode at full
      // quality if this returns true.
      const compressed = await sharp(buf).jpeg({ quality: 60 }).toBuffer();
      const phash = await dHash(compressed);
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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@beside/interfaces';

const execFileP = promisify(execFile);

/**
 * Accessibility-text reader for macOS.
 *
 * Spawns a small native Swift helper (`dist/native/axtext`) that uses
 * the AXUIElement APIs to extract the visible text of a given process's
 * focused window. The helper returns ~5-10kb of text in 100-1500ms for
 * typical apps — Slack, Mail, Notes, browsers, editors all expose rich
 * text via the AX tree.
 *
 * This is dramatically better than OCR for any app whose text lives in
 * a real text widget (Slack, Mail, Cursor, Notes, browser content,
 * Notion, Linear). It returns nothing useful for apps that draw their
 * own text into a canvas (Figma, fullscreen video). For those we fall
 * through to OCR exactly as before.
 *
 * Why native? AppleScript / osascript walking the AX tree is one
 * synchronous Apple-event round-trip per attribute access; Slack-sized
 * UIs take 5-15s. The same walk via AXUIElementCopyAttributeValue
 * direct calls is ~100x faster because there's no scripting layer.
 *
 * Failure modes (all degrade to "no AX text, OCR fills in later"):
 *  - swiftc missing at build time → binary not present → reader disabled
 *  - macOS Accessibility permission denied → reader disabled with a one-time warning
 *  - per-app failures (e.g. AX-disabled Electron) → silently empty
 *
 * Privacy: this reader runs through the same Accessibility permission
 * `active-win` already requires. Excluded apps (1Password, etc.) are
 * filtered upstream by the capture loop before we ever reach here.
 */

const MIN_USEFUL_CHARS = 8;

export interface AccessibilityReaderOptions {
  /** Hard timeout per query. Defaults to 1500ms (also passed to the binary). */
  timeoutMs?: number;
  /** Truncate the collected text at this many characters. Defaults to 8000. */
  maxChars?: number;
  /** Cap the AX-tree walk after this many elements. Defaults to 4000. */
  maxElements?: number;
  /**
   * Disable the reader after this many consecutive failures. Avoids
   * hammering the spawn machinery on systems where the AX permission
   * was denied. Defaults to 5.
   */
  failureBackoff?: number;
  /** Apps to skip (case-insensitive). */
  excludedApps?: string[];
  /** Override the binary path (mainly for tests). */
  binaryPathOverride?: string;
  logger: Logger;
}

export interface AccessibilityResult {
  /** Best-effort visible text. Empty string if nothing usable was found. */
  text: string;
  /** Total wall-clock cost of the query, including child-process spawn. */
  durationMs: number;
  /** True if `maxChars` clipped the output. */
  truncated: boolean;
}

export class AccessibilityTextReader {
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly maxChars: number;
  private readonly maxElements: number;
  private readonly failureBackoff: number;
  private readonly excludedAppsLower: Set<string>;
  private readonly binaryPath: string | null;

  private consecutiveFailures = 0;
  private permanentlyDisabled = false;
  private permanentlyDisabledReason: string | null = null;
  private permissionWarnedOnce = false;

  /** One-time per-app "this app doesn't expose AX" log throttle. */
  private readonly silentApps = new Set<string>();

  constructor(opts: AccessibilityReaderOptions) {
    this.logger = opts.logger.child('ax-text');
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.maxChars = opts.maxChars ?? 8000;
    this.maxElements = opts.maxElements ?? 4000;
    this.failureBackoff = opts.failureBackoff ?? 5;
    this.excludedAppsLower = new Set(
      (opts.excludedApps ?? []).map((s) => s.toLowerCase()),
    );
    this.binaryPath = opts.binaryPathOverride ?? resolveBinary();

    if (process.platform !== 'darwin') {
      this.disablePermanently('not_macos');
    } else if (!this.binaryPath) {
      this.disablePermanently('binary_missing');
      this.logger.info(
        'native AX helper not built (swiftc missing or build failed); accessibility text disabled — OCR will continue to fill in',
      );
    }
  }

  /**
   * Query the focused window's text. Returns null when the reader is
   * disabled, the app is excluded, or the platform isn't supported.
   * The caller treats null exactly like "no text was found", so OCR
   * still fires on the screenshot.
   */
  async query(opts: { pid: number; app: string }): Promise<AccessibilityResult | null> {
    if (this.permanentlyDisabled || !this.binaryPath) return null;
    if (!opts.pid || !Number.isFinite(opts.pid)) return null;
    if (this.excludedAppsLower.has(opts.app.toLowerCase())) return null;

    const t0 = Date.now();
    try {
      const { stdout } = await execFileP(
        this.binaryPath,
        [
          String(opts.pid),
          String(this.maxChars),
          String(this.maxElements),
          String(this.timeoutMs),
        ],
        {
          // Add a small slack on top of the binary's own deadline so we
          // don't kill the helper just as it's flushing stdout.
          timeout: this.timeoutMs + 500,
          maxBuffer: 4 * (this.maxChars + 1024),
        },
      );
      const text = stdout.replace(/[\u0000\r]+/g, '').trim();
      this.consecutiveFailures = 0;
      const durationMs = Date.now() - t0;
      if (text.length < MIN_USEFUL_CHARS) {
        if (!this.silentApps.has(opts.app)) {
          this.silentApps.add(opts.app);
          this.logger.debug(
            `accessibility text empty for ${opts.app} — falling back to OCR`,
          );
        }
        return { text: '', durationMs, truncated: false };
      }
      return {
        text,
        durationMs,
        truncated: text.length >= this.maxChars,
      };
    } catch (err) {
      const errStr = String(err);
      const exitCode = (err as { code?: number }).code;
      // The helper exits 1 on AX permission denial.
      if (exitCode === 1 || this.isPermissionDenied(errStr)) {
        if (!this.permissionWarnedOnce) {
          this.permissionWarnedOnce = true;
          this.logger.warn(
            'Accessibility permission denied — disabling AX text reader for this session. ' +
              'Grant access at System Settings → Privacy & Security → Accessibility, ' +
              'check the box next to your terminal/editor, then restart the agent.',
          );
        }
        this.disablePermanently('permission_denied');
        return null;
      }
      this.consecutiveFailures += 1;
      this.logger.debug(`ax-text query failed (${this.consecutiveFailures})`, {
        err: errStr,
        app: opts.app,
        pid: opts.pid,
      });
      if (this.consecutiveFailures >= this.failureBackoff) {
        this.disablePermanently('repeated_failures');
        this.logger.warn(
          `disabled AX text reader after ${this.consecutiveFailures} consecutive failures. ` +
            'Set capture.accessibility.enabled: false to silence this warning.',
        );
      }
      return null;
    }
  }

  isEnabled(): boolean {
    return !this.permanentlyDisabled && this.binaryPath !== null;
  }

  getStatus(): {
    enabled: boolean;
    binary: string | null;
    consecutiveFailures: number;
    disabledReason: string | null;
  } {
    return {
      enabled: this.isEnabled(),
      binary: this.binaryPath,
      consecutiveFailures: this.consecutiveFailures,
      disabledReason: this.permanentlyDisabledReason,
    };
  }

  private disablePermanently(reason: string): void {
    this.permanentlyDisabled = true;
    this.permanentlyDisabledReason = reason;
  }

  private isPermissionDenied(errStr: string): boolean {
    return (
      errStr.includes('-1743') ||
      errStr.includes('-25211') ||
      errStr.includes('not allowed assistive access') ||
      errStr.includes('not authorized')
    );
  }
}

/**
 * Locate the bundled `axtext` binary. We look in two places:
 *  1. `<plugin-dir>/dist/native/axtext` — the canonical location after
 *     `pnpm build:plugins` runs `scripts/build-native.sh`.
 *  2. Sibling of the running compiled JS (defensive in case the plugin
 *     is moved or the build script's output path drifts).
 *
 * Returns null when no binary exists or the platform isn't macOS.
 */
function resolveBinary(): string | null {
  if (process.platform !== 'darwin') return null;
  const candidates: string[] = [];
  try {
    // import.meta.url points at the compiled accessibility-text.js inside
    // the plugin's dist tree; the binary is two folders above + native/.
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, 'native/axtext'));
    candidates.push(path.resolve(here, '../native/axtext'));
    candidates.push(path.resolve(here, '../dist/native/axtext'));
    candidates.push(path.resolve(here, '../../dist/native/axtext'));
  } catch {
    // ignore — we'll fall through to "no binary"
  }
  for (const c of candidates) {
    try {
      const stat = fs.statSync(c);
      if (stat.isFile()) {
        // Make sure it's executable. CI builds sometimes drop the bit.
        try {
          fs.accessSync(c, fs.constants.X_OK);
        } catch {
          continue;
        }
        return c;
      }
    } catch {
      // not present, keep looking
    }
  }
  return null;
}

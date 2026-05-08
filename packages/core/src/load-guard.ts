import os from 'node:os';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Logger } from '@cofounderos/interfaces';

export interface LoadGuardConfig {
  enabled: boolean;
  threshold: number;
  max_consecutive_skips: number;
}

export interface PowerState {
  /** "ac" | "battery" | "unknown" — null when we couldn't read the source. */
  source: 'ac' | 'battery' | 'unknown';
  /** Battery percentage 0–100, or null when unknown / desktop without battery. */
  batteryPercent: number | null;
}

export interface LoadSnapshot {
  /** Raw 1-min load average from the OS. `null` on platforms that don't expose it (Windows). */
  loadavg1: number | null;
  /** Logical CPU count used to normalise the load average. */
  cpuCount: number;
  /** loadavg1 / cpuCount, or `null` if loadavg isn't available. */
  normalised: number | null;
  /** Power source + battery level. Used to defer heavy jobs when on battery + low. */
  power: PowerState;
}

export interface LoadGuardDecision {
  /** True if the caller should run the job. */
  proceed: boolean;
  /** Why we made this decision — used for status output and structured logs. */
  reason:
    | 'disabled'
    | 'unsupported-platform'
    | 'under-threshold'
    | 'forced-after-skips'
    | 'over-threshold'
    | 'on-battery-low';
  snapshot: LoadSnapshot;
}

/**
 * Battery percentage below which we defer heavy jobs while running on
 * battery. 25 leaves a comfortable buffer: the user can still expect
 * an hour or two of normal use before the OS starts warning, and our
 * heaviest jobs (OCR, embedding, full re-index) tend to run for
 * minutes when they fire — exactly when you don't want to be burning
 * battery on background work.
 */
const ON_BATTERY_LOW_PCT = 25;

/** Cache the power-source read briefly so we don't shell out per check. */
const POWER_CACHE_TTL_MS = 30_000;
let cachedPower: { value: PowerState; readAt: number } | null = null;

function readPowerStateRaw(): PowerState {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/bin/pmset', ['-g', 'batt'], {
        encoding: 'utf8',
        timeout: 1500,
      });
      // Sample lines:
      //   Now drawing from 'AC Power'
      //   Now drawing from 'Battery Power'
      //   -InternalBattery-0 (id=…)\t79%; charging; …
      const onBattery = /Now drawing from 'Battery Power'/i.test(out);
      const onAc = /Now drawing from 'AC Power'/i.test(out);
      const pctMatch = out.match(/(\d{1,3})%/);
      const pct = pctMatch ? Math.max(0, Math.min(100, parseInt(pctMatch[1]!, 10))) : null;
      return {
        source: onBattery ? 'battery' : onAc ? 'ac' : 'unknown',
        batteryPercent: pct,
      };
    } catch {
      return { source: 'unknown', batteryPercent: null };
    }
  }

  if (process.platform === 'linux') {
    try {
      // Try the standard sysfs entries — present on most distros.
      const baseDir = '/sys/class/power_supply';
      const entries = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name);
      let sawAc: boolean | null = null;
      let pct: number | null = null;
      for (const name of entries) {
        const dir = `${baseDir}/${name}`;
        let type = '';
        try { type = fs.readFileSync(`${dir}/type`, 'utf8').trim(); } catch {}
        if (type === 'Mains') {
          try {
            const online = fs.readFileSync(`${dir}/online`, 'utf8').trim();
            if (online === '1') sawAc = true;
            else if (online === '0' && sawAc !== true) sawAc = false;
          } catch {}
        } else if (type === 'Battery' && pct == null) {
          try {
            pct = parseInt(fs.readFileSync(`${dir}/capacity`, 'utf8').trim(), 10);
            if (!Number.isFinite(pct)) pct = null;
          } catch {}
        }
      }
      return {
        source: sawAc === true ? 'ac' : sawAc === false ? 'battery' : 'unknown',
        batteryPercent: pct,
      };
    } catch {
      return { source: 'unknown', batteryPercent: null };
    }
  }

  // Windows + everything else: no cheap reliable signal.
  return { source: 'unknown', batteryPercent: null };
}

function readPowerState(): PowerState {
  const now = Date.now();
  if (cachedPower && now - cachedPower.readAt < POWER_CACHE_TTL_MS) {
    return cachedPower.value;
  }
  const value = readPowerStateRaw();
  cachedPower = { value, readAt: now };
  return value;
}

/**
 * Per-job throttle that defers heavy work when the machine is busy.
 *
 * Signal: 1-minute load average normalised by CPU count (matches what
 * `uptime` and Activity Monitor surface). Crude but cheap, no extra
 * dependencies, and works the same way on macOS and Linux. Windows
 * returns zeros from `os.loadavg()` so we auto-pass there with a one-time
 * warn — the right Windows signal would be a perf counter, which is a
 * separate piece of work.
 *
 * Each job (incremental index, reorganise, vacuum) has its own counter so
 * one chronically-skipped job doesn't starve the others when we hit the
 * `max_consecutive_skips` safety valve.
 */
export class LoadGuard {
  private readonly cfg: LoadGuardConfig;
  private readonly logger: Logger;
  private readonly skipCounts = new Map<string, number>();
  private warnedUnsupported = false;

  constructor(cfg: LoadGuardConfig, logger: Logger) {
    this.cfg = cfg;
    this.logger = logger.child('load-guard');
  }

  snapshot(): LoadSnapshot {
    const cpuCount = Math.max(1, os.cpus().length);
    const [oneMin] = os.loadavg();
    // Windows: loadavg() returns [0, 0, 0]. Treat as "no signal" rather
    // than a flat 0% load — otherwise we'd never throttle on Windows
    // even though the API says we *can* see load there (it can't).
    const loadavg1 =
      typeof oneMin === 'number' && (oneMin > 0 || process.platform !== 'win32')
        ? oneMin
        : null;
    const normalised = loadavg1 == null ? null : loadavg1 / cpuCount;
    return { loadavg1, cpuCount, normalised, power: readPowerState() };
  }

  /**
   * Decide whether `jobName` should run right now. Updates the per-job
   * skip counter as a side effect so the safety valve works.
   */
  check(jobName: string): LoadGuardDecision {
    const snapshot = this.snapshot();

    if (!this.cfg.enabled) {
      this.skipCounts.set(jobName, 0);
      return { proceed: true, reason: 'disabled', snapshot };
    }

    // Battery brake: when the user is unplugged with low battery, defer
    // heavy jobs the same way we defer them when load is high. Same
    // per-job skip counter applies, so the safety valve still forces
    // a run after `max_consecutive_skips` deferrals — we never starve
    // a job indefinitely just because the laptop stayed unplugged.
    if (
      snapshot.power.source === 'battery' &&
      snapshot.power.batteryPercent != null &&
      snapshot.power.batteryPercent < ON_BATTERY_LOW_PCT
    ) {
      const skips = (this.skipCounts.get(jobName) ?? 0) + 1;
      if (skips > this.cfg.max_consecutive_skips) {
        this.skipCounts.set(jobName, 0);
        return { proceed: true, reason: 'forced-after-skips', snapshot };
      }
      this.skipCounts.set(jobName, skips);
      return { proceed: false, reason: 'on-battery-low', snapshot };
    }

    if (snapshot.normalised == null) {
      if (!this.warnedUnsupported) {
        this.warnedUnsupported = true;
        this.logger.warn(
          'load_guard enabled but this platform does not expose load average; guard will be a no-op',
        );
      }
      this.skipCounts.set(jobName, 0);
      return { proceed: true, reason: 'unsupported-platform', snapshot };
    }

    if (snapshot.normalised < this.cfg.threshold) {
      this.skipCounts.set(jobName, 0);
      return { proceed: true, reason: 'under-threshold', snapshot };
    }

    const skips = (this.skipCounts.get(jobName) ?? 0) + 1;
    if (skips > this.cfg.max_consecutive_skips) {
      this.skipCounts.set(jobName, 0);
      return { proceed: true, reason: 'forced-after-skips', snapshot };
    }
    this.skipCounts.set(jobName, skips);
    return { proceed: false, reason: 'over-threshold', snapshot };
  }
}

import os from 'node:os';
import type { Logger } from '@cofounderos/interfaces';

export interface LoadGuardConfig {
  enabled: boolean;
  threshold: number;
  max_consecutive_skips: number;
}

export interface LoadSnapshot {
  /** Raw 1-min load average from the OS. `null` on platforms that don't expose it (Windows). */
  loadavg1: number | null;
  /** Logical CPU count used to normalise the load average. */
  cpuCount: number;
  /** loadavg1 / cpuCount, or `null` if loadavg isn't available. */
  normalised: number | null;
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
    | 'over-threshold';
  snapshot: LoadSnapshot;
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
    return { loadavg1, cpuCount, normalised };
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

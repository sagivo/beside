import os from 'node:os';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Logger } from '@cofounderos/interfaces';

export interface LoadGuardConfig {
  enabled: boolean;
  threshold: number;
  max_consecutive_skips: number;
  low_battery_threshold_pct?: number;
  memory_threshold?: number;
}

export interface PowerState {
  /** "ac" | "battery" | "unknown" — unknown when we couldn't read the source. */
  source: 'ac' | 'battery' | 'unknown';
  /** Battery percentage 0–100, or null when unknown / desktop without battery. */
  batteryPercent: number | null;
}

export interface MemoryState {
  /** Total system memory in MiB. */
  totalMB: number;
  /** Best-effort free system memory in MiB. */
  freeMB: number;
  /** Approximate used/total ratio in [0, 1]. */
  usedRatio: number;
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
  /** Best-effort memory pressure snapshot. */
  memory: MemoryState;
}

export interface LoadGuardCheckOptions {
  /**
   * Require wall power before proceeding. `unknown` is treated as OK so
   * desktop machines and platforms without a battery API can still run
   * idle catch-up work.
   */
  requireAcPower?: boolean;
  /**
   * Whether the legacy max_consecutive_skips safety valve may force a
   * CPU-overload run. Low-battery and memory-pressure skips are never
   * forced.
   */
  allowForced?: boolean;
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
    | 'on-battery-low'
    | 'on-battery'
    | 'memory-pressure';
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
const DEFAULT_MEMORY_THRESHOLD = 0.9;

/** Cache the power-source read briefly so we don't shell out per check. */
const POWER_CACHE_TTL_MS = 30_000;
let cachedPower: { value: PowerState; readAt: number } | null = null;
const MEMORY_CACHE_TTL_MS = 10_000;
let cachedMemory: { value: MemoryState; readAt: number } | null = null;

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

function memoryStateFromBytes(totalBytes: number, availableBytes: number): MemoryState {
  const total = Math.max(1, totalBytes);
  const available = Math.max(0, Math.min(total, availableBytes));
  return {
    totalMB: Math.round(total / (1024 * 1024)),
    freeMB: Math.round(available / (1024 * 1024)),
    usedRatio: 1 - available / total,
  };
}

function readMemoryStateRaw(): MemoryState {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/bin/vm_stat', [], {
        encoding: 'utf8',
        timeout: 1500,
      });
      const pageSize = parseInt(out.match(/page size of (\d+) bytes/i)?.[1] ?? '', 10);
      const pages = (label: string): number => {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = out.match(new RegExp(`${escaped}:\\s+(\\d+)\\.`));
        return match ? parseInt(match[1]!, 10) : 0;
      };
      if (Number.isFinite(pageSize) && pageSize > 0) {
        // Inactive/speculative pages are reclaimable, so treating them
        // as unavailable would make healthy macOS systems look memory
        // pressured all the time.
        const availablePages =
          pages('Pages free') +
          pages('Pages inactive') +
          pages('Pages speculative');
        return memoryStateFromBytes(os.totalmem(), availablePages * pageSize);
      }
    } catch {
      // Fall back to Node's portable signal below.
    }
  }

  if (process.platform === 'linux') {
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const kb = (label: string): number | null => {
        const match = meminfo.match(new RegExp(`^${label}:\\s+(\\d+)\\s+kB`, 'm'));
        return match ? parseInt(match[1]!, 10) : null;
      };
      const totalKb = kb('MemTotal');
      const availableKb = kb('MemAvailable');
      if (totalKb != null && availableKb != null) {
        return memoryStateFromBytes(totalKb * 1024, availableKb * 1024);
      }
    } catch {
      // Fall back to Node's portable signal below.
    }
  }

  const totalBytes = Math.max(1, os.totalmem());
  const freeBytes = Math.max(0, Math.min(totalBytes, os.freemem()));
  return memoryStateFromBytes(totalBytes, freeBytes);
}

function readMemoryState(): MemoryState {
  const now = Date.now();
  if (cachedMemory && now - cachedMemory.readAt < MEMORY_CACHE_TTL_MS) {
    return cachedMemory.value;
  }
  const value = readMemoryStateRaw();
  cachedMemory = { value, readAt: now };
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
 * Each job has its own counter for the legacy CPU-only
 * `max_consecutive_skips` safety valve. Low-battery and memory-pressure
 * skips are hard deferrals, and the default config sets the CPU safety
 * valve to 0 so background work never forces itself onto a busy machine.
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
    return {
      loadavg1,
      cpuCount,
      normalised,
      power: readPowerState(),
      memory: readMemoryState(),
    };
  }

  /**
   * Decide whether `jobName` should run right now. Updates the per-job
   * skip counter as a side effect so the safety valve works.
   */
  check(
    jobName: string,
    opts: LoadGuardCheckOptions = {},
  ): LoadGuardDecision {
    const snapshot = this.snapshot();

    if (!this.cfg.enabled) {
      this.skipCounts.set(jobName, 0);
      return { proceed: true, reason: 'disabled', snapshot };
    }

    if (opts.requireAcPower && snapshot.power.source === 'battery') {
      this.skipCounts.set(jobName, 0);
      return { proceed: false, reason: 'on-battery', snapshot };
    }

    const lowBatteryThreshold =
      this.cfg.low_battery_threshold_pct ?? ON_BATTERY_LOW_PCT;
    // Battery brake: when the user is unplugged with low battery,
    // defer heavy jobs indefinitely. Capture/audio recording continues
    // elsewhere; this guard only stops derived compute such as OCR,
    // Whisper, embeddings, and indexing.
    if (
      lowBatteryThreshold > 0 &&
      snapshot.power.source === 'battery' &&
      snapshot.power.batteryPercent != null &&
      snapshot.power.batteryPercent < lowBatteryThreshold
    ) {
      this.skipCounts.set(jobName, 0);
      return { proceed: false, reason: 'on-battery-low', snapshot };
    }

    const memoryThreshold = this.cfg.memory_threshold ?? DEFAULT_MEMORY_THRESHOLD;
    if (memoryThreshold > 0 && snapshot.memory.usedRatio >= memoryThreshold) {
      this.skipCounts.set(jobName, 0);
      return { proceed: false, reason: 'memory-pressure', snapshot };
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
    const maxSkips = this.cfg.max_consecutive_skips ?? 0;
    const allowForced = opts.allowForced ?? maxSkips > 0;
    if (allowForced && maxSkips > 0 && skips > maxSkips) {
      this.skipCounts.set(jobName, 0);
      return { proceed: true, reason: 'forced-after-skips', snapshot };
    }
    this.skipCounts.set(jobName, skips);
    return { proceed: false, reason: 'over-threshold', snapshot };
  }
}

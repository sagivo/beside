import cronParser from 'cron-parser';
import type { Logger } from '@cofounderos/interfaces';

export interface TaskContext {
  trigger: 'schedule' | 'manual';
}

export type Task = (ctx?: TaskContext) => Promise<void>;

interface IntervalJob {
  kind: 'interval';
  name: string;
  intervalMs: number;
  task: Task;
  timer: NodeJS.Timeout | null;
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  skippedCount: number;
}

interface CronJob {
  kind: 'cron';
  name: string;
  expression: string;
  task: Task;
  timer: NodeJS.Timeout | null;
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  skippedCount: number;
}

type Job = IntervalJob | CronJob;

export interface SchedulerJobSnapshot {
  kind: Job['kind'];
  name: string;
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  skippedCount: number;
}

/**
 * Tiny scheduler. Two job kinds: fixed interval and cron expression. Each
 * job is single-flight — if a previous run is still in flight, the new
 * trigger is dropped (with a debug log).
 */
export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly logger: Logger;
  private stopped = false;

  constructor(logger: Logger) {
    this.logger = logger.child('scheduler');
  }

  every(name: string, intervalMs: number, task: Task): void {
    if (this.jobs.has(name)) {
      throw new Error(`Job "${name}" already scheduled`);
    }
    const job: IntervalJob = {
      kind: 'interval',
      name,
      intervalMs,
      task,
      timer: null,
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastDurationMs: null,
      lastError: null,
      runCount: 0,
      skippedCount: 0,
    };
    this.jobs.set(name, job);
    job.timer = setInterval(() => void this.run(job), intervalMs);
    this.logger.info(`scheduled "${name}" every ${intervalMs}ms`);
  }

  cron(name: string, expression: string, task: Task): void {
    if (this.jobs.has(name)) {
      throw new Error(`Job "${name}" already scheduled`);
    }
    // Validate up-front so config errors fail loudly.
    cronParser.parseExpression(expression);
    const job: CronJob = {
      kind: 'cron',
      name,
      expression,
      task,
      timer: null,
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastDurationMs: null,
      lastError: null,
      runCount: 0,
      skippedCount: 0,
    };
    this.jobs.set(name, job);
    this.scheduleNextCron(job);
    this.logger.info(`scheduled "${name}" with cron "${expression}"`);
  }

  /** Trigger a registered job immediately, out of band. */
  async runNow(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`No job named "${name}"`);
    await this.run(job, 'manual');
  }

  /**
   * Retune the cadence of an existing interval job. The current pending
   * tick is dropped (clearInterval) and a fresh timer is armed with the
   * new interval, so the next run lands `newMs` from now — callers using
   * this for back-off / catch-up should expect that "slow" transitions
   * don't fire immediately. Returns `false` if the job doesn't exist or
   * isn't an interval job. No-op if the interval is already `newMs`.
   */
  setIntervalMs(name: string, newMs: number): boolean {
    const job = this.jobs.get(name);
    if (!job || job.kind !== 'interval') return false;
    if (this.stopped) return false;
    if (!Number.isFinite(newMs) || newMs <= 0) return false;
    if (job.intervalMs === newMs) return true;
    if (job.timer) clearInterval(job.timer);
    job.intervalMs = newMs;
    job.timer = setInterval(() => void this.run(job), newMs);
    this.logger.debug(`retuned "${name}" to every ${newMs}ms`);
    return true;
  }

  /** Current interval, in ms, of an interval job (null if not an interval job). */
  getIntervalMs(name: string): number | null {
    const job = this.jobs.get(name);
    if (!job || job.kind !== 'interval') return null;
    return job.intervalMs;
  }

  has(name: string): boolean {
    return this.jobs.has(name);
  }

  getJobs(): SchedulerJobSnapshot[] {
    return Array.from(this.jobs.values()).map((job) => ({
      kind: job.kind,
      name: job.name,
      running: job.running,
      lastStartedAt: job.lastStartedAt,
      lastCompletedAt: job.lastCompletedAt,
      lastDurationMs: job.lastDurationMs,
      lastError: job.lastError,
      runCount: job.runCount,
      skippedCount: job.skippedCount,
    }));
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
    }
    this.jobs.clear();
  }

  private scheduleNextCron(job: CronJob): void {
    if (this.stopped) return;
    const interval = cronParser.parseExpression(job.expression);
    const next = interval.next().toDate();
    const delayMs = Math.max(1000, next.getTime() - Date.now());
    job.timer = setTimeout(() => {
      void (async () => {
        await this.run(job, 'schedule');
        this.scheduleNextCron(job);
      })();
    }, delayMs);
    this.logger.debug(`next "${job.name}" at ${next.toISOString()} (${delayMs}ms)`);
  }

  private async run(job: Job, trigger: TaskContext['trigger'] = 'schedule'): Promise<void> {
    if (job.running) {
      job.skippedCount += 1;
      this.logger.debug(`skip "${job.name}" — previous run still in flight`);
      return;
    }
    job.running = true;
    job.lastStartedAt = new Date().toISOString();
    const start = Date.now();
    try {
      await job.task({ trigger });
      const durationMs = Date.now() - start;
      job.lastDurationMs = durationMs;
      job.lastError = null;
      job.runCount += 1;
      if (durationMs >= 1000) {
        this.logger.info(`"${job.name}" completed in ${durationMs}ms`);
      } else {
        this.logger.debug(`"${job.name}" completed in ${durationMs}ms`);
      }
    } catch (err) {
      const durationMs = Date.now() - start;
      job.lastDurationMs = durationMs;
      job.lastError = String(err);
      job.runCount += 1;
      this.logger.error(`"${job.name}" failed after ${durationMs}ms`, { err: String(err) });
    } finally {
      job.running = false;
      job.lastCompletedAt = new Date().toISOString();
    }
  }
}

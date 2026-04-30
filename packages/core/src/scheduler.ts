import cronParser from 'cron-parser';
import type { Logger } from '@cofounderos/interfaces';

export type Task = () => Promise<void>;

interface IntervalJob {
  kind: 'interval';
  name: string;
  intervalMs: number;
  task: Task;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

interface CronJob {
  kind: 'cron';
  name: string;
  expression: string;
  task: Task;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

type Job = IntervalJob | CronJob;

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
    };
    this.jobs.set(name, job);
    this.scheduleNextCron(job);
    this.logger.info(`scheduled "${name}" with cron "${expression}"`);
  }

  /** Trigger a registered job immediately, out of band. */
  async runNow(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`No job named "${name}"`);
    await this.run(job);
  }

  has(name: string): boolean {
    return this.jobs.has(name);
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
        await this.run(job);
        this.scheduleNextCron(job);
      })();
    }, delayMs);
    this.logger.debug(`next "${job.name}" at ${next.toISOString()} (${delayMs}ms)`);
  }

  private async run(job: Job): Promise<void> {
    if (job.running) {
      this.logger.debug(`skip "${job.name}" — previous run still in flight`);
      return;
    }
    job.running = true;
    const start = Date.now();
    try {
      await job.task();
      this.logger.debug(`"${job.name}" completed in ${Date.now() - start}ms`);
    } catch (err) {
      this.logger.error(`"${job.name}" failed`, { err: String(err) });
    } finally {
      job.running = false;
    }
  }
}

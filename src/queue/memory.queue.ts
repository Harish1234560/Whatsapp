import { DEFAULT_QUEUE_OPTIONS, RetryableJobError, jobIdFor, type JobHandler, type QueueOptions, type SendJob, type SendQueue } from './queue.js';

interface Entry {
  job: SendJob;
  attempt: number;
}

/**
 * In-process queue for development, tests, and small single-server installs.
 * Jobs are not persisted, which is safe here: message rows are the source of
 * truth, and the recovery sweep re-enqueues anything still PENDING after a restart.
 */
export class MemoryQueue implements SendQueue {
  readonly kind = 'memory' as const;
  private opts: QueueOptions;
  private handler: JobHandler | null = null;
  private waiting: Entry[] = [];
  private known = new Set<string>(); // waiting, running, or sleeping before a retry
  private running = 0;
  private timers = new Set<NodeJS.Timeout>();
  private nextSlot = 0;
  private closed = false;
  private idleWaiters: (() => void)[] = [];
  onFinalFailure?: (job: SendJob, err: unknown) => void;

  constructor(opts: Partial<QueueOptions> = {}) {
    this.opts = { ...DEFAULT_QUEUE_OPTIONS, ...opts };
  }

  start(handler: JobHandler): void {
    this.handler = handler;
    this.pump();
  }

  async add(jobs: SendJob[]): Promise<void> {
    for (const job of jobs) {
      const id = jobIdFor(job);
      if (this.known.has(id)) continue; // duplicate job, dropped
      this.known.add(id);
      this.waiting.push({ job, attempt: 1 });
    }
    this.pump();
  }

  private pump(): void {
    if (!this.handler || this.closed) return;
    while (this.running < this.opts.concurrency && this.waiting.length) {
      const entry = this.waiting.shift()!;
      this.running++;
      const gap = 1000 / this.opts.ratePerSecond;
      const now = Date.now();
      const at = Math.max(now, this.nextSlot);
      this.nextSlot = at + gap;
      this.later(at - now, () => void this.run(entry));
    }
    this.checkIdle();
  }

  private async run(entry: Entry): Promise<void> {
    const id = jobIdFor(entry.job);
    try {
      await this.handler!(entry.job);
      this.known.delete(id);
    } catch (err) {
      if (err instanceof RetryableJobError && entry.attempt < this.opts.maxAttempts && !this.closed) {
        const delay = this.opts.backoffBaseMs * 2 ** (entry.attempt - 1);
        this.later(delay, () => {
          this.waiting.push({ job: entry.job, attempt: entry.attempt + 1 });
          this.pump();
        });
      } else {
        this.known.delete(id);
        this.onFinalFailure?.(entry.job, err);
      }
    } finally {
      this.running--;
      this.pump();
    }
  }

  private later(ms: number, fn: () => void): void {
    if (ms <= 0) {
      setImmediate(fn);
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private checkIdle(): void {
    if (this.known.size === 0 && this.running === 0 && this.waiting.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  drain(): Promise<void> {
    if (this.known.size === 0 && this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.waiting = [];
    this.known.clear();
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((w) => w());
  }
}

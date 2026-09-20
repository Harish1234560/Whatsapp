import { Queue, Worker, UnrecoverableError, type ConnectionOptions } from 'bullmq';
import { DEFAULT_QUEUE_OPTIONS, RetryableJobError, jobIdFor, type JobHandler, type QueueOptions, type SendJob, type SendQueue } from './queue.js';

const QUEUE_NAME = 'marketing-whatsapp-send';

function connectionFrom(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/** Production queue: BullMQ on Redis. Survives restarts and works across several servers. */
export class BullQueue implements SendQueue {
  readonly kind = 'bullmq' as const;
  private queue: Queue;
  private worker: Worker | null = null;
  private opts: QueueOptions;
  private connection: ConnectionOptions;

  constructor(redisUrl: string, opts: Partial<QueueOptions> = {}) {
    this.opts = { ...DEFAULT_QUEUE_OPTIONS, ...opts };
    this.connection = connectionFrom(redisUrl);
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
  }

  start(handler: JobHandler): void {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        try {
          await handler(job.data as SendJob);
        } catch (err) {
          if (err instanceof RetryableJobError) throw err; // BullMQ retries with backoff
          throw new UnrecoverableError((err as Error).message); // final, no retry
        }
      },
      {
        connection: this.connection,
        concurrency: this.opts.concurrency,
        limiter: { max: this.opts.ratePerSecond, duration: 1000 },
      },
    );
  }

  async add(jobs: SendJob[]): Promise<void> {
    if (!jobs.length) return;
    const CHUNK = 500;
    for (let i = 0; i < jobs.length; i += CHUNK) {
      await this.queue.addBulk(
        jobs.slice(i, i + CHUNK).map((data) => ({
          name: 'send',
          data,
          opts: {
            jobId: jobIdFor(data), // an identical id already in the queue is ignored
            attempts: this.opts.maxAttempts,
            backoff: { type: 'exponential', delay: this.opts.backoffBaseMs },
            removeOnComplete: { age: 3600, count: 5000 },
            removeOnFail: { age: 7 * 86400 },
          },
        })),
      );
    }
  }

  async drain(): Promise<void> {
    for (;;) {
      const c = await this.queue.getJobCounts('waiting', 'active', 'delayed');
      if ((c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0) === 0) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

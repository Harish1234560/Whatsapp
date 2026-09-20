export interface SendJob {
  messageId: number;
}

/** Thrown by the handler when the failure is safe to retry. Anything else is final. */
export class RetryableJobError extends Error {}

export type JobHandler = (job: SendJob) => Promise<void>;

/**
 * Every WhatsApp send goes through a queue: rate limited, retried with backoff,
 * and deduplicated by a deterministic job id. There is no send path without it.
 */
export interface SendQueue {
  readonly kind: 'memory' | 'bullmq';
  start(handler: JobHandler): void;
  add(jobs: SendJob[]): Promise<void>;
  /** Resolves when nothing is waiting or running. Used by tests and graceful shutdown. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export function jobIdFor(job: SendJob): string {
  // One message row exists per (campaign, customer), so this id is deterministic per recipient.
  return `msg-${job.messageId}`;
}

export interface QueueOptions {
  ratePerSecond: number;
  concurrency: number;
  maxAttempts: number;
  backoffBaseMs: number;
}

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  ratePerSecond: 20,
  concurrency: 5,
  maxAttempts: 5,
  backoffBaseMs: 2000,
};

import type { Env } from './config/env.js';
import type { SchemaMapping } from './config/schema-mapping.js';
import type { Db } from './db/db.js';
import type { SendQueue } from './queue/queue.js';
import type { WhatsAppProvider } from './whatsapp/whatsapp.types.js';

export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (m, e) => console.log(`[info] ${m}`, e ?? ''),
  warn: (m, e) => console.warn(`[warn] ${m}`, e ?? ''),
  error: (m, e) => console.error(`[error] ${m}`, e ?? ''),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Everything a service needs. Passed explicitly so tests can swap the clock, provider, and queue. */
export interface AppContext {
  env: Env;
  db: Db;
  mapping: SchemaMapping;
  queue: SendQueue;
  whatsapp: WhatsAppProvider;
  clock: () => Date;
  log: Logger;
  /** Random part of coupon codes. Replaceable in tests to force collisions. */
  randomCode: () => string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

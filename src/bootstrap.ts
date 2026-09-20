import type { Env } from './config/env.js';
import { loadMapping, type SchemaMapping } from './config/schema-mapping.js';
import { consoleLogger, type AppContext, type Logger } from './context.js';
import { randomCodePart } from './coupons/coupon.service.js';
import { createPgDb, createPgliteDb, type Db } from './db/db.js';
import { createFakeStoreTables } from './db/dev-store.js';
import { migrate } from './db/migrate.js';
import { BullQueue } from './queue/bullmq.queue.js';
import { MemoryQueue } from './queue/memory.queue.js';
import type { SendQueue } from './queue/queue.js';
import { ensureDefaultSettings } from './settings/settings.service.js';
import { MockWhatsAppProvider } from './whatsapp/whatsapp.mock.js';
import { CloudWhatsAppProvider } from './whatsapp/whatsapp.service.js';
import { ensureDefaultTemplates } from './whatsapp/whatsapp.template.js';
import type { WhatsAppProvider } from './whatsapp/whatsapp.types.js';

export interface BootstrapOptions {
  env: Env;
  mapping?: SchemaMapping;
  db?: Db;
  queue?: SendQueue;
  whatsapp?: WhatsAppProvider;
  clock?: () => Date;
  log?: Logger;
}

export async function bootstrap(opts: BootstrapOptions): Promise<AppContext> {
  const { env } = opts;
  const log = opts.log ?? consoleLogger;
  const mapping = opts.mapping ?? loadMapping(env.schemaMappingFile);

  let db = opts.db;
  const embedded = !db && !env.databaseUrl;
  if (!db) db = env.databaseUrl ? createPgDb(env.databaseUrl) : await createPgliteDb(env.pgliteDir);

  // The stand-in store tables exist only on the embedded database, never on a real one.
  if (embedded) await createFakeStoreTables(db);

  const applied = await migrate(db);
  if (applied.length) log.info(`Applied migrations: ${applied.join(', ')}`);
  await ensureDefaultSettings(db);
  // With the mock provider there is no Meta to approve anything, so templates start approved.
  await ensureDefaultTemplates(db, env.whatsappProvider === 'mock' && env.nodeEnv !== 'production');

  const whatsapp = opts.whatsapp ?? (env.whatsappProvider === 'cloud' ? new CloudWhatsAppProvider(env) : new MockWhatsAppProvider());
  const queue = opts.queue ?? (env.redisUrl ? new BullQueue(env.redisUrl, { ratePerSecond: env.sendRatePerSecond }) : new MemoryQueue({ ratePerSecond: env.sendRatePerSecond }));

  return {
    env,
    db,
    mapping,
    queue,
    whatsapp,
    clock: opts.clock ?? (() => new Date()),
    log,
    randomCode: () => randomCodePart(6),
  };
}

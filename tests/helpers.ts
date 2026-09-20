import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildServices, createApp, type Services } from '../src/app.js';
import { bootstrap } from '../src/bootstrap.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { loadMapping } from '../src/config/schema-mapping.js';
import { silentLogger, type AppContext } from '../src/context.js';
import { createPgliteDb } from '../src/db/db.js';
import { createFakeStoreTables, insertFakeOrder, insertFakeUser, optInFake, type FakeUser } from '../src/db/dev-store.js';
import { SendService } from '../src/messaging/send.service.js';
import { MemoryQueue } from '../src/queue/memory.queue.js';
import { istToUtc } from '../src/util/time.js';
import { MockWhatsAppProvider } from '../src/whatsapp/whatsapp.mock.js';

export const API_KEY = 'test-integration-key-0123456789';
export const APP_SECRET = 'test-app-secret';

export interface Harness {
  ctx: AppContext;
  services: Services;
  mock: MockWhatsAppProvider;
  sender: SendService;
  clock: { now: Date };
  /** Wait until every queued send has finished. */
  drain(): Promise<void>;
  http(): Promise<{ url: string; token: string; close(): Promise<void> }>;
  addCustomer(u: FakeUser & { optIn?: boolean }): Promise<void>;
  addOrder(o: { id: string; userId: string; amount: number; status?: string; createdAt: Date }): Promise<void>;
  close(): Promise<void>;
}

/** 19 September 2026, 10:00 in India. Inside the send window. */
export const DEFAULT_NOW = istToUtc(2026, 9, 19, 10, 0);

export async function makeHarness(opts: { now?: Date; env?: Partial<Env> } = {}): Promise<Harness> {
  const clock = { now: opts.now ?? DEFAULT_NOW };
  const env = loadEnv(
    { integrationApiKey: API_KEY, whatsappAppSecret: APP_SECRET, enableScheduler: false, sessionSecret: 'x'.repeat(40), ...opts.env },
    { NODE_ENV: 'test' },
  );
  const db = await createPgliteDb();
  await createFakeStoreTables(db);
  const mock = new MockWhatsAppProvider();
  const queue = new MemoryQueue({ ratePerSecond: 5000, backoffBaseMs: 5, concurrency: 5 });
  const ctx = await bootstrap({ env, db, mapping: loadMapping('schema-mapping.json'), queue, whatsapp: mock, clock: () => clock.now, log: silentLogger });
  const services = buildServices(ctx);
  const sender = new SendService(ctx);
  queue.start(sender.handler);

  let server: Server | null = null;

  return {
    ctx, services, mock, sender, clock,
    drain: () => queue.drain(),
    async http() {
      const app = createApp(ctx, services);
      server = app.listen(0);
      await new Promise((r) => server!.once('listening', r));
      const port = (server.address() as AddressInfo).port;
      return {
        url: `http://127.0.0.1:${port}`,
        token: services.auth.sign({ email: 'tester@example.com', source: 'local' }),
        close: () => new Promise<void>((r) => server!.close(() => r())),
      };
    },
    async addCustomer(u) {
      await insertFakeUser(db, u);
      if (u.optIn !== false) await optInFake(db, u.id, 'test');
    },
    addOrder: (o) => insertFakeOrder(db, o),
    async close() {
      if (server?.listening) await new Promise<void>((r) => server!.close(() => r()));
      await queue.close();
      await db.close();
    },
  };
}

let phoneCounter = 0;
/** A valid, unique Indian mobile number. */
export function phone(): string {
  phoneCounter++;
  return `98${String(10000000 + phoneCounter).padStart(8, '0')}`;
}

export const FESTIVAL = {
  name: 'Diwali 2026',
  festivalName: 'Diwali',
  startDate: '2026-10-15',
  endDate: '2026-10-25',
  discountType: 'PERCENT' as const,
  discountValue: 20,
};

export const TOP10 = {
  targetMonth: '2026-08',
  validUntil: '2026-10-15',
  discountType: 'FLAT' as const,
  discountValue: 2000,
};

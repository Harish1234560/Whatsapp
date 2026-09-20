import { loadEnv } from './config/env.js';
import { bootstrap } from './bootstrap.js';
import { buildServices, createApp } from './app.js';
import { seedFakeStore } from './db/dev-store.js';
import { SendService } from './messaging/send.service.js';
import { startScheduler } from './scheduler/scheduler.js';
import { MockWhatsAppProvider } from './whatsapp/whatsapp.mock.js';

async function main() {
  const env = loadEnv();
  const ctx = await bootstrap({ env });
  const services = buildServices(ctx);

  if (!env.databaseUrl) {
    const creds = await seedFakeStore(ctx.db, ctx.clock());
    ctx.log.warn('No DATABASE_URL set. Running on an embedded demo database with fake customers and orders.');
    ctx.log.info(`Demo sign-in: ${creds.adminEmail} / ${creds.adminPassword}`);
  }

  // In development the mock pretends Meta delivered and the customer read the message.
  if (ctx.whatsapp instanceof MockWhatsAppProvider) {
    ctx.whatsapp.onSent = (send) => {
      setTimeout(() => void services.webhook.applyStatus({ id: send.messageId, status: 'delivered' }).catch(() => undefined), 1500);
      if (Math.random() < 0.7) setTimeout(() => void services.webhook.applyStatus({ id: send.messageId, status: 'read' }).catch(() => undefined), 4000);
    };
  }

  ctx.queue.start(new SendService(ctx).handler);

  const app = createApp(ctx, services);
  const server = app.listen(env.port, () => {
    ctx.log.info(`Marketing backend listening on http://localhost:${env.port}`);
    ctx.log.info(`Dashboard: http://localhost:${env.port}/admin/marketing/`);
    ctx.log.info(`WhatsApp provider: ${ctx.whatsapp.name}. Queue: ${ctx.queue.kind}. Coupon mode: ${env.couponMode}.`);
  });

  const scheduler = env.enableScheduler ? startScheduler(ctx, services) : null;
  await scheduler?.runStartupTasks();

  const shutdown = async (signal: string) => {
    ctx.log.info(`${signal} received. Shutting down.`);
    scheduler?.stop();
    server.close();
    await ctx.queue.close().catch(() => undefined);
    await ctx.db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

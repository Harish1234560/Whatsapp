import cron, { type ScheduledTask } from 'node-cron';
import type { AppContext } from '../context.js';
import type { Services } from '../app.js';
import { SendService } from '../messaging/send.service.js';
import { IST_TZ_NAME } from '../util/time.js';

/**
 * Only the birthday campaign is ever started by a timer.
 * Festival and Top 10 campaigns have no scheduled trigger at all: an admin must approve them.
 */
export function startScheduler(ctx: AppContext, services: Services): { stop: () => void; runStartupTasks: () => Promise<void> } {
  const sender = new SendService(ctx);
  const tasks: ScheduledTask[] = [];
  const opts = { timezone: IST_TZ_NAME };

  const safely = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      const out = await fn();
      if (out && typeof out === 'object' && 'status' in (out as any)) ctx.log.info(`${name}: ${JSON.stringify(out)}`);
    } catch (err) {
      ctx.log.error(`${name} failed`, err);
    }
  };

  const birthdayJob = safely('birthday-run', () => services.birthday.run());

  // 9:00 India time every day, then an hourly catch-up in case the server was down at nine.
  // The job itself refuses to send outside the configured window, and reruns never duplicate.
  tasks.push(cron.schedule('0 9 * * *', birthdayJob, opts));
  tasks.push(cron.schedule('30 * * * *', birthdayJob, opts));

  // Housekeeping: release due batches of multi-day campaigns, close finished campaigns, expire and reconcile coupons.
  tasks.push(cron.schedule('*/5 * * * *', safely('send-sweep', async () => {
    await services.campaigns.resumeApproved();
    await sender.enqueueDue();
    await sender.completeFinished();
  }), opts));
  tasks.push(cron.schedule('*/15 * * * *', safely('coupon-housekeeping', async () => {
    await services.coupons.syncStoreUsage();
    await services.coupons.expireDue();
  }), opts));

  return {
    stop: () => tasks.forEach((t) => t.stop()),
    runStartupTasks: async () => {
      await safely('startup-resume', async () => {
        await services.campaigns.resumeApproved();
        await sender.enqueueDue();
      })();
      await birthdayJob();
    },
  };
}

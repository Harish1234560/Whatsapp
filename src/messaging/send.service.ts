import type { AppContext } from '../context.js';
import { CustomerRepo, assessContact } from '../customers/customer.repo.js';
import { CouponService } from '../coupons/coupon.service.js';
import { RetryableJobError, type SendJob } from '../queue/queue.js';
import { getBirthdaySettings } from '../settings/settings.service.js';
import { getTemplate } from '../whatsapp/whatsapp.template.js';
import { WhatsAppError } from '../whatsapp/whatsapp.types.js';
import type { MessageRow } from '../types.js';

const MAX_ATTEMPTS = 5;
const LOCK_MS = 2 * 60_000;

/**
 * The only code path that talks to WhatsApp for campaign messages.
 * Every guard runs again here, immediately before the send, because state can
 * change between generation, approval, and the moment a job is picked up.
 */
export class SendService {
  private customers: CustomerRepo;
  private coupons: CouponService;

  constructor(private ctx: AppContext) {
    this.customers = new CustomerRepo(ctx.mapping);
    this.coupons = new CouponService(ctx);
  }

  handler = async (job: SendJob): Promise<void> => {
    await this.processMessage(job.messageId);
  };

  async processMessage(messageId: number): Promise<void> {
    const { db } = this.ctx;
    const now = this.ctx.clock();

    // Claim the row. A second worker, a duplicate job, or a double click finds nothing to claim.
    const claim = await db.query<MessageRow>(
      `UPDATE marketing.messages
       SET attempts = attempts + 1, locked_until = $2
       WHERE id = $1 AND status = 'PENDING' AND whatsapp_message_id IS NULL
         AND (locked_until IS NULL OR locked_until < $3)
       RETURNING *`,
      [messageId, new Date(now.getTime() + LOCK_MS).toISOString(), now.toISOString()],
    );
    const msg = claim.rows[0];
    if (!msg) return;

    const campaign = (await db.query<{ status: string; type: string }>('SELECT status, type FROM marketing.campaigns WHERE id = $1', [msg.campaign_id])).rows[0];

    // Never send for a campaign that is a draft, awaiting approval, or cancelled.
    if (!campaign || campaign.status === 'CANCELLED') {
      await this.skip(msg, 'CAMPAIGN_CANCELLED', 'The campaign was cancelled before this message was sent.');
      return;
    }
    if (campaign.status !== 'SENDING') {
      await db.query('UPDATE marketing.messages SET locked_until = NULL, attempts = attempts - 1 WHERE id = $1', [msg.id]);
      return;
    }

    if (msg.campaign_type === 'BIRTHDAY' && !(await getBirthdaySettings(db)).enabled) {
      await this.skip(msg, 'BIRTHDAY_DISABLED', 'Birthday campaign was switched off.');
      return;
    }

    const template = await getTemplate(db, msg.template_name);
    if (!template || template.approvalStatus !== 'APPROVED') {
      await this.fail(msg, 'TEMPLATE_NOT_APPROVED', `Template "${msg.template_name}" is not approved by Meta.`);
      return;
    }

    // The customer may have opted out after the audience was generated.
    const customer = await this.customers.findById(db, msg.customer_id);
    const contact = customer ? assessContact(customer) : { contactable: false, reason: 'CUSTOMER_NOT_FOUND', phoneE164: null };
    if (!contact.contactable) {
      await this.skip(msg, contact.reason ?? 'NOT_CONTACTABLE', 'Customer was not contactable at send time.');
      return;
    }

    try {
      const result = await this.ctx.whatsapp.sendTemplate({
        to: msg.phone_number,
        templateName: msg.template_name,
        language: msg.template_language,
        bodyParams: msg.template_params,
      });
      await db.query(
        `UPDATE marketing.messages
         SET status = 'SENT', whatsapp_message_id = $2, sent_at = $3, locked_until = NULL, error_code = NULL, error_message = NULL
         WHERE id = $1 AND status = 'PENDING'`,
        [msg.id, result.messageId, this.ctx.clock().toISOString()],
      );
    } catch (err) {
      const e = err instanceof WhatsAppError ? err : new WhatsAppError('UNKNOWN', (err as Error).message, false);
      if (e.retryable && msg.attempts < MAX_ATTEMPTS) {
        await db.query(
          'UPDATE marketing.messages SET locked_until = NULL, error_code = $2, error_message = $3 WHERE id = $1',
          [msg.id, e.code, e.message.slice(0, 500)],
        );
        throw new RetryableJobError(`${e.code}: ${e.message}`);
      }
      await this.fail(msg, e.code, e.rawCode ? `[${e.rawCode}] ${e.message}` : e.message);
    } finally {
      await this.maybeComplete(msg.campaign_id);
    }
  }

  private async skip(msg: MessageRow, code: string, message: string): Promise<void> {
    await this.ctx.db.query(
      `UPDATE marketing.messages SET status = 'SKIPPED', error_code = $2, error_message = $3, locked_until = NULL
       WHERE id = $1 AND status = 'PENDING'`,
      [msg.id, code, message],
    );
    // A coupon nobody was told about should not stay redeemable.
    if (msg.coupon_id) await this.coupons.cancelOne(this.ctx.db, msg.coupon_id);
    await this.maybeComplete(msg.campaign_id);
  }

  private async fail(msg: MessageRow, code: string, message: string): Promise<void> {
    await this.ctx.db.query(
      `UPDATE marketing.messages SET status = 'FAILED', error_code = $2, error_message = $3, failed_at = $4, locked_until = NULL
       WHERE id = $1 AND status = 'PENDING'`,
      [msg.id, code, message.slice(0, 500), this.ctx.clock().toISOString()],
    );
    if (msg.coupon_id) await this.coupons.cancelOne(this.ctx.db, msg.coupon_id);
    this.ctx.log.warn(`Message ${msg.id} failed: ${code} ${message}`);
  }

  /** A campaign is complete when none of its messages are still pending. */
  async maybeComplete(campaignId: number): Promise<void> {
    await this.ctx.db.query(
      `UPDATE marketing.campaigns SET status = 'COMPLETED', completed_at = $2, updated_at = $2
       WHERE id = $1 AND status = 'SENDING' AND type <> 'BIRTHDAY'
         AND NOT EXISTS (SELECT 1 FROM marketing.messages WHERE campaign_id = $1 AND status = 'PENDING')`,
      [campaignId, this.ctx.clock().toISOString()],
    );
  }

  /** Sweep: closes campaigns whose last pending message was skipped outside the worker, such as by an opt-out. */
  async completeFinished(): Promise<void> {
    await this.ctx.db.query(
      `UPDATE marketing.campaigns c SET status = 'COMPLETED', completed_at = $1, updated_at = $1
       WHERE c.status = 'SENDING' AND c.type <> 'BIRTHDAY'
         AND NOT EXISTS (SELECT 1 FROM marketing.messages m WHERE m.campaign_id = c.id AND m.status = 'PENDING')`,
      [this.ctx.clock().toISOString()],
    );
  }

  /**
   * Put every due message on the queue. Runs after approval, on startup, and on a timer.
   * Safe to call at any time: job ids are deterministic and the claim above is atomic.
   */
  async enqueueDue(campaignId?: number): Promise<number> {
    const now = this.ctx.clock().toISOString();
    const params: unknown[] = [now];
    let filter = '';
    if (campaignId !== undefined) {
      params.push(campaignId);
      filter = 'AND m.campaign_id = $2';
    }
    const r = await this.ctx.db.query<{ id: number }>(
      `SELECT m.id FROM marketing.messages m
       JOIN marketing.campaigns c ON c.id = m.campaign_id
       WHERE m.status = 'PENDING' AND c.status = 'SENDING' ${filter}
         AND (m.scheduled_for IS NULL OR m.scheduled_for <= $1)
         AND (m.locked_until IS NULL OR m.locked_until < $1)
       ORDER BY m.id LIMIT 10000`,
      params,
    );
    await this.ctx.queue.add(r.rows.map((x) => ({ messageId: x.id })));
    return r.rows.length;
  }
}

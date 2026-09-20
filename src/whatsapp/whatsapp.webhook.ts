import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { audit } from '../audit/audit.js';
import { CouponService } from '../coupons/coupon.service.js';
import { CustomerRepo } from '../customers/customer.repo.js';
import { PreferenceService } from '../customers/preference.service.js';
import { last10, normalizePhone } from '../util/phone.js';
import { classifyMetaError } from './whatsapp.types.js';

/** Meta signs every webhook body with the app secret. Anything else is rejected. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

const OPT_OUT_WORDS = new Set([
  'stop', 'unsubscribe', 'stop promotions', 'opt out', 'optout', 'cancel',
  'रोकें', 'बंद करो', 'बंद', 'ఆపండి', 'ఆపు', 'நிறுத்து', 'ನಿಲ್ಲಿಸಿ', 'നിർത്തുക',
]);

export function isOptOutText(body: string | undefined | null): boolean {
  if (!body) return false;
  const t = body.trim().toLowerCase().replace(/[.!]+$/g, '');
  return OPT_OUT_WORDS.has(t);
}

export interface StatusUpdate {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  timestamp?: string;
  errors?: { code?: number; title?: string; message?: string }[];
}

export class WebhookService {
  private customers: CustomerRepo;
  private prefs: PreferenceService;
  private coupons: CouponService;

  constructor(private ctx: AppContext) {
    this.customers = new CustomerRepo(ctx.mapping);
    this.prefs = new PreferenceService(ctx);
    this.coupons = new CouponService(ctx);
  }

  async handlePayload(payload: any): Promise<{ statuses: number; inbound: number }> {
    let statuses = 0;
    let inbound = 0;
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        for (const s of value.statuses ?? []) {
          await this.applyStatus(s);
          statuses++;
        }
        for (const m of value.messages ?? []) {
          await this.handleInbound({ id: m.id, from: m.from, text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? null });
          inbound++;
        }
      }
    }
    return { statuses, inbound };
  }

  /** Statuses only move forward: sent, delivered, read. Late or repeated events never downgrade a message. */
  async applyStatus(s: StatusUpdate): Promise<boolean> {
    const at = s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : this.ctx.clock().toISOString();
    const db = this.ctx.db;
    let r;
    switch (s.status) {
      case 'sent':
        r = await db.query(
          `UPDATE marketing.messages SET sent_at = COALESCE(sent_at, $2) WHERE whatsapp_message_id = $1 AND status = 'SENT'`,
          [s.id, at],
        );
        break;
      case 'delivered':
        r = await db.query(
          `UPDATE marketing.messages SET status = 'DELIVERED', delivered_at = $2 WHERE whatsapp_message_id = $1 AND status = 'SENT'`,
          [s.id, at],
        );
        break;
      case 'read':
        r = await db.query(
          `UPDATE marketing.messages SET status = 'READ', read_at = $2, delivered_at = COALESCE(delivered_at, $2)
           WHERE whatsapp_message_id = $1 AND status IN ('SENT','DELIVERED')`,
          [s.id, at],
        );
        break;
      case 'failed': {
        const e = s.errors?.[0];
        const classified = classifyMetaError(e?.code, 400, e?.message ?? e?.title ?? 'Delivery failed');
        r = await db.query<{ coupon_id: number | null }>(
          `UPDATE marketing.messages SET status = 'FAILED', failed_at = $2, error_code = $3, error_message = $4
           WHERE whatsapp_message_id = $1 AND status = 'SENT' RETURNING coupon_id`,
          [s.id, at, classified.code, `[${e?.code ?? '?'}] ${classified.message}`.slice(0, 500)],
        );
        // The customer never saw the coupon, so it should not stay redeemable.
        for (const row of r.rows) if (row.coupon_id) await this.coupons.cancelOne(db, row.coupon_id);
        break;
      }
      default:
        return false;
    }
    return r.rowCount > 0;
  }

  async handleInbound(m: { id?: string; from: string; text: string | null }): Promise<void> {
    const db = this.ctx.db;
    const phone = normalizePhone(m.from.startsWith('+') ? m.from : `+${m.from}`) ?? `+${m.from}`;
    const optOut = isOptOutText(m.text);

    // Who is this? Prefer customers we actually messaged on that number, then the store's records.
    const ids = new Set<string>();
    const fromMessages = await db.query<{ customer_id: string }>('SELECT DISTINCT customer_id FROM marketing.messages WHERE phone_number = $1', [phone]);
    fromMessages.rows.forEach((r) => ids.add(r.customer_id));
    if (!ids.size) (await this.customers.findByPhoneLast10(db, last10(phone))).forEach((c) => ids.add(c.customerId));

    const stored = await db.query(
      `INSERT INTO marketing.inbound_messages (wa_message_id, from_phone, customer_id, body, is_opt_out)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`,
      [m.id ?? null, phone, [...ids][0] ?? null, m.text, optOut],
    );
    if (!stored.rows[0]) return; // webhook redelivery, already handled
    if (!optOut) return;

    let newlyOptedOut = false;
    for (const customerId of ids) {
      if (await this.prefs.optOut(customerId, 'whatsapp-reply')) newlyOptedOut = true;
    }
    await audit(db, `customer:${phone}`, 'OPT_OUT_BY_REPLY', 'customer', [...ids].join(',') || null, { text: m.text });

    // Confirm once. The customer just wrote to us, so free text is allowed.
    if (newlyOptedOut || !ids.size) {
      await this.ctx.whatsapp
        .sendText(phone, 'You have been unsubscribed from our promotional messages. You will not receive further offers on WhatsApp.')
        .catch((err) => this.ctx.log.warn('Could not send opt-out confirmation', err));
    }
  }
}

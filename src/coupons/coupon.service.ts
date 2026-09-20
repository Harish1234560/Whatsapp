import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import type { Queryable } from '../db/db.js';
import { q, qTable, readStoreTs, storeTs } from '../config/schema-mapping.js';
import { mapCoupon, type Coupon, type DiscountType } from '../types.js';

/** No 0, O, 1, I, or L, so codes survive being read aloud or typed from a phone. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_CODE_ATTEMPTS = 5;

export function randomCodePart(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

export function sanitizePrefix(raw: string): string {
  const p = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (p.length < 2) throw new HttpError(400, 'Coupon prefix needs at least 2 letters or digits.');
  return p;
}

export interface NewCoupon {
  campaignId: number;
  customerId: string | null;
  /** Random code is PREFIX-XXXXXX. Ignored when fixedCode is given. */
  prefix: string;
  /** A shared, admin-chosen code such as DIWALI20. */
  fixedCode?: string;
  discountType: DiscountType;
  discountValue: number;
  minimumOrderAmount: number | null;
  maximumDiscount: number | null;
  validFrom: Date;
  validUntil: Date;
  usageLimit: number;
  /** Copy into the store's coupon table right away (birthday). Campaigns publish at approval instead. */
  publishNow: boolean;
}

export type RejectReason =
  | 'NOT_FOUND' | 'WRONG_CUSTOMER' | 'USED' | 'EXPIRED' | 'CANCELLED' | 'NOT_STARTED'
  | 'BELOW_MINIMUM' | 'ALREADY_REDEEMED' | 'NOT_LIVE';

export interface ValidationResult {
  valid: boolean;
  reason?: RejectReason;
  discount?: number;
  coupon?: Coupon;
}

export function computeDiscount(c: Pick<Coupon, 'discountType' | 'discountValue' | 'maximumDiscount'>, orderAmount: number): number {
  let d = c.discountType === 'PERCENT' ? (orderAmount * c.discountValue) / 100 : c.discountValue;
  if (c.maximumDiscount !== null) d = Math.min(d, c.maximumDiscount);
  d = Math.min(d, orderAmount);
  return Math.round(d * 100) / 100;
}

class RedeemRejected extends Error {
  constructor(public reason: RejectReason) {
    super(reason);
  }
}

export class CouponService {
  constructor(private ctx: AppContext) {}

  private get usesStoreTable(): boolean {
    return this.ctx.env.couponMode === 'existing_table' && this.ctx.mapping.storeCoupons !== null;
  }

  /** Create one coupon. The unique index on code is the guarantee; on a collision we regenerate. */
  async create(tx: Queryable, input: NewCoupon): Promise<Coupon> {
    const attempts = input.fixedCode ? 1 : MAX_CODE_ATTEMPTS;
    for (let i = 0; i < attempts; i++) {
      const code = input.fixedCode ? input.fixedCode.toUpperCase() : `${sanitizePrefix(input.prefix)}-${this.ctx.randomCode()}`;

      if (this.usesStoreTable && (await this.existsInStore(tx, code))) continue;

      const r = await tx.query(
        `INSERT INTO marketing.coupons
           (code, customer_id, campaign_id, discount_type, discount_value, minimum_order_amount, maximum_discount,
            valid_from, valid_until, usage_limit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (code) DO NOTHING
         RETURNING *`,
        [code, input.customerId, input.campaignId, input.discountType, input.discountValue, input.minimumOrderAmount,
          input.maximumDiscount, input.validFrom.toISOString(), input.validUntil.toISOString(), input.usageLimit],
      );
      if (!r.rows[0]) continue; // code already taken, try another

      const coupon = mapCoupon(r.rows[0]);
      if (input.publishNow) await this.publish(tx, 'c.id = $1', [coupon.id]);
      return coupon;
    }
    if (input.fixedCode) throw new HttpError(409, `Coupon code "${input.fixedCode}" already exists.`);
    throw new Error(`Could not generate a unique coupon code after ${MAX_CODE_ATTEMPTS} attempts.`);
  }

  private async existsInStore(tx: Queryable, code: string): Promise<boolean> {
    const s = this.ctx.mapping.storeCoupons!;
    const r = await tx.query(`SELECT 1 FROM ${qTable(s.table)} WHERE ${q(s.code)} = $1 LIMIT 1`, [code]);
    return r.rows.length > 0;
  }

  /**
   * Copy marketing coupons into the store's own coupon table so the existing
   * checkout redeems them with no code change. One INSERT ... SELECT, idempotent.
   */
  private async publish(tx: Queryable, where: string, params: unknown[]): Promise<void> {
    if (!this.usesStoreTable) return;
    const s = this.ctx.mapping.storeCoupons!;
    const m = this.ctx.mapping;
    const cast = s.typeCast ? `::${s.typeCast}` : '';
    const ts = (expr: string) => (m.timestampStorage === 'utc_timestamp' ? `(${expr} AT TIME ZONE 'UTC')` : expr);

    const cols: string[] = [q(s.id), q(s.code), q(s.type), q(s.value)];
    const vals: string[] = [
      `'mkt_' || c.id::text`,
      'c.code',
      `(CASE c.discount_type WHEN 'FLAT' THEN '${s.typeValues.FLAT.replace(/'/g, "''")}' ELSE '${s.typeValues.PERCENT.replace(/'/g, "''")}' END)${cast}`,
      'c.discount_value',
    ];
    const optional: [string | null, string][] = [
      [s.minOrderAmount, 'c.minimum_order_amount'],
      [s.maxDiscount, 'c.maximum_discount'],
      [s.usageLimit, 'c.usage_limit'],
      [s.startsAt, ts('c.valid_from')],
      [s.expiresAt, ts('c.valid_until')],
      [s.isActive, 'TRUE'],
    ];
    for (const [col, expr] of optional) {
      if (col) {
        cols.push(q(col));
        vals.push(expr);
      }
    }

    await tx.query(
      `INSERT INTO ${qTable(s.table)} (${cols.join(', ')})
       SELECT ${vals.join(', ')} FROM marketing.coupons c
       WHERE ${where} AND c.in_store_table = FALSE AND c.status = 'ACTIVE'
       ON CONFLICT (${q(s.code)}) DO NOTHING`,
      params,
    );
    await tx.query(
      `UPDATE marketing.coupons c SET in_store_table = TRUE
       WHERE ${where} AND c.in_store_table = FALSE
         AND EXISTS (SELECT 1 FROM ${qTable(s.table)} s WHERE s.${q(s.code)} = c.code AND s.${q(s.id)} = 'mkt_' || c.id::text)`,
      params,
    );
  }

  /** Called at approval. Before this, campaign coupons are not redeemable anywhere. */
  async publishCampaign(tx: Queryable, campaignId: number): Promise<void> {
    await this.publish(tx, 'c.campaign_id = $1', [campaignId]);
  }

  /**
   * Cancel a campaign's unused coupons. A coupon whose message already reached
   * WhatsApp is kept: the customer was promised that discount.
   */
  async cancelForCampaign(tx: Queryable, campaignId: number): Promise<number> {
    const r = await tx.query<{ code: string; in_store_table: boolean }>(
      `UPDATE marketing.coupons c SET status = 'CANCELLED'
       WHERE c.campaign_id = $1 AND c.status = 'ACTIVE'
         AND NOT EXISTS (
           SELECT 1 FROM marketing.messages m
           WHERE m.coupon_id = c.id AND m.status IN ('SENT','DELIVERED','READ'))
       RETURNING c.code, c.in_store_table`,
      [campaignId],
    );
    await this.deactivateInStore(tx, r.rows.filter((x) => x.in_store_table).map((x) => x.code));
    return r.rowCount;
  }

  async cancelOne(tx: Queryable, couponId: number): Promise<void> {
    const r = await tx.query<{ code: string; in_store_table: boolean }>(
      `UPDATE marketing.coupons SET status = 'CANCELLED' WHERE id = $1 AND status = 'ACTIVE' AND customer_id IS NOT NULL
       RETURNING code, in_store_table`,
      [couponId],
    );
    await this.deactivateInStore(tx, r.rows.filter((x) => x.in_store_table).map((x) => x.code));
  }

  private async deactivateInStore(tx: Queryable, codes: string[]): Promise<void> {
    const s = this.ctx.mapping.storeCoupons;
    if (!this.usesStoreTable || !s || !codes.length) return;
    const set = s.isActive
      ? `${q(s.isActive)} = FALSE`
      : s.expiresAt
        ? `${q(s.expiresAt)} = ${storeTs(this.ctx.mapping, 'now()')}`
        : null;
    if (!set) return;
    await tx.query(`UPDATE ${qTable(s.table)} SET ${set} WHERE ${q(s.code)} = ANY($1::text[])`, [codes]);
  }

  /** Editing a campaign that was awaiting approval throws away everything generated for it. */
  async discardGenerated(tx: Queryable, campaignId: number): Promise<void> {
    await tx.query('DELETE FROM marketing.messages WHERE campaign_id = $1', [campaignId]);
    await tx.query('DELETE FROM marketing.campaign_recipients WHERE campaign_id = $1', [campaignId]);
    await tx.query('DELETE FROM marketing.coupons WHERE campaign_id = $1 AND in_store_table = FALSE', [campaignId]);
  }

  async expireDue(): Promise<number> {
    const r = await this.ctx.db.query(
      `UPDATE marketing.coupons SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND valid_until < $1`,
      [this.ctx.clock().toISOString()],
    );
    return r.rowCount;
  }

  /**
   * existing_table mode: the store redeems coupons itself and records the code on the order.
   * This reads those orders so "Coupons Used" stays accurate. Read-only on store tables.
   */
  async syncStoreUsage(): Promise<number> {
    const o = this.ctx.mapping.orders;
    if (!this.usesStoreTable || !o.couponCode) return 0;
    const r = await this.ctx.db.query(
      `WITH uses AS (
         SELECT c.id, COUNT(*)::int AS n, MIN(o.${q(o.id)}::text) AS order_id,
                MIN(${readStoreTs(this.ctx.mapping, `o.${q(o.date)}`)}) AS first_used
         FROM marketing.coupons c
         JOIN ${qTable(o.table)} o ON UPPER(o.${q(o.couponCode)}) = c.code
         WHERE c.status = 'ACTIVE' AND c.in_store_table
         GROUP BY c.id
       )
       UPDATE marketing.coupons c
       SET used_count = uses.n,
           used_at = uses.first_used,
           used_order_id = uses.order_id,
           status = CASE WHEN uses.n >= c.usage_limit THEN 'USED' ELSE c.status END
       FROM uses WHERE uses.id = c.id AND c.used_count <> uses.n`,
    );
    return r.rowCount;
  }

  // ─── api mode: the checkout calls these ────────────────────────────────────

  async validate(db: Queryable, code: string, customerId: string, orderAmount: number): Promise<ValidationResult> {
    const now = this.ctx.clock();
    const r = await db.query(
      `SELECT c.*, k.type AS campaign_type, k.status AS campaign_status
       FROM marketing.coupons c JOIN marketing.campaigns k ON k.id = c.campaign_id
       WHERE c.code = $1`,
      [code.trim().toUpperCase()],
    );
    const row = r.rows[0];
    if (!row) return { valid: false, reason: 'NOT_FOUND' };
    const coupon = mapCoupon(row);

    // A coupon bound to one customer works only for that customer.
    if (coupon.customerId !== null && coupon.customerId !== customerId) return { valid: false, reason: 'WRONG_CUSTOMER' };
    if (coupon.status === 'CANCELLED') return { valid: false, reason: 'CANCELLED' };
    if (coupon.status === 'USED' || coupon.usedCount >= coupon.usageLimit) return { valid: false, reason: 'USED' };
    if (coupon.status === 'EXPIRED' || now > coupon.validUntil) return { valid: false, reason: 'EXPIRED' };
    if (now < coupon.validFrom) return { valid: false, reason: 'NOT_STARTED' };
    // Coupons generated for a preview are not redeemable until the campaign is approved.
    if (row.campaign_type !== 'BIRTHDAY' && !['SENDING', 'COMPLETED'].includes(row.campaign_status)) {
      return { valid: false, reason: 'NOT_LIVE' };
    }
    if (coupon.minimumOrderAmount !== null && orderAmount < coupon.minimumOrderAmount) return { valid: false, reason: 'BELOW_MINIMUM' };

    const prior = await db.query('SELECT 1 FROM marketing.coupon_redemptions WHERE coupon_id = $1 AND customer_id = $2', [coupon.id, customerId]);
    if (prior.rows.length) return { valid: false, reason: 'ALREADY_REDEEMED' };

    return { valid: true, discount: computeDiscount(coupon, orderAmount), coupon };
  }

  /** Atomic. Two simultaneous redemptions of one coupon: exactly one succeeds. Same order retried: same answer. */
  async redeem(code: string, customerId: string, orderAmount: number, orderId: string): Promise<ValidationResult> {
    const now = this.ctx.clock();
    try {
      return await this.ctx.db.transaction(async (tx) => {
        const again = await tx.query(
          `SELECT r.discount, c.* FROM marketing.coupon_redemptions r JOIN marketing.coupons c ON c.id = r.coupon_id
           WHERE c.code = $1 AND r.customer_id = $2 AND r.order_id = $3`,
          [code.trim().toUpperCase(), customerId, orderId],
        );
        if (again.rows[0]) return { valid: true, discount: Number(again.rows[0].discount), coupon: mapCoupon(again.rows[0]) };

        const check = await this.validate(tx, code, customerId, orderAmount);
        if (!check.valid || !check.coupon) throw new RedeemRejected(check.reason ?? 'NOT_FOUND');

        const ins = await tx.query(
          `INSERT INTO marketing.coupon_redemptions (coupon_id, customer_id, order_id, discount, redeemed_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (coupon_id, customer_id) DO NOTHING RETURNING id`,
          [check.coupon.id, customerId, orderId, check.discount, now.toISOString()],
        );
        if (!ins.rows[0]) throw new RedeemRejected('ALREADY_REDEEMED');

        const upd = await tx.query(
          `UPDATE marketing.coupons
           SET used_count = used_count + 1,
               status = CASE WHEN used_count + 1 >= usage_limit THEN 'USED' ELSE status END,
               used_at = $2, used_order_id = $3
           WHERE id = $1 AND status = 'ACTIVE' AND used_count < usage_limit AND valid_from <= $2 AND valid_until >= $2
           RETURNING *`,
          [check.coupon.id, now.toISOString(), orderId],
        );
        if (!upd.rows[0]) throw new RedeemRejected('USED');
        return { valid: true, discount: check.discount, coupon: mapCoupon(upd.rows[0]) };
      });
    } catch (err) {
      if (err instanceof RedeemRejected) return { valid: false, reason: err.reason };
      throw err;
    }
  }
}

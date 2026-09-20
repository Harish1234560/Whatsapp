import type { AppContext } from '../context.js';
import { CouponService } from '../coupons/coupon.service.js';

/**
 * Consent lives in marketing.preferences. The store's users table is never altered.
 * No row, or opted_in = false, means the customer is NOT contacted.
 */
export class PreferenceService {
  private coupons: CouponService;

  constructor(private ctx: AppContext) {
    this.coupons = new CouponService(ctx);
  }

  async optIn(customerId: string, source: string): Promise<void> {
    const now = this.ctx.clock().toISOString();
    await this.ctx.db.query(
      `INSERT INTO marketing.preferences (customer_id, opted_in, opt_in_source, opted_in_at, updated_at)
       VALUES ($1, TRUE, $2, $3, $3)
       ON CONFLICT (customer_id) DO UPDATE
       SET opted_in = TRUE, opt_in_source = $2, opted_in_at = $3, opted_out_at = NULL, opt_out_source = NULL, updated_at = $3`,
      [customerId, source, now],
    );
  }

  async optInMany(customerIds: string[], source: string): Promise<number> {
    for (const id of customerIds) await this.optIn(id, source);
    return customerIds.length;
  }

  /** Returns true when this call is what opted the customer out. Pending messages stop immediately. */
  async optOut(customerId: string, source: string): Promise<boolean> {
    const now = this.ctx.clock().toISOString();
    const r = await this.ctx.db.query(
      `INSERT INTO marketing.preferences (customer_id, opted_in, opted_out_at, opt_out_source, updated_at)
       VALUES ($1, FALSE, $2, $3, $2)
       ON CONFLICT (customer_id) DO UPDATE
       SET opted_in = FALSE, opted_out_at = $2, opt_out_source = $3, updated_at = $2
       WHERE marketing.preferences.opted_out_at IS NULL
       RETURNING customer_id`,
      [customerId, now, source],
    );

    const stopped = await this.ctx.db.query<{ coupon_id: number | null }>(
      `UPDATE marketing.messages SET status = 'SKIPPED', error_code = 'OPTED_OUT', error_message = 'Customer opted out.', locked_until = NULL
       WHERE customer_id = $1 AND status = 'PENDING' RETURNING coupon_id`,
      [customerId],
    );
    for (const row of stopped.rows) if (row.coupon_id) await this.coupons.cancelOne(this.ctx.db, row.coupon_id);
    return r.rowCount > 0;
  }
}

import type { AppContext } from '../context.js';
import { audit, SYSTEM_ACTOR } from '../audit/audit.js';
import { CouponService } from '../coupons/coupon.service.js';
import { CustomerRepo, assessContact, firstName, isPlausibleDob, type StoreCustomer } from '../customers/customer.repo.js';
import { SendService } from '../messaging/send.service.js';
import { getBirthdaySettings, getGeneralSettings, type BirthdaySettings } from '../settings/settings.service.js';
import { discountText } from '../types.js';
import { endOfDayAfter, formatDateLong, isLeapYear, istParts, ymdOf } from '../util/time.js';
import { buildParams, getTemplate, renderBody } from '../whatsapp/whatsapp.template.js';

export interface BirthdayRunResult {
  status: 'OK' | 'DISABLED' | 'OUTSIDE_WINDOW' | 'TEMPLATE_NOT_APPROVED';
  date: string;
  found: number;
  queued: number;
  alreadyHandled: number;
  skipped: Record<string, number>;
}

class Duplicate extends Error {}

/**
 * Fully automatic. Runs every morning, on startup, and hourly as a catch-up.
 * Reruns are harmless: the unique index on (customer, year) lets only the first insert through.
 */
export class BirthdayService {
  private customers: CustomerRepo;
  private coupons: CouponService;
  private sender: SendService;

  constructor(private ctx: AppContext) {
    this.customers = new CustomerRepo(ctx.mapping);
    this.coupons = new CouponService(ctx);
    this.sender = new SendService(ctx);
  }

  /** Customers whose birthday is "today" in India. Feb 29 birthdays are celebrated on Feb 28 in non-leap years. */
  async todaysCustomers(now = this.ctx.clock()): Promise<StoreCustomer[]> {
    const p = istParts(now);
    const includeFeb29 = p.month === 2 && p.day === 28 && !isLeapYear(p.year);
    return this.customers.findBirthdays(this.ctx.db, p.month, p.day, includeFeb29);
  }

  async run(): Promise<BirthdayRunResult> {
    const { db } = this.ctx;
    const now = this.ctx.clock();
    const p = istParts(now);
    const result: BirthdayRunResult = { status: 'OK', date: ymdOf(now), found: 0, queued: 0, alreadyHandled: 0, skipped: {} };

    const settings = await getBirthdaySettings(db);
    if (!settings.enabled) return { ...result, status: 'DISABLED' };

    const general = await getGeneralSettings(db);
    if (p.hour < general.sendWindowStartHour || p.hour >= general.sendWindowEndHour) return { ...result, status: 'OUTSIDE_WINDOW' };

    // Checked before creating anything, so a late template approval does not cost customers their message.
    const template = await getTemplate(db, settings.templateName);
    if (!template || template.approvalStatus !== 'APPROVED') {
      this.ctx.log.warn(`Birthday run skipped: template "${settings.templateName}" is not approved.`);
      return { ...result, status: 'TEMPLATE_NOT_APPROVED' };
    }

    const campaignId = await this.ensureYearCampaign(p.year, settings);
    const people = await this.todaysCustomers(now);
    result.found = people.length;

    const bump = (reason: string) => (result.skipped[reason] = (result.skipped[reason] ?? 0) + 1);
    const messageIds: number[] = [];

    for (const c of people) {
      if (!isPlausibleDob(c.dob, now)) { bump('IMPLAUSIBLE_DOB'); continue; }
      const contact = assessContact(c);
      if (!contact.contactable || !contact.phoneE164) { bump(contact.reason ?? 'NOT_CONTACTABLE'); continue; }

      // The switch is re-read for every customer, so turning it off stops a run midway.
      if (!(await getBirthdaySettings(db)).enabled) { bump('BIRTHDAY_DISABLED'); continue; }

      const prior = await db.query(
        `SELECT 1 FROM marketing.messages WHERE customer_id = $1 AND campaign_year = $2 AND campaign_type = 'BIRTHDAY'`,
        [c.customerId, p.year],
      );
      if (prior.rows.length) { result.alreadyHandled++; continue; }

      try {
        const id = await db.transaction(async (tx) => {
          const coupon = await this.coupons.create(tx, {
            campaignId,
            customerId: c.customerId,
            prefix: settings.couponPrefix,
            discountType: settings.discountType,
            discountValue: settings.discountValue,
            minimumOrderAmount: settings.minimumOrderAmount,
            maximumDiscount: settings.maximumDiscount,
            validFrom: now,
            validUntil: endOfDayAfter(now, settings.validityDays),
            usageLimit: 1,
            publishNow: true,
          });
          const params = buildParams(template, {
            customer_name: firstName(c.name),
            discount_text: discountText(settings.discountType, settings.discountValue),
            coupon_code: coupon.code,
            expiry_date: formatDateLong(coupon.validUntil),
          });
          const ins = await tx.query<{ id: number }>(
            `INSERT INTO marketing.messages
               (campaign_id, campaign_type, campaign_year, customer_id, customer_name, phone_number, template_name,
                template_language, template_params, rendered_body, coupon_id, scheduled_for)
             VALUES ($1,'BIRTHDAY',$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
             ON CONFLICT DO NOTHING RETURNING id`,
            [campaignId, p.year, c.customerId, c.name, contact.phoneE164, template.name, template.language,
              JSON.stringify(params), renderBody(template, params), coupon.id, now.toISOString()],
          );
          // Lost a race with another run. Roll back so the spare coupon disappears too.
          if (!ins.rows[0]) throw new Duplicate();
          return ins.rows[0].id;
        });
        messageIds.push(id);
      } catch (err) {
        if (err instanceof Duplicate) { result.alreadyHandled++; continue; }
        this.ctx.log.error(`Birthday message for customer ${c.customerId} could not be prepared`, err);
        bump('ERROR');
      }
    }

    await this.ctx.queue.add(messageIds.map((messageId) => ({ messageId })));
    // Also picks up messages left pending by an earlier run that was interrupted.
    await this.sender.enqueueDue(campaignId);
    result.queued = messageIds.length;

    if (result.found > 0) await audit(db, SYSTEM_ACTOR, 'BIRTHDAY_RUN', 'campaign', campaignId, result);
    await db.query(
      `UPDATE marketing.campaigns SET target_count = (SELECT COUNT(*)::int FROM marketing.messages WHERE campaign_id = $1), updated_at = $2 WHERE id = $1`,
      [campaignId, now.toISOString()],
    );
    return result;
  }

  /** One campaign row per year groups that year's birthday messages and coupons. */
  private async ensureYearCampaign(year: number, s: BirthdaySettings): Promise<number> {
    await this.ctx.db.query(
      `INSERT INTO marketing.campaigns
         (name, type, status, campaign_year, discount_type, discount_value, minimum_order_amount, maximum_discount,
          coupon_prefix, template_name, created_by)
       VALUES ($1,'BIRTHDAY','SENDING',$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [`Birthday ${year}`, year, s.discountType, s.discountValue, s.minimumOrderAmount, s.maximumDiscount, s.couponPrefix, s.templateName, SYSTEM_ACTOR],
    );
    const r = await this.ctx.db.query<{ id: number }>(`SELECT id FROM marketing.campaigns WHERE type = 'BIRTHDAY' AND campaign_year = $1`, [year]);
    return r.rows[0].id;
  }

  /** For the dashboard: who has a birthday today and what happened to their message. */
  async todayOverview() {
    const now = this.ctx.clock();
    const p = istParts(now);
    const people = await this.todaysCustomers(now);
    const sent = await this.ctx.db.query<{ customer_id: string; status: string; code: string | null }>(
      `SELECT m.customer_id, m.status, k.code FROM marketing.messages m LEFT JOIN marketing.coupons k ON k.id = m.coupon_id
       WHERE m.campaign_type = 'BIRTHDAY' AND m.campaign_year = $1`,
      [p.year],
    );
    const byCustomer = new Map(sent.rows.map((r) => [r.customer_id, r]));
    return people.map((c) => {
      const contact = assessContact(c);
      const m = byCustomer.get(c.customerId);
      return {
        customerId: c.customerId,
        name: c.name,
        phone: contact.phoneE164 ?? c.phone,
        eligible: contact.contactable && isPlausibleDob(c.dob, now),
        reason: !isPlausibleDob(c.dob, now) ? 'IMPLAUSIBLE_DOB' : contact.reason,
        messageStatus: m?.status ?? null,
        couponCode: m?.code ?? null,
      };
    });
  }
}

import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { audit } from '../audit/audit.js';
import { CouponService, sanitizePrefix } from '../coupons/coupon.service.js';
import { CustomerRepo, assessContact, firstName, type StoreCustomer } from '../customers/customer.repo.js';
import { isUniqueViolation, type Queryable } from '../db/db.js';
import { SendService } from '../messaging/send.service.js';
import { getGeneralSettings } from '../settings/settings.service.js';
import { discountText, mapCampaign, type Campaign } from '../types.js';
import { formatDateLong, istEndOfDay, istMonthRange, istParts, istStartOfDay, istToUtc, monthLabel, parseYmd } from '../util/time.js';
import { buildParams, getTemplate, renderBody, type Template, type TemplateValues } from '../whatsapp/whatsapp.template.js';

const money = z.number().nonnegative().nullable().optional();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const discountFields = {
  discountType: z.enum(['FLAT', 'PERCENT']),
  discountValue: z.number().positive(),
  minimumOrderAmount: money,
  maximumDiscount: money,
};

export const festivalInput = z.object({
  name: z.string().trim().min(2).max(120),
  festivalName: z.string().trim().min(2).max(60),
  startDate: ymd,
  endDate: ymd,
  ...discountFields,
  couponMode: z.enum(['PER_CUSTOMER', 'SHARED']).default('PER_CUSTOMER'),
  sharedCouponCode: z.string().trim().regex(/^[A-Za-z0-9-]{4,30}$/).nullable().optional(),
  sharedUsageCap: z.number().int().positive().nullable().optional(),
  couponPrefix: z.string().trim().max(20).optional(),
  templateName: z.string().trim().default('festival_offer'),
});

export const top10Input = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  targetMonth: z.string().regex(/^\d{4}-\d{2}$/),
  validUntil: ymd,
  ...discountFields,
  couponPrefix: z.string().trim().max(20).optional(),
  backfill: z.boolean().default(false),
  templateName: z.string().trim().default('top10_reward'),
});

export type FestivalInput = z.input<typeof festivalInput>;
export type Top10Input = z.input<typeof top10Input>;

const TOP_N = 10;
const EDITABLE = ['DRAFT', 'PENDING_APPROVAL', 'FAILED'];
const CANCELLABLE = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENDING', 'FAILED'];

export class CampaignService {
  private customers: CustomerRepo;
  private coupons: CouponService;
  private sender: SendService;

  constructor(private ctx: AppContext) {
    this.customers = new CustomerRepo(ctx.mapping);
    this.coupons = new CouponService(ctx);
    this.sender = new SendService(ctx);
  }

  // ─── read ─────────────────────────────────────────────────────────────────

  async get(id: number, db: Queryable = this.ctx.db): Promise<Campaign> {
    const r = await db.query('SELECT * FROM marketing.campaigns WHERE id = $1', [id]);
    if (!r.rows[0]) throw new HttpError(404, 'Campaign not found.');
    return mapCampaign(r.rows[0]);
  }

  async list(type?: string): Promise<(Campaign & { stats: Record<string, number> })[]> {
    const params: unknown[] = [];
    let where = '';
    if (type) {
      params.push(type);
      where = 'WHERE c.type = $1';
    }
    const r = await this.ctx.db.query(
      `SELECT c.*,
         (SELECT COUNT(*)::int FROM marketing.messages m WHERE m.campaign_id = c.id) AS m_total,
         (SELECT COUNT(*)::int FROM marketing.messages m WHERE m.campaign_id = c.id AND m.status IN ('SENT','DELIVERED','READ')) AS m_sent,
         (SELECT COUNT(*)::int FROM marketing.messages m WHERE m.campaign_id = c.id AND m.status IN ('DELIVERED','READ')) AS m_delivered,
         (SELECT COUNT(*)::int FROM marketing.messages m WHERE m.campaign_id = c.id AND m.status = 'READ') AS m_read,
         (SELECT COUNT(*)::int FROM marketing.messages m WHERE m.campaign_id = c.id AND m.status = 'FAILED') AS m_failed
       FROM marketing.campaigns c ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT 200`,
      params,
    );
    return r.rows.map((row: any) => ({
      ...mapCampaign(row),
      stats: { total: row.m_total, sent: row.m_sent, delivered: row.m_delivered, read: row.m_read, failed: row.m_failed },
    }));
  }

  async recipients(id: number, limit = 100, offset = 0) {
    const r = await this.ctx.db.query(
      `SELECT r.customer_id, r.customer_name, r.phone, r.rank, r.spending::float8 AS spending, r.order_count,
              r.contactable, r.reason, k.code AS coupon_code,
              m.id AS message_id, m.status AS message_status, m.rendered_body, m.error_code
       FROM marketing.campaign_recipients r
       LEFT JOIN marketing.coupons k ON k.id = r.coupon_id
       LEFT JOIN marketing.messages m ON m.campaign_id = r.campaign_id AND m.customer_id = r.customer_id
       WHERE r.campaign_id = $1
       ORDER BY r.rank NULLS LAST, r.id
       LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    const total = await this.ctx.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM marketing.campaign_recipients WHERE campaign_id = $1', [id]);
    return { rows: r.rows, total: total.rows[0].n };
  }

  /** Numbers for the "Are you sure?" confirmation. */
  async sendSummary(id: number) {
    const campaign = await this.get(id);
    const general = await getGeneralSettings(this.ctx.db);
    const counts = (
      await this.ctx.db.query<{ pending: number }>(`SELECT COUNT(*)::int AS pending FROM marketing.messages WHERE campaign_id = $1 AND status = 'PENDING'`, [id])
    ).rows[0];
    const template = await getTemplate(this.ctx.db, campaign.templateName);
    return {
      campaignId: id,
      status: campaign.status,
      recipientCount: counts.pending,
      estimatedCostInr: Math.round(counts.pending * general.perMessageCostInr * 100) / 100,
      daysNeeded: Math.max(1, Math.ceil(counts.pending / general.dailyTierLimit)),
      dailyTierLimit: general.dailyTierLimit,
      templateName: campaign.templateName,
      templateApproved: template?.approvalStatus === 'APPROVED',
      excluded: campaign.generationSummary,
    };
  }

  // ─── create and edit ──────────────────────────────────────────────────────

  async createFestival(raw: FestivalInput, actor: string): Promise<Campaign> {
    const input = festivalInput.parse(raw);
    const f = this.festivalFields(input);
    const r = await this.ctx.db.query(
      `INSERT INTO marketing.campaigns
         (name, type, status, festival_name, start_date, end_date, discount_type, discount_value, minimum_order_amount,
          maximum_discount, coupon_mode, shared_coupon_code, shared_usage_cap, coupon_prefix, valid_from, valid_until,
          template_name, created_by)
       VALUES ($1,'FESTIVAL','DRAFT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [input.name, input.festivalName, input.startDate, input.endDate, input.discountType, input.discountValue,
        input.minimumOrderAmount ?? null, input.maximumDiscount ?? null, input.couponMode, f.sharedCode, input.sharedUsageCap ?? null,
        f.prefix, f.validFrom.toISOString(), f.validUntil.toISOString(), input.templateName, actor],
    );
    const campaign = mapCampaign(r.rows[0]);
    await audit(this.ctx.db, actor, 'CAMPAIGN_CREATED', 'campaign', campaign.id, { type: 'FESTIVAL', name: campaign.name });
    return campaign;
  }

  private festivalFields(input: z.output<typeof festivalInput>) {
    this.checkDiscount(input.discountType, input.discountValue);
    const s = parseYmd(input.startDate);
    const e = parseYmd(input.endDate);
    const validFrom = istStartOfDay(s.year, s.month, s.day);
    const validUntil = istEndOfDay(e.year, e.month, e.day);
    if (validUntil <= validFrom) throw new HttpError(400, 'End date must not be before the start date.');
    if (validUntil <= this.ctx.clock()) throw new HttpError(400, 'End date is already in the past.');
    if (input.couponMode === 'SHARED' && !input.sharedCouponCode) throw new HttpError(400, 'A shared coupon needs a code.');
    const dflt = `${input.festivalName}${input.discountType === 'PERCENT' ? Math.round(input.discountValue) : ''}`;
    return {
      validFrom,
      validUntil,
      prefix: sanitizePrefix(input.couponPrefix || dflt),
      sharedCode: input.couponMode === 'SHARED' ? input.sharedCouponCode!.toUpperCase() : null,
    };
  }

  async createTop10(raw: Top10Input, actor: string): Promise<Campaign> {
    const input = top10Input.parse(raw);
    const f = this.top10Fields(input);
    try {
      const r = await this.ctx.db.query(
        `INSERT INTO marketing.campaigns
           (name, type, status, target_month, discount_type, discount_value, minimum_order_amount, maximum_discount,
            coupon_prefix, valid_from, valid_until, template_name, backfill, created_by)
         VALUES ($1,'MONTH_END_TOP10','DRAFT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [input.name || `${monthLabel(input.targetMonth)} Top 10 Customers`, input.targetMonth, input.discountType, input.discountValue,
          input.minimumOrderAmount ?? null, input.maximumDiscount ?? null, f.prefix, this.ctx.clock().toISOString(),
          f.validUntil.toISOString(), input.templateName, input.backfill, actor],
      );
      const campaign = mapCampaign(r.rows[0]);
      await audit(this.ctx.db, actor, 'CAMPAIGN_CREATED', 'campaign', campaign.id, { type: 'MONTH_END_TOP10', month: input.targetMonth });
      return campaign;
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, `A Top 10 campaign for ${monthLabel(input.targetMonth)} already exists.`, 'DUPLICATE_MONTH');
      throw err;
    }
  }

  private top10Fields(input: z.output<typeof top10Input>) {
    this.checkDiscount(input.discountType, input.discountValue);
    const now = this.ctx.clock();
    // Only a fully finished month can be ranked. The current month is blocked.
    if (istMonthRange(input.targetMonth).end > now) throw new HttpError(400, 'That month has not finished yet. Pick a completed month.', 'MONTH_NOT_FINISHED');
    const v = parseYmd(input.validUntil);
    const validUntil = istEndOfDay(v.year, v.month, v.day);
    if (validUntil <= now) throw new HttpError(400, 'Coupon expiry is already in the past.');
    const dflt = `TOP${Math.round(input.discountValue)}`;
    return { validUntil, prefix: sanitizePrefix(input.couponPrefix || dflt) };
  }

  private checkDiscount(type: string, value: number): void {
    if (type === 'PERCENT' && value > 100) throw new HttpError(400, 'A percentage discount cannot exceed 100.');
  }

  /** Editing a campaign that awaits approval sends it back to DRAFT and discards what was generated. */
  async update(id: number, raw: unknown, actor: string): Promise<Campaign> {
    const current = await this.get(id);
    if (current.type === 'BIRTHDAY') throw new HttpError(400, 'The birthday campaign is changed from its settings page.');
    if (!EDITABLE.includes(current.status)) throw new HttpError(409, `A campaign in status ${current.status} cannot be edited.`);

    const sets: Record<string, unknown> = {};
    if (current.type === 'FESTIVAL') {
      const input = festivalInput.parse({ ...this.asFestivalInput(current), ...(raw as object) });
      const f = this.festivalFields(input);
      Object.assign(sets, {
        name: input.name, festival_name: input.festivalName, start_date: input.startDate, end_date: input.endDate,
        discount_type: input.discountType, discount_value: input.discountValue,
        minimum_order_amount: input.minimumOrderAmount ?? null, maximum_discount: input.maximumDiscount ?? null,
        coupon_mode: input.couponMode, shared_coupon_code: f.sharedCode, shared_usage_cap: input.sharedUsageCap ?? null,
        coupon_prefix: f.prefix, valid_from: f.validFrom.toISOString(), valid_until: f.validUntil.toISOString(),
        template_name: input.templateName,
      });
    } else {
      const input = top10Input.parse({ ...this.asTop10Input(current), ...(raw as object) });
      const f = this.top10Fields(input);
      Object.assign(sets, {
        name: input.name ?? current.name, target_month: input.targetMonth, discount_type: input.discountType,
        discount_value: input.discountValue, minimum_order_amount: input.minimumOrderAmount ?? null,
        maximum_discount: input.maximumDiscount ?? null, coupon_prefix: f.prefix, valid_until: f.validUntil.toISOString(),
        template_name: input.templateName, backfill: input.backfill,
      });
    }

    const cols = Object.keys(sets);
    const assignments = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
    try {
      const updated = await this.ctx.db.transaction(async (tx) => {
        const r = await tx.query(
          `UPDATE marketing.campaigns
           SET ${assignments}, status = 'DRAFT', target_count = 0, generation_summary = NULL, error = NULL, updated_at = $2
           WHERE id = $1 AND status = ANY(ARRAY['DRAFT','PENDING_APPROVAL','FAILED']) RETURNING *`,
          [id, this.ctx.clock().toISOString(), ...cols.map((c) => sets[c])],
        );
        if (!r.rows[0]) throw new HttpError(409, 'The campaign changed while you were editing. Reload and try again.');
        await this.coupons.discardGenerated(tx, id);
        return mapCampaign(r.rows[0]);
      });
      await audit(this.ctx.db, actor, 'CAMPAIGN_EDITED', 'campaign', id, { previousStatus: current.status, changes: raw });
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'A Top 10 campaign for that month already exists.', 'DUPLICATE_MONTH');
      throw err;
    }
  }

  private asFestivalInput(c: Campaign) {
    return {
      name: c.name, festivalName: c.festivalName, startDate: c.startDate, endDate: c.endDate, discountType: c.discountType,
      discountValue: c.discountValue, minimumOrderAmount: c.minimumOrderAmount, maximumDiscount: c.maximumDiscount,
      couponMode: c.couponMode, sharedCouponCode: c.sharedCouponCode, sharedUsageCap: c.sharedUsageCap,
      couponPrefix: c.couponPrefix, templateName: c.templateName,
    };
  }

  private asTop10Input(c: Campaign) {
    const p = istParts(c.validUntil!);
    return {
      name: c.name, targetMonth: c.targetMonth, discountType: c.discountType, discountValue: c.discountValue,
      validUntil: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
      minimumOrderAmount: c.minimumOrderAmount, maximumDiscount: c.maximumDiscount, couponPrefix: c.couponPrefix,
      backfill: c.backfill, templateName: c.templateName,
    };
  }

  // ─── generate: audience snapshot, coupons, messages ───────────────────────

  async generate(id: number, actor: string): Promise<Campaign> {
    const now = this.ctx.clock().toISOString();
    const start = await this.ctx.db.query(
      `UPDATE marketing.campaigns SET status = 'GENERATING', error = NULL, updated_at = $2
       WHERE id = $1 AND status IN ('DRAFT','FAILED') AND type <> 'BIRTHDAY' RETURNING *`,
      [id, now],
    );
    if (!start.rows[0]) {
      const c = await this.get(id);
      throw new HttpError(409, `Cannot generate a campaign in status ${c.status}.`);
    }
    const campaign = mapCampaign(start.rows[0]);

    try {
      const template = await getTemplate(this.ctx.db, campaign.templateName);
      if (!template) throw new HttpError(400, `Template "${campaign.templateName}" does not exist.`);

      const summary = await this.ctx.db.transaction(async (tx) => {
        await this.coupons.discardGenerated(tx, id);
        const s = campaign.type === 'FESTIVAL'
          ? await this.generateFestival(tx, campaign, template)
          : await this.generateTop10(tx, campaign, template);
        const done = await tx.query(
          `UPDATE marketing.campaigns SET status = 'PENDING_APPROVAL', target_count = $2, generation_summary = $3::jsonb, updated_at = $4
           WHERE id = $1 AND status = 'GENERATING'`,
          [id, s.messages, JSON.stringify(s), this.ctx.clock().toISOString()],
        );
        if (!done.rowCount) throw new HttpError(409, 'The campaign was cancelled during generation.');
        return s;
      });
      await audit(this.ctx.db, actor, 'CAMPAIGN_GENERATED', 'campaign', id, summary);
    } catch (err) {
      await this.ctx.db.query(
        `UPDATE marketing.campaigns SET status = 'FAILED', error = $2, updated_at = $3 WHERE id = $1 AND status = 'GENERATING'`,
        [id, (err as Error).message.slice(0, 1000), this.ctx.clock().toISOString()],
      );
      throw err;
    }
    return this.get(id);
  }

  private async generateFestival(tx: Queryable, campaign: Campaign, template: Template) {
    const all = await this.customers.findAll(tx);
    const excluded: Record<string, number> = {};
    const eligible: { c: StoreCustomer; phone: string }[] = [];
    for (const c of all) {
      const a = assessContact(c);
      if (a.contactable && a.phoneE164) eligible.push({ c, phone: a.phoneE164 });
      else excluded[a.reason ?? 'UNKNOWN'] = (excluded[a.reason ?? 'UNKNOWN'] ?? 0) + 1;
    }

    let shared = null;
    if (campaign.couponMode === 'SHARED' && eligible.length) {
      shared = await this.coupons.create(tx, {
        ...this.couponBase(campaign),
        customerId: null,
        fixedCode: campaign.sharedCouponCode!,
        usageLimit: campaign.sharedUsageCap ?? eligible.length,
      });
    }

    for (const { c, phone } of eligible) {
      const coupon = shared ?? (await this.coupons.create(tx, { ...this.couponBase(campaign), customerId: c.customerId, usageLimit: 1 }));
      await this.insertRecipient(tx, campaign, c, phone, { contactable: true, reason: null, couponId: coupon.id });
      await this.insertMessage(tx, campaign, template, c, phone, coupon.id, coupon.code);
    }
    return { considered: all.length, messages: eligible.length, excluded };
  }

  private async generateTop10(tx: Queryable, campaign: Campaign, template: Template) {
    const { start, end } = istMonthRange(campaign.targetMonth!);
    // With backfill we look further down the ranking until ten contactable customers are found.
    const ranked = await this.customers.topSpenders(tx, start, end, campaign.backfill ? 500 : TOP_N);

    let messages = 0;
    const excluded: Record<string, number> = {};
    for (let i = 0; i < ranked.length && messages < TOP_N; i++) {
      const c = ranked[i];
      const a = assessContact(c);
      const extra = { rank: i + 1, spending: c.spending, orderCount: c.orderCount };
      if (a.contactable && a.phoneE164) {
        const coupon = await this.coupons.create(tx, { ...this.couponBase(campaign), customerId: c.customerId, usageLimit: 1 });
        await this.insertRecipient(tx, campaign, c, a.phoneE164, { contactable: true, reason: null, couponId: coupon.id, ...extra });
        await this.insertMessage(tx, campaign, template, c, a.phoneE164, coupon.id, coupon.code);
        messages++;
      } else {
        // Shown to the admin as "not contactable". Never messaged.
        await this.insertRecipient(tx, campaign, c, a.phoneE164, { contactable: false, reason: a.reason, couponId: null, ...extra });
        excluded[a.reason ?? 'UNKNOWN'] = (excluded[a.reason ?? 'UNKNOWN'] ?? 0) + 1;
      }
    }
    return { considered: ranked.length, messages, excluded, month: campaign.targetMonth, backfill: campaign.backfill };
  }

  private couponBase(campaign: Campaign) {
    return {
      campaignId: campaign.id,
      prefix: campaign.couponPrefix,
      discountType: campaign.discountType,
      discountValue: campaign.discountValue,
      minimumOrderAmount: campaign.minimumOrderAmount,
      maximumDiscount: campaign.maximumDiscount,
      validFrom: campaign.validFrom ?? this.ctx.clock(),
      validUntil: campaign.validUntil!,
      publishNow: false, // campaign coupons reach the store only at approval
    };
  }

  private async insertRecipient(
    tx: Queryable, campaign: Campaign, c: StoreCustomer, phone: string | null,
    x: { contactable: boolean; reason: string | null; couponId: number | null; rank?: number; spending?: number; orderCount?: number },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO marketing.campaign_recipients
         (campaign_id, customer_id, customer_name, phone, rank, spending, order_count, contactable, reason, coupon_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [campaign.id, c.customerId, c.name, phone ?? c.phone, x.rank ?? null, x.spending ?? null, x.orderCount ?? null, x.contactable, x.reason, x.couponId],
    );
  }

  private async insertMessage(
    tx: Queryable, campaign: Campaign, template: Template, c: StoreCustomer, phone: string, couponId: number, couponCode: string,
  ): Promise<void> {
    const values: TemplateValues = {
      customer_name: firstName(c.name),
      discount_text: discountText(campaign.discountType, campaign.discountValue),
      coupon_code: couponCode,
      expiry_date: formatDateLong(campaign.validUntil!),
      festival_name: campaign.festivalName ?? undefined,
    };
    const params = buildParams(template, values);
    await tx.query(
      `INSERT INTO marketing.messages
         (campaign_id, campaign_type, customer_id, customer_name, phone_number, template_name, template_language,
          template_params, rendered_body, coupon_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [campaign.id, campaign.type, c.customerId, c.name, phone, template.name, template.language, JSON.stringify(params), renderBody(template, params), couponId],
    );
  }

  // ─── approve and send ─────────────────────────────────────────────────────

  /**
   * The only way a festival or Top 10 campaign starts sending. The status change is
   * one conditional UPDATE, so a double click or two admins approving at once
   * produces exactly one send.
   */
  async approveAndSend(id: number, actor: string): Promise<Campaign> {
    const campaign = await this.get(id);
    if (campaign.type === 'BIRTHDAY') throw new HttpError(400, 'Birthday messages are automatic and need no approval.');

    const general = await getGeneralSettings(this.ctx.db);
    if (general.requireDifferentApprover && campaign.createdBy === actor) {
      throw new HttpError(403, 'This campaign must be approved by a different admin than the one who created it.', 'SAME_APPROVER');
    }
    const template = await getTemplate(this.ctx.db, campaign.templateName);
    if (!template || template.approvalStatus !== 'APPROVED') {
      throw new HttpError(409, `WhatsApp template "${campaign.templateName}" is not approved by Meta yet. Nothing was sent.`, 'TEMPLATE_NOT_APPROVED');
    }
    if (campaign.validUntil && campaign.validUntil <= this.ctx.clock()) {
      throw new HttpError(409, 'The coupons for this campaign have already expired. Edit the dates first.', 'EXPIRED');
    }

    const now = this.ctx.clock().toISOString();
    const r = await this.ctx.db.query(
      `UPDATE marketing.campaigns SET status = 'APPROVED', approved_by = $2, approved_at = $3, updated_at = $3
       WHERE id = $1 AND status = 'PENDING_APPROVAL' RETURNING id`,
      [id, actor, now],
    );
    if (!r.rows[0]) {
      const latest = await this.get(id);
      throw new HttpError(409, `This campaign is ${latest.status}. It was already sent or is not awaiting approval. Nothing new was sent.`, 'NOT_PENDING_APPROVAL');
    }

    await audit(this.ctx.db, actor, 'CAMPAIGN_APPROVED', 'campaign', id, { recipients: campaign.targetCount });
    await this.startSending(id);
    return this.get(id);
  }

  /** Idempotent. Also used on startup to resume a campaign that was approved just before a crash. */
  async startSending(id: number): Promise<void> {
    const general = await getGeneralSettings(this.ctx.db);
    const now = this.ctx.clock();
    const p = istParts(now);
    const todayWindowStart = istToUtc(p.year, p.month, p.day, general.sendWindowStartHour, 0);

    await this.ctx.db.transaction(async (tx) => {
      const c = await tx.query(`SELECT status FROM marketing.campaigns WHERE id = $1`, [id]);
      if (c.rows[0]?.status !== 'APPROVED') return;

      await this.coupons.publishCampaign(tx, id);

      // Respect the account's daily messaging tier: the first batch goes now, the rest on following mornings.
      await tx.query(
        `WITH numbered AS (
           SELECT id, ((ROW_NUMBER() OVER (ORDER BY id) - 1) / $2::int)::int AS day_idx
           FROM marketing.messages WHERE campaign_id = $1 AND status = 'PENDING'
         )
         UPDATE marketing.messages m
         SET scheduled_for = CASE WHEN n.day_idx = 0 THEN $3::timestamptz
                                  ELSE $4::timestamptz + (n.day_idx * INTERVAL '1 day') END
         FROM numbered n WHERE n.id = m.id`,
        [id, general.dailyTierLimit, now.toISOString(), todayWindowStart.toISOString()],
      );

      await tx.query(`UPDATE marketing.campaigns SET status = 'SENDING', updated_at = $2 WHERE id = $1 AND status = 'APPROVED'`, [id, now.toISOString()]);
    });

    await this.sender.enqueueDue(id);
    await this.sender.maybeComplete(id); // a campaign with zero recipients completes at once
  }

  async resumeApproved(): Promise<void> {
    const r = await this.ctx.db.query<{ id: number }>(`SELECT id FROM marketing.campaigns WHERE status = 'APPROVED'`);
    for (const row of r.rows) await this.startSending(row.id);
  }

  // ─── cancel ───────────────────────────────────────────────────────────────

  async cancel(id: number, actor: string): Promise<Campaign> {
    const before = await this.get(id);
    if (before.type === 'BIRTHDAY') throw new HttpError(400, 'Switch the birthday campaign off from its settings instead.');

    const stopped = await this.ctx.db.transaction(async (tx) => {
      const r = await tx.query(
        `UPDATE marketing.campaigns SET status = 'CANCELLED', updated_at = $2
         WHERE id = $1 AND status = ANY($3::text[]) RETURNING id`,
        [id, this.ctx.clock().toISOString(), CANCELLABLE],
      );
      if (!r.rows[0]) throw new HttpError(409, `A campaign in status ${before.status} cannot be cancelled.`);
      const skipped = await tx.query(
        `UPDATE marketing.messages SET status = 'SKIPPED', error_code = 'CAMPAIGN_CANCELLED', locked_until = NULL
         WHERE campaign_id = $1 AND status = 'PENDING'`,
        [id],
      );
      const coupons = await this.coupons.cancelForCampaign(tx, id);
      return { messagesStopped: skipped.rowCount, couponsCancelled: coupons };
    });

    await audit(this.ctx.db, actor, 'CAMPAIGN_CANCELLED', 'campaign', id, { previousStatus: before.status, ...stopped });
    return this.get(id);
  }
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { AppContext } from './context.js';
import { HttpError } from './context.js';
import { audit } from './audit/audit.js';
import { AuthService } from './auth/auth.js';
import { BirthdayService } from './campaigns/birthday.service.js';
import { CampaignService } from './campaigns/campaign.service.js';
import { CouponService } from './coupons/coupon.service.js';
import { CustomerRepo, assessContact } from './customers/customer.repo.js';
import { PreferenceService } from './customers/preference.service.js';
import {
  birthdaySettingsSchema, generalSettingsSchema, getBirthdaySettings, getGeneralSettings, saveBirthdaySettings, saveGeneralSettings,
} from './settings/settings.service.js';
import { listTemplates } from './whatsapp/whatsapp.template.js';
import { WebhookService, verifySignature } from './whatsapp/whatsapp.webhook.js';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res).catch(next);
};

const idParam = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id.');
  return id;
};

const paging = (req: Request) => ({
  limit: Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50)),
  offset: Math.max(0, Number(req.query.offset ?? 0) || 0),
});

export interface Services {
  auth: AuthService;
  campaigns: CampaignService;
  birthday: BirthdayService;
  coupons: CouponService;
  prefs: PreferenceService;
  webhook: WebhookService;
  customers: CustomerRepo;
}

export function buildServices(ctx: AppContext): Services {
  return {
    auth: new AuthService(ctx),
    campaigns: new CampaignService(ctx),
    birthday: new BirthdayService(ctx),
    coupons: new CouponService(ctx),
    prefs: new PreferenceService(ctx),
    webhook: new WebhookService(ctx),
    customers: new CustomerRepo(ctx.mapping),
  };
}

export function createApp(ctx: AppContext, services: Services = buildServices(ctx)) {
  const { auth, campaigns, birthday, coupons, prefs, webhook, customers } = services;
  const { db } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // The raw body is kept so webhook signatures can be verified byte for byte.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as Request).rawBody = buf; } }));

  app.get('/health', wrap(async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true, provider: ctx.whatsapp.name, queue: ctx.queue.kind, database: db.kind, couponMode: ctx.env.couponMode });
  }));

  // ─── WhatsApp webhooks ─────────────────────────────────────────────────────
  app.get('/webhooks/whatsapp', (req, res) => {
    const ok = req.query['hub.mode'] === 'subscribe' && ctx.env.whatsappVerifyToken && req.query['hub.verify_token'] === ctx.env.whatsappVerifyToken;
    if (ok) res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    else res.sendStatus(403);
  });

  app.post('/webhooks/whatsapp', wrap(async (req, res) => {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!req.rawBody || !verifySignature(req.rawBody, signature, ctx.env.whatsappAppSecret)) {
      ctx.log.warn('Rejected webhook with a bad or missing signature.');
      res.sendStatus(401);
      return;
    }
    const out = await webhook.handlePayload(req.body);
    res.json({ ok: true, ...out });
  }));

  // ─── auth ──────────────────────────────────────────────────────────────────
  app.post('/api/auth/login', wrap(async (req, res) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const identity = await auth.login(body.email, body.password, req.ip ?? 'unknown');
    const token = auth.sign(identity);
    auth.setCookie(res, token);
    await audit(db, identity.email, 'LOGIN', 'admin', identity.email, { source: identity.source });
    res.json({ admin: identity, token });
  }));

  app.post('/api/auth/logout', (_req, res) => {
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  // ─── store integration (API key) ───────────────────────────────────────────
  const integration = express.Router();
  integration.use(auth.requireApiKey);

  const couponCall = z.object({ code: z.string().min(1), customerId: z.string().min(1), orderAmount: z.number().nonnegative() });

  integration.post('/coupons/validate', wrap(async (req, res) => {
    const b = couponCall.parse(req.body);
    const r = await coupons.validate(db, b.code, b.customerId, b.orderAmount);
    res.json({ valid: r.valid, reason: r.reason ?? null, discount: r.discount ?? 0 });
  }));

  integration.post('/coupons/redeem', wrap(async (req, res) => {
    if (ctx.env.couponMode !== 'api') throw new HttpError(409, 'Coupons are redeemed by the store itself in existing_table mode.');
    const b = couponCall.extend({ orderId: z.string().min(1) }).parse(req.body);
    const r = await coupons.redeem(b.code, b.customerId, b.orderAmount, b.orderId);
    res.status(r.valid ? 200 : 409).json({ valid: r.valid, reason: r.reason ?? null, discount: r.discount ?? 0 });
  }));

  // The store calls these when a customer ticks or unticks the WhatsApp offers box.
  integration.post('/opt-in', wrap(async (req, res) => {
    const b = z.object({ customerId: z.string().min(1), source: z.string().default('store-checkbox') }).parse(req.body);
    await prefs.optIn(b.customerId, b.source);
    res.json({ ok: true });
  }));

  integration.post('/opt-out', wrap(async (req, res) => {
    const b = z.object({ customerId: z.string().min(1), source: z.string().default('store-settings') }).parse(req.body);
    await prefs.optOut(b.customerId, b.source);
    res.json({ ok: true });
  }));

  app.use('/api/integration', integration);

  // ─── admin API ─────────────────────────────────────────────────────────────
  const api = express.Router();
  api.use(auth.requireAdmin);

  api.get('/auth/me', (req, res) => res.json({ admin: req.admin }));

  api.get('/dashboard', wrap(async (_req, res) => {
    const [people, msg, coup, camp, today, general] = await Promise.all([
      customers.counts(db),
      db.query(`SELECT
          COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ'))::int AS sent,
          COUNT(*) FILTER (WHERE status IN ('DELIVERED','READ'))::int AS delivered,
          COUNT(*) FILTER (WHERE status = 'READ')::int AS read,
          COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE campaign_type = 'BIRTHDAY' AND status IN ('SENT','DELIVERED','READ'))::int AS birthday_sent
        FROM marketing.messages`),
      db.query(`SELECT COUNT(*)::int AS generated, COUNT(*) FILTER (WHERE used_count > 0)::int AS used FROM marketing.coupons WHERE status <> 'CANCELLED' OR used_count > 0`),
      db.query(`SELECT type, status, COUNT(*)::int AS n FROM marketing.campaigns GROUP BY type, status`),
      birthday.todayOverview(),
      getGeneralSettings(db),
    ]);
    const failures = await db.query(`SELECT error_code, COUNT(*)::int AS n FROM marketing.messages WHERE status IN ('FAILED','SKIPPED') GROUP BY error_code ORDER BY n DESC`);
    const attention = await db.query(
      `SELECT id, name, type, status, target_count FROM marketing.campaigns
       WHERE status IN ('PENDING_APPROVAL','SENDING','FAILED','GENERATING') AND type <> 'BIRTHDAY' ORDER BY updated_at DESC LIMIT 10`,
    );
    const count = (type: string) => camp.rows.filter((r: any) => r.type === type).reduce((a: number, r: any) => a + r.n, 0);
    res.json({
      totalCustomers: people.total,
      eligibleCustomers: people.eligible,
      birthdayMessages: msg.rows[0].birthday_sent,
      festivalCampaigns: count('FESTIVAL'),
      top10Campaigns: count('MONTH_END_TOP10'),
      messages: msg.rows[0],
      coupons: coup.rows[0],
      failures: failures.rows,
      birthdaysToday: today,
      needsAttention: attention.rows,
      birthdayEnabled: (await getBirthdaySettings(db)).enabled,
      provider: ctx.whatsapp.name,
      perMessageCostInr: general.perMessageCostInr,
    });
  }));

  // campaigns
  api.get('/campaigns', wrap(async (req, res) => {
    res.json({ campaigns: await campaigns.list(typeof req.query.type === 'string' ? req.query.type : undefined) });
  }));

  api.post('/campaigns', wrap(async (req, res) => {
    const type = z.enum(['FESTIVAL', 'MONTH_END_TOP10']).parse(req.body?.type);
    const { type: _t, ...input } = req.body;
    const c = type === 'FESTIVAL' ? await campaigns.createFestival(input, req.admin!.email) : await campaigns.createTop10(input, req.admin!.email);
    res.status(201).json({ campaign: c });
  }));

  api.get('/campaigns/:id', wrap(async (req, res) => {
    const id = idParam(req);
    res.json({ campaign: await campaigns.get(id), summary: await campaigns.sendSummary(id) });
  }));

  api.patch('/campaigns/:id', wrap(async (req, res) => {
    res.json({ campaign: await campaigns.update(idParam(req), req.body, req.admin!.email) });
  }));

  api.post('/campaigns/:id/generate', wrap(async (req, res) => {
    res.json({ campaign: await campaigns.generate(idParam(req), req.admin!.email) });
  }));

  api.get('/campaigns/:id/recipients', wrap(async (req, res) => {
    const { limit, offset } = paging(req);
    res.json(await campaigns.recipients(idParam(req), limit, offset));
  }));

  // The one route that can start a festival or Top 10 send.
  api.post('/campaigns/:id/approve-send', wrap(async (req, res) => {
    const id = idParam(req);
    const body = z.object({ confirmRecipientCount: z.number().int().nonnegative() }).parse(req.body);
    const summary = await campaigns.sendSummary(id);
    if (summary.status === 'PENDING_APPROVAL' && body.confirmRecipientCount !== summary.recipientCount) {
      throw new HttpError(409, `The audience is ${summary.recipientCount} customers, not ${body.confirmRecipientCount}. Review the campaign again.`, 'COUNT_MISMATCH');
    }
    res.json({ campaign: await campaigns.approveAndSend(id, req.admin!.email) });
  }));

  api.post('/campaigns/:id/cancel', wrap(async (req, res) => {
    res.json({ campaign: await campaigns.cancel(idParam(req), req.admin!.email) });
  }));

  // birthday
  api.get('/birthday', wrap(async (_req, res) => {
    const history = await db.query(
      `SELECT m.id, m.customer_id, m.customer_name, m.phone_number, m.status, m.error_code, m.created_at, m.sent_at, m.delivered_at, m.read_at, k.code AS coupon_code
       FROM marketing.messages m LEFT JOIN marketing.coupons k ON k.id = m.coupon_id
       WHERE m.campaign_type = 'BIRTHDAY' ORDER BY m.id DESC LIMIT 100`,
    );
    res.json({ settings: await getBirthdaySettings(db), today: await birthday.todayOverview(), history: history.rows });
  }));

  api.put('/birthday/settings', wrap(async (req, res) => {
    const before = await getBirthdaySettings(db);
    const next = birthdaySettingsSchema.parse(req.body);
    await saveBirthdaySettings(db, next);
    await audit(db, req.admin!.email, 'BIRTHDAY_SETTINGS_CHANGED', 'settings', 'birthday', { before, after: next });
    res.json({ settings: next });
  }));

  // Same job the scheduler runs. Every duplicate guard still applies.
  api.post('/birthday/run', wrap(async (req, res) => {
    const result = await birthday.run();
    await audit(db, req.admin!.email, 'BIRTHDAY_RUN_REQUESTED', 'campaign', null, result);
    res.json({ result });
  }));

  // coupons, messages, customers
  api.get('/coupons', wrap(async (req, res) => {
    const { limit, offset } = paging(req);
    const params: unknown[] = [];
    const where: string[] = [];
    if (typeof req.query.status === 'string') { params.push(req.query.status); where.push(`k.status = $${params.length}`); }
    if (typeof req.query.campaignId === 'string') { params.push(Number(req.query.campaignId)); where.push(`k.campaign_id = $${params.length}`); }
    if (typeof req.query.search === 'string' && req.query.search) { params.push(`%${req.query.search.toUpperCase()}%`); where.push(`k.code LIKE $${params.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM marketing.coupons k ${w}`, params);
    params.push(limit, offset);
    const r = await db.query(
      `SELECT k.id, k.code, k.customer_id, k.campaign_id, c.name AS campaign_name, k.discount_type, k.discount_value::float8 AS discount_value,
              k.valid_from, k.valid_until, k.usage_limit, k.used_count, k.status, k.used_at, k.used_order_id, k.in_store_table
       FROM marketing.coupons k JOIN marketing.campaigns c ON c.id = k.campaign_id ${w}
       ORDER BY k.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ rows: r.rows, total: total.rows[0].n });
  }));

  api.get('/messages', wrap(async (req, res) => {
    const { limit, offset } = paging(req);
    const params: unknown[] = [];
    const where: string[] = [];
    if (typeof req.query.status === 'string') { params.push(req.query.status); where.push(`m.status = $${params.length}`); }
    if (typeof req.query.campaignId === 'string') { params.push(Number(req.query.campaignId)); where.push(`m.campaign_id = $${params.length}`); }
    if (typeof req.query.type === 'string') { params.push(req.query.type); where.push(`m.campaign_type = $${params.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM marketing.messages m ${w}`, params);
    params.push(limit, offset);
    const r = await db.query(
      `SELECT m.id, m.campaign_id, c.name AS campaign_name, m.campaign_type, m.customer_id, m.customer_name, m.phone_number, m.template_name,
              m.rendered_body, m.status, m.attempts, m.scheduled_for, m.sent_at, m.delivered_at, m.read_at, m.failed_at,
              m.error_code, m.error_message, m.created_at, k.code AS coupon_code
       FROM marketing.messages m JOIN marketing.campaigns c ON c.id = m.campaign_id LEFT JOIN marketing.coupons k ON k.id = m.coupon_id ${w}
       ORDER BY m.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ rows: r.rows, total: total.rows[0].n });
  }));

  api.get('/customers', wrap(async (req, res) => {
    const { limit, offset } = paging(req);
    const out = await customers.list(db, { search: typeof req.query.search === 'string' ? req.query.search : undefined, limit, offset });
    res.json({
      total: out.total,
      rows: out.rows.map((c) => {
        const a = assessContact(c);
        return { ...c, phoneE164: a.phoneE164, contactable: a.contactable, reason: a.reason };
      }),
    });
  }));

  api.put('/customers/:customerId/preference', wrap(async (req, res) => {
    const b = z.object({ optedIn: z.boolean(), source: z.string().min(2).default('admin-dashboard') }).parse(req.body);
    const customerId = req.params.customerId;
    if (!(await customers.findById(db, customerId))) throw new HttpError(404, 'Customer not found.');
    if (b.optedIn) await prefs.optIn(customerId, b.source);
    else await prefs.optOut(customerId, b.source);
    await audit(db, req.admin!.email, b.optedIn ? 'OPT_IN_RECORDED' : 'OPT_OUT_RECORDED', 'customer', customerId, { source: b.source });
    res.json({ ok: true });
  }));

  // settings and templates
  api.get('/settings', wrap(async (_req, res) => {
    res.json({ general: await getGeneralSettings(db), birthday: await getBirthdaySettings(db), templates: await listTemplates(db) });
  }));

  api.put('/settings/general', wrap(async (req, res) => {
    const before = await getGeneralSettings(db);
    const next = generalSettingsSchema.parse(req.body);
    if (next.sendWindowEndHour <= next.sendWindowStartHour) throw new HttpError(400, 'The send window must end after it starts.');
    await saveGeneralSettings(db, next);
    await audit(db, req.admin!.email, 'GENERAL_SETTINGS_CHANGED', 'settings', 'general', { before, after: next });
    res.json({ general: next });
  }));

  // Records what Meta decided. The text itself can only change through a new submission to Meta.
  api.put('/templates/:name/status', wrap(async (req, res) => {
    const b = z.object({ approvalStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAUSED']) }).parse(req.body);
    const r = await db.query('UPDATE marketing.templates SET approval_status = $2, updated_at = now() WHERE name = $1 RETURNING name', [req.params.name, b.approvalStatus]);
    if (!r.rows[0]) throw new HttpError(404, 'Template not found.');
    await audit(db, req.admin!.email, 'TEMPLATE_STATUS_CHANGED', 'template', req.params.name, b);
    res.json({ templates: await listTemplates(db) });
  }));

  // Pull approval statuses straight from Meta.
  api.post('/templates/sync', wrap(async (req, res) => {
    if (!ctx.whatsapp.listTemplates) throw new HttpError(400, 'This provider cannot list templates.');
    const remote = await ctx.whatsapp.listTemplates();
    let updated = 0;
    for (const t of remote) {
      const status = ['APPROVED', 'REJECTED', 'PAUSED'].includes(t.status) ? t.status : 'PENDING';
      const r = await db.query('UPDATE marketing.templates SET approval_status = $2, language = $3, updated_at = now() WHERE name = $1', [t.name, status, t.language]);
      updated += r.rowCount;
    }
    await audit(db, req.admin!.email, 'TEMPLATES_SYNCED', 'template', null, { remote: remote.length, updated });
    res.json({ updated, templates: await listTemplates(db) });
  }));

  api.get('/audit', wrap(async (req, res) => {
    const { limit, offset } = paging(req);
    const r = await db.query('SELECT * FROM marketing.audit_log ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]);
    res.json({ rows: r.rows });
  }));

  app.use('/api', api);

  // ─── dashboard (static single-page app) ────────────────────────────────────
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin');
  app.use('/admin/marketing', express.static(publicDir));
  app.get('/', (_req, res) => res.redirect('/admin/marketing/'));

  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), code: 'VALIDATION' });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code ?? null });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'Malformed JSON.' });
      return;
    }
    ctx.log.error('Unhandled error', err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}

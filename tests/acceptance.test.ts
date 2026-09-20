import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { HttpError } from '../src/context.js';
import { istToUtc } from '../src/util/time.js';
import { signBody } from '../src/whatsapp/whatsapp.webhook.js';
import { WhatsAppError } from '../src/whatsapp/whatsapp.types.js';
import { API_KEY, APP_SECRET, FESTIVAL, TOP10, makeHarness, phone, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const ADMIN = 'admin@example.com';
const count = async (sql: string, params: unknown[] = []) => (await h.ctx.db.query<{ n: number }>(sql, params)).rows[0].n;

async function threeCustomers() {
  await h.addCustomer({ id: 'c1', firstName: 'Rahul', lastName: 'Reddy', phone: phone(), dob: '1990-09-19' });
  await h.addCustomer({ id: 'c2', firstName: 'Priya', lastName: 'Sharma', phone: phone(), dob: '1991-03-02' });
  await h.addCustomer({ id: 'c3', firstName: 'Arun', lastName: 'Kumar', phone: phone(), dob: '1992-07-11' });
}

describe('Addendum A13 acceptance tests', () => {
  it('1. running the birthday job twice on the same day sends one message per customer', async () => {
    h = await makeHarness();
    await threeCustomers(); // only c1 has a birthday on 19 September
    await h.addCustomer({ id: 'c4', firstName: 'Sita', phone: phone(), dob: '1988-09-19', optIn: false });

    const first = await h.services.birthday.run();
    const second = await h.services.birthday.run();
    const [third, fourth] = await Promise.all([h.services.birthday.run(), h.services.birthday.run()]);
    await h.drain();

    expect(first).toMatchObject({ status: 'OK', found: 2, queued: 1, skipped: { NO_OPT_IN: 1 } });
    expect(second.queued).toBe(0);
    expect(third.queued + fourth.queued).toBe(0);
    expect(h.mock.sent.filter((s) => s.kind === 'template')).toHaveLength(1);
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.messages WHERE campaign_type = 'BIRTHDAY'`)).toBe(1);
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.coupons`)).toBe(1); // no spare coupons from the reruns
    expect(h.mock.sent[0].bodyParams?.[0]).toBe('Rahul');
    expect(h.mock.sent[0].bodyParams?.[1]).toBe('₹300');
  });

  it('2. two simultaneous approve requests on one campaign enqueue one set of jobs', async () => {
    h = await makeHarness();
    await threeCustomers();
    const c = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    await h.services.campaigns.generate(c.id, ADMIN);

    const results = await Promise.allSettled([
      h.services.campaigns.approveAndSend(c.id, ADMIN),
      h.services.campaigns.approveAndSend(c.id, ADMIN),
    ]);
    await h.drain();

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(HttpError);
    expect(rejected.reason.code).toBe('NOT_PENDING_APPROVAL');
    expect(h.mock.sent).toHaveLength(3);

    // A third click after completion also sends nothing.
    await expect(h.services.campaigns.approveAndSend(c.id, ADMIN)).rejects.toMatchObject({ status: 409 });
    await h.drain();
    expect(h.mock.sent).toHaveLength(3);
    expect((await h.services.campaigns.get(c.id)).status).toBe('COMPLETED');
  });

  it('3. a customer who opts out after generation and before sending gets nothing', async () => {
    h = await makeHarness();
    await threeCustomers();
    const c = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    await h.services.campaigns.generate(c.id, ADMIN);

    // c1 opts out through the normal path. c2's consent is withdrawn behind the service's back,
    // which proves the send-time re-check works on its own.
    await h.services.prefs.optOut('c1', 'test');
    await h.ctx.db.query(`UPDATE marketing.preferences SET opted_out_at = now(), opted_in = FALSE WHERE customer_id = 'c2'`);

    await h.services.campaigns.approveAndSend(c.id, ADMIN);
    await h.drain();

    expect(h.mock.sent.map((s) => s.bodyParams?.[1])).toEqual(['Arun']);
    const rows = await h.ctx.db.query(`SELECT customer_id, status, error_code FROM marketing.messages ORDER BY customer_id`);
    expect(rows.rows).toEqual([
      { customer_id: 'c1', status: 'SKIPPED', error_code: 'OPTED_OUT' },
      { customer_id: 'c2', status: 'SKIPPED', error_code: 'OPTED_OUT' },
      { customer_id: 'c3', status: 'SENT', error_code: null },
    ]);
  });

  it('4. a coupon cannot be redeemed by a different customer, twice, or after expiry', async () => {
    h = await makeHarness({ env: { couponMode: 'api' } });
    await threeCustomers();
    const c = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    await h.services.campaigns.generate(c.id, ADMIN);
    const code = (await h.ctx.db.query<{ code: string }>(`SELECT code FROM marketing.coupons WHERE customer_id = 'c1'`)).rows[0].code;
    const { coupons } = h.services;

    h.clock.now = istToUtc(2026, 10, 16, 12, 0); // inside the festival window
    // Generated for a preview but not approved: not redeemable yet.
    expect(await coupons.redeem(code, 'c1', 5000, 'o-0')).toMatchObject({ valid: false, reason: 'NOT_LIVE' });

    h.clock.now = istToUtc(2026, 9, 19, 10, 0);
    await h.services.campaigns.approveAndSend(c.id, ADMIN);
    await h.drain();
    expect(await coupons.redeem(code, 'c1', 5000, 'o-early')).toMatchObject({ valid: false, reason: 'NOT_STARTED' });

    h.clock.now = istToUtc(2026, 10, 16, 12, 0);
    expect(await coupons.redeem(code, 'c2', 5000, 'o-1')).toMatchObject({ valid: false, reason: 'WRONG_CUSTOMER' });
    expect(await coupons.redeem(code, 'c1', 5000, 'o-2')).toMatchObject({ valid: true, discount: 1000 });
    expect(await coupons.redeem(code, 'c1', 5000, 'o-2')).toMatchObject({ valid: true, discount: 1000 }); // same order retried
    expect(await coupons.redeem(code, 'c1', 5000, 'o-3')).toMatchObject({ valid: false });
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.coupon_redemptions`)).toBe(1);

    const code3 = (await h.ctx.db.query<{ code: string }>(`SELECT code FROM marketing.coupons WHERE customer_id = 'c3'`)).rows[0].code;
    const race = await Promise.all([coupons.redeem(code3, 'c3', 5000, 'o-a'), coupons.redeem(code3, 'c3', 5000, 'o-b')]);
    expect(race.filter((r) => r.valid)).toHaveLength(1);

    h.clock.now = istToUtc(2026, 10, 26, 0, 5); // five minutes after the last valid day
    const code2 = (await h.ctx.db.query<{ code: string }>(`SELECT code FROM marketing.coupons WHERE customer_id = 'c2'`)).rows[0].code;
    expect(await coupons.redeem(code2, 'c2', 5000, 'o-4')).toMatchObject({ valid: false, reason: 'EXPIRED' });
  });

  it('5. two customers with the same first name receive different coupon codes', async () => {
    h = await makeHarness();
    await h.addCustomer({ id: 'r1', firstName: 'Rahul', lastName: 'Reddy', phone: phone() });
    await h.addCustomer({ id: 'r2', firstName: 'Rahul', lastName: 'Verma', phone: phone() });

    // Force the random generator to repeat itself, so the unique index has to do its job.
    const forced = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
    h.ctx.randomCode = () => forced.shift() ?? 'ZZZZZZ';

    const c = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    await h.services.campaigns.generate(c.id, ADMIN);
    const codes = (await h.ctx.db.query<{ code: string }>(`SELECT code FROM marketing.coupons ORDER BY id`)).rows.map((r) => r.code);
    expect(codes).toEqual(['DIWALI20-AAAAAA', 'DIWALI20-BBBBBB']);
  });

  it('6. a Top 10 tie at rank 10 resolves the same way on every run', async () => {
    const winners: string[][] = [];
    for (const order of ['forward', 'reverse'] as const) {
      h = await makeHarness();
      const ids = Array.from({ length: 12 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);
      const insertion = order === 'forward' ? ids : [...ids].reverse();
      for (const id of insertion) await h.addCustomer({ id, firstName: `Cust${id}`, phone: phone() });
      for (const id of insertion) {
        const i = ids.indexOf(id);
        const day = istToUtc(2026, 8, 10, 12, 0);
        if (i < 9) await h.addOrder({ id: `o-${id}`, userId: id, amount: 50000 - i * 1000, createdAt: day });
        // t10, t11, t12 all spent exactly 20,000. t11 did it in two orders, so t11 wins the tie.
        else if (id === 't11') {
          await h.addOrder({ id: `o-${id}-a`, userId: id, amount: 12000, createdAt: day });
          await h.addOrder({ id: `o-${id}-b`, userId: id, amount: 8000, createdAt: day });
        } else await h.addOrder({ id: `o-${id}`, userId: id, amount: 20000, createdAt: day });
      }
      // Noise that must not count: a cancelled order and one outside the month.
      await h.addOrder({ id: 'o-cancelled', userId: 't12', amount: 99999, status: 'CANCELLED', createdAt: istToUtc(2026, 8, 12) });
      await h.addOrder({ id: 'o-september', userId: 't12', amount: 99999, createdAt: istToUtc(2026, 9, 1, 0, 0) });

      const c = await h.services.campaigns.createTop10(TOP10, ADMIN);
      await h.services.campaigns.generate(c.id, ADMIN);
      const r = await h.services.campaigns.recipients(c.id);
      winners.push(r.rows.map((x: any) => x.customer_id));
      expect(r.rows).toHaveLength(10);
      expect(r.rows[9]).toMatchObject({ customer_id: 't11', rank: 10, spending: 20000 });
      await h.close();
    }
    expect(winners[0]).toEqual(winners[1]);
    h = await makeHarness(); // for afterEach
  });

  it('7. a campaign in draft, pending approval, or cancelled status cannot send, even through a direct API call', async () => {
    h = await makeHarness();
    await threeCustomers();
    const api = await h.http();
    const call = (path: string, body: unknown = {}, token: string | null = api.token) =>
      fetch(api.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });

    const draft = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    expect((await call(`/api/campaigns/${draft.id}/approve-send`, { confirmRecipientCount: 0 })).status).toBe(409); // DRAFT
    expect((await call(`/api/campaigns/${draft.id}/approve-send`, { confirmRecipientCount: 3 }, null)).status).toBe(401); // no session

    await h.services.campaigns.generate(draft.id, ADMIN);
    // Pending approval: push the jobs straight at the worker, as a bug or an attacker might.
    const ids = (await h.ctx.db.query<{ id: number }>(`SELECT id FROM marketing.messages`)).rows.map((r) => r.id);
    await h.ctx.queue.add(ids.map((messageId) => ({ messageId })));
    for (const id of ids) await h.sender.processMessage(id);
    await h.drain();
    expect(h.mock.sent).toHaveLength(0);
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.messages WHERE status = 'PENDING'`)).toBe(3);

    // A wrong recipient count on the confirmation is refused too.
    expect((await call(`/api/campaigns/${draft.id}/approve-send`, { confirmRecipientCount: 2 })).status).toBe(409);

    expect((await call(`/api/campaigns/${draft.id}/cancel`)).status).toBe(200);
    expect((await call(`/api/campaigns/${draft.id}/approve-send`, { confirmRecipientCount: 3 })).status).toBe(409); // CANCELLED
    for (const id of ids) await h.sender.processMessage(id);
    await h.drain();
    expect(h.mock.sent).toHaveLength(0);
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.coupons WHERE status = 'ACTIVE'`)).toBe(0);
  });

  it('8. a February 29 birthday is sent on February 28 in a non-leap year', async () => {
    h = await makeHarness({ now: istToUtc(2027, 2, 28, 10, 0) });
    await h.addCustomer({ id: 'leap', firstName: 'Leela', phone: phone(), dob: '1996-02-29' });
    expect((await h.services.birthday.run()).queued).toBe(1);
    await h.drain();
    expect(h.mock.sent).toHaveLength(1);

    // Leap year: nothing on the 28th, sent on the 29th.
    h.clock.now = istToUtc(2028, 2, 28, 10, 0);
    expect((await h.services.birthday.run()).found).toBe(0);
    h.clock.now = istToUtc(2028, 2, 29, 10, 0);
    expect((await h.services.birthday.run()).queued).toBe(1);
  });

  it('9. a webhook with a bad signature is rejected', async () => {
    h = await makeHarness();
    await threeCustomers();
    await h.services.birthday.run();
    await h.drain();
    const waId = h.mock.sent[0].messageId;
    const api = await h.http();
    const post = (body: string, signature?: string) =>
      fetch(`${api.url}/webhooks/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Hub-Signature-256': signature } : {}) },
        body,
      });
    const statusBody = (status: string) => JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: waId, status, timestamp: '1789800000' }] } }] }] });

    expect((await post(statusBody('read'))).status).toBe(401);
    expect((await post(statusBody('read'), signBody(statusBody('read'), 'wrong-secret'))).status).toBe(401);
    expect((await post(statusBody('read'), signBody(statusBody('delivered'), APP_SECRET))).status).toBe(401); // body tampered
    const msg = async () => (await h.ctx.db.query(`SELECT status FROM marketing.messages WHERE whatsapp_message_id = $1`, [waId])).rows[0].status;
    expect(await msg()).toBe('SENT');

    expect((await post(statusBody('read'), signBody(statusBody('read'), APP_SECRET))).status).toBe(200);
    expect(await msg()).toBe('READ');
    // Statuses only move forward: a late "delivered" does not downgrade "read".
    expect((await post(statusBody('delivered'), signBody(statusBody('delivered'), APP_SECRET))).status).toBe(200);
    expect(await msg()).toBe('READ');
  });

  it('10. the marketing database role cannot write to users or orders', async () => {
    h = await makeHarness();
    await threeCustomers();
    await h.ctx.db.exec(fs.readFileSync('sql/create-marketing-role.sql', 'utf8'));
    await h.ctx.db.exec('SET ROLE marketing_app');
    try {
      await expect(h.ctx.db.query(`UPDATE users SET "firstName" = 'Hacked'`)).rejects.toThrow(/permission denied/i);
      await expect(h.ctx.db.query(`DELETE FROM orders`)).rejects.toThrow(/permission denied/i);
      await expect(h.ctx.db.query(`INSERT INTO users (id) VALUES ('x')`)).rejects.toThrow(/permission denied/i);
      await expect(h.ctx.db.query(`UPDATE coupons SET value = 1`)).rejects.toThrow(/permission denied/i);
      // ...while its real work still succeeds under that role.
      const run = await h.services.birthday.run();
      await h.drain();
      expect(run.queued).toBe(1);
      expect(h.mock.sent).toHaveLength(1);
    } finally {
      await h.ctx.db.exec('RESET ROLE');
    }
  });
});

describe('Other guarantees', () => {
  it('Top 10: a top spender without opt-in is shown as not contactable and is not replaced, unless backfill is on', async () => {
    for (const backfill of [false, true]) {
      h = await makeHarness();
      for (let i = 1; i <= 12; i++) {
        const id = `s${String(i).padStart(2, '0')}`;
        await h.addCustomer({ id, firstName: `Name${i}`, phone: phone(), optIn: i !== 2 });
        await h.addOrder({ id: `o${i}`, userId: id, amount: 40000 - i * 1000, createdAt: istToUtc(2026, 8, 5, 12, 0) });
      }
      const c = await h.services.campaigns.createTop10({ ...TOP10, backfill }, ADMIN);
      const g = await h.services.campaigns.generate(c.id, ADMIN);
      const r = await h.services.campaigns.recipients(c.id);
      expect(r.rows[1]).toMatchObject({ customer_id: 's02', rank: 2, contactable: false, reason: 'NO_OPT_IN', coupon_code: null });
      expect(g.targetCount).toBe(backfill ? 10 : 9);
      expect(r.rows).toHaveLength(backfill ? 11 : 10);

      await h.services.campaigns.approveAndSend(c.id, ADMIN);
      await h.drain();
      expect(h.mock.sent).toHaveLength(backfill ? 10 : 9);
      expect(h.mock.sent.every((s) => s.bodyParams?.[1] === '₹2,000' && /^TOP2000-[A-Z2-9]{6}$/.test(s.bodyParams![2]))).toBe(true);
      await h.close();
    }
    h = await makeHarness();
  });

  it('Top 10: the current month is blocked and a month can only have one campaign', async () => {
    h = await makeHarness();
    await expect(h.services.campaigns.createTop10({ ...TOP10, targetMonth: '2026-09' }, ADMIN)).rejects.toMatchObject({ code: 'MONTH_NOT_FINISHED' });
    const first = await h.services.campaigns.createTop10(TOP10, ADMIN);
    await expect(h.services.campaigns.createTop10(TOP10, ADMIN)).rejects.toMatchObject({ code: 'DUPLICATE_MONTH' });
    await h.services.campaigns.cancel(first.id, ADMIN);
    await expect(h.services.campaigns.createTop10(TOP10, ADMIN)).resolves.toMatchObject({ status: 'DRAFT' });
  });

  it('existing_table mode: coupons reach the store table only at approval, and cancel deactivates unsent ones', async () => {
    h = await makeHarness();
    await threeCustomers();
    const c = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    await h.services.campaigns.generate(c.id, ADMIN);
    expect(await count(`SELECT COUNT(*)::int AS n FROM coupons`)).toBe(0); // preview only

    await h.services.campaigns.approveAndSend(c.id, ADMIN);
    await h.drain();
    const store = await h.ctx.db.query(`SELECT code, type::text AS type, value::float8 AS value, "usageLimit", "isActive", to_char("expiresAt", 'YYYY-MM-DD HH24:MI:SS') AS expires FROM coupons ORDER BY code`);
    expect(store.rows).toHaveLength(3);
    expect(store.rows[0]).toMatchObject({ type: 'PERCENTAGE', value: 20, usageLimit: 1, isActive: true });
    // Stored as UTC wall time: 25 October 23:59:59.999 IST is 18:29:59.999 UTC.
    expect(store.rows[0].expires).toBe('2026-10-25 18:29:59');

    // The store records the code on an order. The sync marks our coupon used.
    const code = store.rows[0].code;
    await h.ctx.db.query(`INSERT INTO orders (id, "userId", status, "totalAmount", "couponCode") VALUES ('ord-x', 'c1', 'CONFIRMED', 4000, $1)`, [code]);
    expect(await h.services.coupons.syncStoreUsage()).toBe(1);
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.coupons WHERE status = 'USED' AND used_order_id = 'ord-x'`)).toBe(1);
  });

  it('a STOP reply opts the customer out, confirms once, and stops pending messages', async () => {
    h = await makeHarness();
    await threeCustomers();
    const c = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    await h.services.campaigns.generate(c.id, ADMIN);
    const to = (await h.ctx.db.query<{ phone_number: string }>(`SELECT phone_number FROM marketing.messages WHERE customer_id = 'c2'`)).rows[0].phone_number;

    await h.services.webhook.handleInbound({ id: 'wamid.in.1', from: to.replace('+', ''), text: ' Stop. ' });
    await h.services.webhook.handleInbound({ id: 'wamid.in.1', from: to.replace('+', ''), text: ' Stop. ' }); // redelivered
    await h.services.webhook.handleInbound({ id: 'wamid.in.2', from: to.replace('+', ''), text: 'STOP' });

    expect(h.mock.sent.filter((s) => s.kind === 'text')).toHaveLength(1);
    await h.services.campaigns.approveAndSend(c.id, ADMIN);
    await h.drain();
    expect(h.mock.templatesSentTo(to)).toHaveLength(0);
    expect(h.mock.sent.filter((s) => s.kind === 'template')).toHaveLength(2);

    // Opted-out customers are excluded from the next audience as well.
    const next = await h.services.campaigns.createFestival({ ...FESTIVAL, name: 'Second' }, ADMIN);
    expect((await h.services.campaigns.generate(next.id, ADMIN)).generationSummary).toMatchObject({ messages: 2, excluded: { OPTED_OUT: 1 } });
  });

  it('retries only what is safe to retry, and records distinct failure reasons', async () => {
    h = await makeHarness();
    await threeCustomers();
    const c = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    await h.services.campaigns.generate(c.id, ADMIN);
    h.mock.failNext(new WhatsAppError('RATE_LIMITED', 'slow down', true, 130429)); // retried, then succeeds
    h.mock.failNext(new WhatsAppError('MARKETING_LIMIT', 'per-user cap', false, 131049)); // final

    await h.services.campaigns.approveAndSend(c.id, ADMIN);
    await h.drain();

    const rows = (await h.ctx.db.query(`SELECT status, error_code, attempts FROM marketing.messages ORDER BY status, attempts`)).rows;
    expect(rows.filter((r: any) => r.status === 'SENT')).toHaveLength(2);
    expect(rows.find((r: any) => r.status === 'FAILED')).toMatchObject({ error_code: 'MARKETING_LIMIT', attempts: 1 });
    expect(rows.some((r: any) => r.status === 'SENT' && r.attempts === 2)).toBe(true);
    expect(h.mock.sent).toHaveLength(2);
    // The customer who never got the message does not keep a live coupon.
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.coupons WHERE status = 'CANCELLED'`)).toBe(1);
    expect((await h.services.campaigns.get(c.id)).status).toBe('COMPLETED');
  });

  it('a large audience is spread across days according to the daily tier', async () => {
    h = await makeHarness();
    for (let i = 0; i < 5; i++) await h.addCustomer({ id: `d${i}`, firstName: `D${i}`, phone: phone() });
    await h.ctx.db.query(`UPDATE marketing.settings SET value = value || '{"dailyTierLimit": 2}'::jsonb WHERE key = 'general'`);
    const c = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    await h.services.campaigns.generate(c.id, ADMIN);
    expect(await h.services.campaigns.sendSummary(c.id)).toMatchObject({ recipientCount: 5, daysNeeded: 3, estimatedCostInr: 4.5 });

    await h.services.campaigns.approveAndSend(c.id, ADMIN);
    await h.drain();
    expect(h.mock.sent).toHaveLength(2);
    expect((await h.services.campaigns.get(c.id)).status).toBe('SENDING');

    h.clock.now = istToUtc(2026, 9, 20, 9, 5);
    await h.sender.enqueueDue();
    await h.drain();
    expect(h.mock.sent).toHaveLength(4);

    h.clock.now = istToUtc(2026, 9, 21, 9, 5);
    await h.sender.enqueueDue();
    await h.drain();
    expect(h.mock.sent).toHaveLength(5);
    expect((await h.services.campaigns.get(c.id)).status).toBe('COMPLETED');
  });

  it('editing a campaign that awaits approval returns it to draft and discards what was generated', async () => {
    h = await makeHarness();
    await threeCustomers();
    const c = await h.services.campaigns.createFestival(FESTIVAL, ADMIN);
    await h.services.campaigns.generate(c.id, ADMIN);
    const edited = await h.services.campaigns.update(c.id, { discountValue: 25 }, ADMIN);
    expect(edited).toMatchObject({ status: 'DRAFT', discountValue: 25, couponPrefix: 'DIWALI20', targetCount: 0 });
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.coupons`)).toBe(0);
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.messages`)).toBe(0);
    await expect(h.services.campaigns.approveAndSend(c.id, ADMIN)).rejects.toMatchObject({ status: 409 });
  });

  it('birthday: respects the off switch, the send window, implausible dates, and an unapproved template', async () => {
    h = await makeHarness();
    await threeCustomers();
    await h.addCustomer({ id: 'old', firstName: 'Placeholder', phone: phone(), dob: '1900-09-19' });

    h.clock.now = istToUtc(2026, 9, 19, 7, 0);
    expect((await h.services.birthday.run()).status).toBe('OUTSIDE_WINDOW');
    h.clock.now = istToUtc(2026, 9, 19, 20, 30);
    expect((await h.services.birthday.run()).status).toBe('OUTSIDE_WINDOW');

    h.clock.now = istToUtc(2026, 9, 19, 10, 0);
    await h.ctx.db.query(`UPDATE marketing.templates SET approval_status = 'PENDING' WHERE name = 'birthday_offer'`);
    expect((await h.services.birthday.run()).status).toBe('TEMPLATE_NOT_APPROVED');
    expect(await count(`SELECT COUNT(*)::int AS n FROM marketing.messages`)).toBe(0); // nothing burned for this year
    await h.ctx.db.query(`UPDATE marketing.templates SET approval_status = 'APPROVED' WHERE name = 'birthday_offer'`);

    await h.ctx.db.query(`UPDATE marketing.settings SET value = value || '{"enabled": false}'::jsonb WHERE key = 'birthday'`);
    expect((await h.services.birthday.run()).status).toBe('DISABLED');
    await h.ctx.db.query(`UPDATE marketing.settings SET value = value || '{"enabled": true}'::jsonb WHERE key = 'birthday'`);

    const ok = await h.services.birthday.run();
    await h.drain();
    expect(ok).toMatchObject({ status: 'OK', found: 2, queued: 1, skipped: { IMPLAUSIBLE_DOB: 1 } });
    expect(await count(`SELECT COUNT(*)::int AS n FROM coupons WHERE code LIKE 'BD300-%'`)).toBe(1); // published to the store at once
  });

  it('store integration endpoints need the API key; admin endpoints need a session', async () => {
    h = await makeHarness({ env: { couponMode: 'api' } });
    await threeCustomers();
    const api = await h.http();
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(api.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

    expect((await post('/api/integration/opt-out', { customerId: 'c1' })).status).toBe(401);
    expect((await post('/api/integration/opt-out', { customerId: 'c1' }, { 'x-api-key': 'nope' })).status).toBe(401);
    expect((await post('/api/integration/opt-out', { customerId: 'c1' }, { 'x-api-key': API_KEY })).status).toBe(200);
    expect((await fetch(`${api.url}/api/dashboard`)).status).toBe(401);
    const dash = await fetch(`${api.url}/api/dashboard`, { headers: { Authorization: `Bearer ${api.token}` } });
    expect(dash.status).toBe(200);
    expect(await dash.json()).toMatchObject({ totalCustomers: 3, eligibleCustomers: 2 });
    expect((await fetch(`${api.url}/api/dashboard`, { headers: { Authorization: `Bearer ${api.token}x` } })).status).toBe(401);
  });

  it('configuration guards: the mock cannot run in production and the real provider cannot run in tests', () => {
    h = undefined as unknown as Harness;
    expect(() => loadEnv({}, { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'y'.repeat(40) })).toThrow(/mock is not allowed in production/);
    expect(() => loadEnv({}, { NODE_ENV: 'test', WHATSAPP_PROVIDER: 'cloud', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v' })).toThrow(/not allowed when NODE_ENV=test/);
    expect(() => loadEnv({}, { NODE_ENV: 'production', WHATSAPP_PROVIDER: 'cloud', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v', SESSION_SECRET: 'y'.repeat(40) })).toThrow(/DATABASE_URL is required/);
  });
});

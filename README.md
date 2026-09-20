# WhatsApp Marketing Backend

A separate Node.js service that sits beside an existing e-commerce store and sends
personalised WhatsApp offers through the official WhatsApp Business Cloud API.

| Campaign | How it starts | Approval |
| --- | --- | --- |
| 🎂 Birthday | Automatic, every day at 9:00 AM India time | None needed |
| 🎉 Festival | An admin creates it | Admin must click **Approve & Send** |
| 🏆 Month-End Top 10 | An admin picks a finished month | Admin must click **Approve & Send** |

The store's website, customers, and orders are never modified. This service reads
them and keeps everything of its own in a separate `marketing` database schema.

## Try it in two minutes

No database, Redis, or WhatsApp account is needed for a first look.

```bash
npm install
npm run dev
```

Open http://localhost:4100/admin/marketing/ and sign in with `admin@example.com` / `admin12345`.

This mode runs on an embedded PostgreSQL with 18 fake customers and last month's
orders. The WhatsApp provider is a mock: nothing is sent, every message is recorded,
and delivery and read receipts are simulated. Try **Top 10 → New → Generate → Approve & Send**.

```bash
npm test          # 20 tests, including the 10 acceptance tests in PLAN-ADDENDUM.md
npm run typecheck
```

## Connect it to the real store

### 1. Inspect the store database (read-only)

```bash
DATABASE_URL=postgres://owner:...@host/db npm run inspect-schema
```

It prints the user, order, and coupon tables and answers four questions: is there a
coupon table, is there an opt-in column, what are the order statuses, and how do admins sign in.

### 2. Map the names

Edit [schema-mapping.json](schema-mapping.json). It is the only file that contains the
store's table and column names. The defaults match the VKC store schema:

- `users`: `firstName`, `lastName`, `phone`, `dob`. Staff, admin, inactive, and blocked accounts are excluded.
- `orders`: `totalAmount`, `createdAt`, `status`. Only `DELIVERED` orders count towards Top 10.
- `coupons`: the store already has a coupon table, so marketing coupons are copied into it.
- There is **no opt-in column** in that store. See "Consent" below. This matters.

### 3. Create the tables and a least-privilege role

```bash
DATABASE_URL=postgres://owner:...@host/db npm run migrate
psql "postgres://owner:...@host/db" -f sql/create-marketing-role.sql   # change the password inside first
```

Then run the service as `marketing_app`. That role can read `users` and `orders`, can
add rows to `coupons`, and cannot change a customer or an order. A test proves it.

### 4. Configure and start

Copy `.env.example` to `.env`. For production you need `DATABASE_URL`, `SESSION_SECRET`,
`WHATSAPP_PROVIDER=cloud` with its five WhatsApp values, and ideally `REDIS_URL`.

```bash
NODE_ENV=production npm start
```

The service refuses to start in production with the mock provider, and refuses to use
the real provider when `NODE_ENV=test`.

Admins sign in with their existing store admin account (bcrypt hashes are read, never
written). To add a marketing-only admin: `npm run create-admin -- name@example.com "long-password"`.

## Start Meta onboarding on day one

This is the longest wait in the project, and none of it is code.

1. Verify the business in Meta Business Manager and register the WhatsApp phone number.
2. In WhatsApp Manager create three templates, category **Marketing**, language `en`, named
   `birthday_offer`, `festival_offer`, and `top10_reward`. The exact bodies are shown under
   **Settings → WhatsApp templates** in the dashboard and in
   [whatsapp.template.ts](src/whatsapp/whatsapp.template.ts).
3. Point the webhook at `https://your-host/webhooks/whatsapp`, set the verify token, and subscribe to `messages`.
4. When Meta approves a template, press **Sync statuses from Meta** in Settings.

Message text is fixed by Meta's approval. Only the variables change per customer.
Changing the wording means submitting a new template. Until a template is approved,
the birthday job does nothing and **Approve & Send** is refused.

## Consent

Only customers with a recorded opt-in, a valid WhatsApp number, and no opt-out are ever messaged.
No record means **not opted in**. With the VKC store as it stands, that is every customer,
so nothing can be sent until consent is collected. Three ways to record it:

- **From the store** (recommended): add a "Send me offers on WhatsApp" checkbox and call
  `POST /api/integration/opt-in` with `{ "customerId": "..." }` and the `x-api-key` header.
- **From the dashboard**: Customers → Record opt-in, with a note saying where consent was given.
- **Opt-out** is automatic: a customer who replies STOP is opted out at once, their pending
  messages are stopped, and they get one confirmation. `POST /api/integration/opt-out` does the same.

## Coupons and the checkout

Codes look like `TOP2000-K7M2QX`. The random part cannot be guessed, and two customers
named Rahul can never collide. Uniqueness is enforced by a database index.

| `COUPON_MODE` | How redemption works | Change to the store |
| --- | --- | --- |
| `existing_table` (default) | Coupons are copied into the store's `coupons` table. Birthday coupons at creation, campaign coupons only at approval. The store redeems them as usual. A background job reads `orders.couponCode` to mark them used. | None |
| `api` | Checkout calls `POST /api/integration/coupons/validate` and `/redeem`. | Two HTTP calls in checkout |

One limitation to know: the store's coupon table has no customer column, so in
`existing_table` mode a coupon is single-use but is not tied to one account. The
unguessable code is the protection. `api` mode enforces the customer binding, atomically.

## Safety rules, and where they live

| Rule | Enforced by |
| --- | --- |
| Festival and Top 10 never send without approval | One conditional `UPDATE ... WHERE status = 'PENDING_APPROVAL'`. The worker also re-checks the campaign is `SENDING` before every message. There is no scheduled trigger for these campaigns. |
| Clicking Send twice sends once | The same conditional update, plus deterministic queue job ids |
| One birthday message per customer per year | Unique index on `(customer_id, campaign_year)` |
| A customer appears once per campaign | Unique index on `(campaign_id, customer_id)` |
| One Top 10 campaign per month | Partial unique index on `target_month` |
| Opt-out between preview and send is honoured | Eligibility is checked again at send time |
| The approved audience is the sent audience | Audience is snapshotted at generation. The confirm dialog's count is verified by the server. |
| Webhooks are genuine | HMAC signature check on the raw body. Statuses only move forward. |
| Every change is attributable | Append-only `marketing.audit_log` |

Top 10 details: only a finished month can be ranked. Ties break by more orders, then
earlier first order, then lower customer id. A top spender who cannot be contacted is
shown as "Not contactable" and is not replaced, unless the campaign's backfill option is on.
So "send to exactly 10" means "at most 10".

Birthday details: India time regardless of server time zone. February 29 birthdays are
sent on February 28 in non-leap years. Hourly catch-up if the server was down at nine.
No sends before 9:00 or after 20:00. Placeholder dates of birth such as 1900-01-01 are skipped.

## Sending at scale

All sends go through a queue with rate limiting and retry with backoff. Only network
errors, HTTP 429, and 5xx are retried, and never after Meta has returned a message id.
Set `REDIS_URL` to use BullMQ. Without it an in-process queue is used, which is fine
for one server because pending messages are re-queued from the database on restart.

If an audience is larger than your account's daily messaging tier (Settings), the send
is spread over following mornings, and the confirmation dialog says so with an estimated cost.

## Project layout

```
schema-mapping.json          the store's table and column names, in one place
sql/create-marketing-role.sql
src/
  config/        env validation, schema mapping
  db/            pg and embedded drivers, migrations, demo store
  customers/     reads users and orders, eligibility rule, consent
  coupons/       code generation, store-table publishing, atomic redemption
  campaigns/     birthday (automatic), festival and Top 10 (approval workflow)
  messaging/     the send worker: every guard re-checked before each message
  queue/         in-memory and BullMQ queues
  whatsapp/      Cloud API provider, mock provider, templates, webhook
  auth/          admin sessions, store API key
  scheduler/     the only timers: birthday run and housekeeping
  app.ts         HTTP API        server.ts  entry point
public/admin/    the dashboard
tests/           acceptance tests
```

## Not built yet

- AI wording (step 13 of the plan). By design it would only draft new templates for submission to Meta.
- Campaign generation runs inside the HTTP request. Fine for a few thousand customers. Move it to a background job beyond that.
- Bulk consent import from a file.
#   W h a t s a p p  
 
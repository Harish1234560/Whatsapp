# Addendum to the WhatsApp Marketing System Plan

Append this to the original plan. Where this addendum and the original plan
disagree, this addendum wins.

## A1. Coupon redemption is the one allowed change to the existing website

The original plan says the existing site stays unchanged. Coupons are useless
unless checkout can redeem them, so exactly one integration point is allowed.

During schema inspection, check whether the existing site already has a coupon
or discount table.

- If it does: write generated marketing coupons into that table in the format
  the site already understands. Keep `marketing_coupons` as the source of truth
  for campaign linkage and tracking. Do not change checkout code.
- If it does not: expose `POST /api/coupons/validate` and
  `POST /api/coupons/redeem` from the marketing backend. The checkout calls
  these. This is the only change permitted in the existing site.

Stop and report which case applies before building the coupon engine.

Redemption rules:

- A coupon is valid only for the `customer_id` it was issued to. A logged-in
  customer using a code issued to someone else must be rejected.
- Redemption must be atomic: one conditional update from `ACTIVE` to `USED`
  that also sets `used_at` and `used_order_id`. If zero rows change, reject.
- Enforce `valid_from`, `valid_until`, `minimum_order_amount`,
  `maximum_discount`, and `usage_limit` on the server.
- If the order is cancelled or refunded, define whether the coupon returns to
  `ACTIVE`. Default: it does not.

## A2. Coupon code format

Do not use name plus reward alone. `RAHULTOP2000` is guessable, and two
customers named Rahul collide.

Format: `<PREFIX>-<RANDOM>` where RANDOM is 6 characters from
`ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0, O, 1, I, L).

Examples: `BD300-K7M2QX`, `DIWALI20-P9RT4H`, `TOP2000-W3HN8C`.

- Add a unique index on `marketing_coupons.code`.
- On a collision, regenerate. Retry up to 5 times, then fail the job.
- Optionally include a sanitised first name for friendliness, but never rely
  on it for uniqueness. Strip non A-Z characters and cap at 8 characters.

## A3. WhatsApp templates are fixed text approved by Meta

Message bodies cannot be free text. Each campaign type uses a template
approved in advance, with numbered variables.

- Create three templates in the Marketing category: `birthday_offer`,
  `festival_offer`, `top10_reward`.
- Variables only: customer name, discount text, coupon code, expiry date,
  and festival name for the festival template.
- Store per template: name, language code, variable order, and approval status
  in a `marketing_templates` table.
- The admin "change message template" feature selects among approved
  templates. It does not edit text live. New wording means a new template
  submission to Meta and a wait for approval.
- Block sending if the chosen template is not in approved status.
- AI wording in the final step is limited to drafting new templates for
  submission. It never writes per-customer free text.

## A4. Start Meta onboarding on day one

Business verification, phone number registration, display name approval, and
template approval are the longest wait in the project. Start them in parallel
with step 1.

Until credentials exist, build against a `WhatsAppProvider` interface with a
mock implementation that logs sends and simulates status webhooks. Select the
provider with an environment variable. The mock must be impossible to enable
in production by accident, and the real provider impossible in tests.

## A5. Duplicate protection lives in the database

Checks before sending can race. Use constraints.

- `marketing_messages`: unique index on `(campaign_id, customer_id)`.
- Birthday: add `campaign_year` and a unique index on
  `(customer_id, campaign_type, campaign_year)`.
- Insert the message row as `PENDING` before calling the API. If the insert
  violates the unique index, skip the send.
- Approve and send is one conditional update:
  `UPDATE marketing_campaigns SET status = 'SENDING' WHERE id = $1 AND status = 'PENDING_APPROVAL'`.
  If zero rows change, return "already sent or not pending" and enqueue
  nothing. A double click therefore sends once.
- Queue job ids are deterministic: `campaignId:customerId`. BullMQ then drops
  duplicate jobs.
- Retry only errors that are safe to retry: network failures, HTTP 429, and
  5xx. Never retry after the API returned a message id.

## A6. Birthday rules

- Timezone is `Asia/Kolkata` for the scheduler and for the definition of
  "today". Set it explicitly. Do not rely on server time.
- Match on month and day only. Ignore the year of birth.
- February 29 birthdays are sent on February 28 in non-leap years.
- Catch-up: on startup and every hour, run the same job for today. The unique
  index makes reruns safe. Do not send for past days that were missed.
- Do not send before 9:00 or after 20:00 India time.
- Skip customers with a null or implausible date of birth, such as an age
  under 13 or over 110, or a default like 1900-01-01 or 1970-01-01.
- The disable switch must be checked at job start and before each send.

## A7. Top 10 rules

- Spending is the sum of order amounts for orders in completed status whose
  order date falls inside the selected month in India time. Exclude cancelled,
  refunded, and returned orders. Subtract partial refunds if the schema
  records them. Confirm the exact status values during schema inspection.
- Only a fully finished month can be selected. The current month is blocked.
- Ties are broken by higher order count, then earlier first order in the
  month, then lower customer id. The result must be deterministic.
- Ineligible top spenders: rank all spenders, then show the top 10 with an
  eligibility column. A customer without opt-in or without a WhatsApp number
  is shown as "not contactable" and is not messaged. The list is not
  backfilled from rank 11 by default. Make backfill a campaign setting,
  default off. "Send to exactly 10" therefore means at most 10.
- Snapshot: store rank, customer id, and spending in a
  `marketing_campaign_recipients` table at generation time. Approval and
  sending use the snapshot and never recalculate.
- One Top 10 campaign per month. Unique index on `(type, target_month)`,
  ignoring cancelled campaigns.
- Exclude staff, test, and internal accounts if the schema marks them.

## A8. Festival rules

- The original plan shows both a shared code `DIWALI20` and a personal code.
  Use per-customer codes by default. They give attribution and contain leaks.
  Offer a shared code as a campaign option with a total usage cap.
- Audience is snapshotted into `marketing_campaign_recipients` at generation.
  Re-check opt-in for each recipient at send time, because someone may opt
  out between generation and sending.
- Editing a campaign in `PENDING_APPROVAL` returns it to `DRAFT` and discards
  the generated coupons and messages.
- Show the estimated WhatsApp cost on the confirmation screen: recipient count
  multiplied by a configurable per-message rate.
- Respect the daily messaging tier of the WhatsApp account. If the audience
  exceeds the tier, spread the send across days and show this in the preview.

## A9. Opt-in, opt-out, and failures

- If no opt-in column exists, add `marketing_preferences` in the marketing
  schema: customer id, opted-in flag, opt-in source, opt-in time, opt-out
  time. Do not add columns to the existing users table. With no recorded
  consent, the default is not opted in.
- Incoming replies of STOP, UNSUBSCRIBE, or the local-language equivalents
  set the opt-out immediately and cancel pending jobs for that customer.
  Reply once with a confirmation.
- Include an opt-out line or quick-reply button in every template.
- Normalise phone numbers to E.164 with a default country code of +91. Skip
  and log invalid numbers.
- Store the raw error code on failure. Treat the Meta per-user marketing
  limit and "user not on WhatsApp" as distinct, non-retryable reasons, and
  show them separately in analytics.
- Verify the webhook signature on every request. Status updates only move
  forward: sent, delivered, read. Ignore out-of-order downgrades.

## A10. Database access and safety

- Create a dedicated database role for the marketing backend. It gets SELECT
  only on the existing users and orders tables, and full rights only on its
  own tables.
- Put marketing tables in a separate `marketing` schema if the database
  supports it.
- All schema changes go through migration files. Never alter existing tables.
- The schema mapping from step 2 lives in one config file, so existing column
  names appear in one place.
- Keep an append-only `marketing_audit_log`: who created, edited, approved,
  cancelled, or changed settings, and when.

## A11. Admin authentication

Check whether the existing site has admin authentication that can be reused,
such as shared sessions, JWT, or Supabase Auth roles. Reuse it if so. If not,
build separate login for the marketing dashboard with hashed passwords and a
`marketing_admin` role. Report which path applies before building the
approval workflow.

Optional setting, default off: the approver must be a different admin from
the campaign creator.

## A12. Revised development order

This replaces section 25 of the original plan.

```text
DAY 1, in parallel   Start Meta verification and submit the three templates
STEP 1               Database connection with the read-only role
STEP 2               Schema inspection and mapping. STOP and report:
                     coupon table? opt-in column? order statuses? admin auth?
STEP 3               Marketing tables, unique indexes, audit log
STEP 4               Coupon engine plus the redemption path from A1
STEP 5               WhatsApp provider interface with mock implementation
STEP 6               Queue, deterministic job ids, retry rules
STEP 7               Birthday automatic system
STEP 8               Admin auth and approval workflow
STEP 9               Festival campaign
STEP 10              Month-End Top 10
STEP 11              Real WhatsApp Cloud API provider and webhooks
STEP 12              Analytics dashboard
STEP 13              Optional AI drafting of new templates
```

The queue moves ahead of the campaigns so that no send path ever exists
without it.

## A13. Acceptance tests

The build is not done until these pass against the mock provider:

1. Running the birthday job twice on the same day sends one message per
   customer.
2. Two simultaneous approve requests on one campaign enqueue one set of jobs.
3. A customer who opts out after generation and before sending gets nothing.
4. A coupon cannot be redeemed by a different customer, twice, or after
   expiry.
5. Two customers with the same first name receive different coupon codes.
6. A Top 10 tie at rank 10 resolves the same way on every run.
7. A campaign in draft, pending approval, or cancelled status cannot send,
   even through a direct API call.
8. A February 29 birthday is sent on February 28 in a non-leap year.
9. A webhook with a bad signature is rejected.
10. The marketing database role cannot write to users or orders.

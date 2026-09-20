-- Marketing module tables. Everything lives in its own schema.
-- Existing store tables are never altered.

CREATE SCHEMA IF NOT EXISTS marketing;

CREATE TABLE marketing.admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'marketing_admin',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE marketing.settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE marketing.templates (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  campaign_type   TEXT NOT NULL CHECK (campaign_type IN ('BIRTHDAY','FESTIVAL','MONTH_END_TOP10')),
  language        TEXT NOT NULL DEFAULT 'en',
  body            TEXT NOT NULL,
  variables       JSONB NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','REJECTED','PAUSED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE marketing.campaigns (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('BIRTHDAY','FESTIVAL','MONTH_END_TOP10')),
  status               TEXT NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT','GENERATING','PENDING_APPROVAL','APPROVED','SENDING','COMPLETED','CANCELLED','FAILED')),
  festival_name        TEXT,
  start_date           TEXT CHECK (start_date IS NULL OR start_date ~ '^\d{4}-\d{2}-\d{2}$'),
  end_date             TEXT CHECK (end_date IS NULL OR end_date ~ '^\d{4}-\d{2}-\d{2}$'),
  target_month         TEXT CHECK (target_month IS NULL OR target_month ~ '^\d{4}-\d{2}$'),
  campaign_year        INT,
  discount_type        TEXT NOT NULL CHECK (discount_type IN ('FLAT','PERCENT')),
  discount_value       NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
  minimum_order_amount NUMERIC(10,2),
  maximum_discount     NUMERIC(10,2),
  coupon_mode          TEXT NOT NULL DEFAULT 'PER_CUSTOMER' CHECK (coupon_mode IN ('PER_CUSTOMER','SHARED')),
  shared_coupon_code   TEXT,
  shared_usage_cap     INT,
  coupon_prefix        TEXT NOT NULL,
  valid_from           TIMESTAMPTZ,
  valid_until          TIMESTAMPTZ,
  template_name        TEXT NOT NULL,
  backfill             BOOLEAN NOT NULL DEFAULT FALSE,
  target_count         INT NOT NULL DEFAULT 0,
  generation_summary   JSONB,
  error                TEXT,
  created_by           TEXT,
  approved_by          TEXT,
  approved_at          TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (discount_type <> 'PERCENT' OR discount_value <= 100)
);

-- One Top 10 campaign per month, ignoring cancelled ones.
CREATE UNIQUE INDEX campaigns_top10_month_uq
  ON marketing.campaigns (target_month)
  WHERE type = 'MONTH_END_TOP10' AND status <> 'CANCELLED';

-- One birthday campaign row per year.
CREATE UNIQUE INDEX campaigns_birthday_year_uq
  ON marketing.campaigns (campaign_year)
  WHERE type = 'BIRTHDAY';

CREATE TABLE marketing.coupons (
  id                   SERIAL PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,
  customer_id          TEXT,
  campaign_id          INT NOT NULL REFERENCES marketing.campaigns(id),
  discount_type        TEXT NOT NULL CHECK (discount_type IN ('FLAT','PERCENT')),
  discount_value       NUMERIC(10,2) NOT NULL,
  minimum_order_amount NUMERIC(10,2),
  maximum_discount     NUMERIC(10,2),
  valid_from           TIMESTAMPTZ NOT NULL,
  valid_until          TIMESTAMPTZ NOT NULL,
  usage_limit          INT NOT NULL DEFAULT 1,
  used_count           INT NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','USED','EXPIRED','CANCELLED')),
  used_at              TIMESTAMPTZ,
  used_order_id        TEXT,
  in_store_table       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX coupons_campaign_idx ON marketing.coupons (campaign_id);
CREATE INDEX coupons_customer_idx ON marketing.coupons (customer_id);
CREATE INDEX coupons_status_idx ON marketing.coupons (status);

-- One redemption per customer per coupon. Also makes shared codes single-use per customer.
CREATE TABLE marketing.coupon_redemptions (
  id          SERIAL PRIMARY KEY,
  coupon_id   INT NOT NULL REFERENCES marketing.coupons(id),
  customer_id TEXT NOT NULL,
  order_id    TEXT NOT NULL,
  discount    NUMERIC(10,2) NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (coupon_id, customer_id)
);

-- Audience snapshot taken at generation time. Approval and sending never recalculate.
CREATE TABLE marketing.campaign_recipients (
  id            SERIAL PRIMARY KEY,
  campaign_id   INT NOT NULL REFERENCES marketing.campaigns(id),
  customer_id   TEXT NOT NULL,
  customer_name TEXT,
  phone         TEXT,
  rank          INT,
  spending      NUMERIC(12,2),
  order_count   INT,
  contactable   BOOLEAN NOT NULL,
  reason        TEXT,
  coupon_id     INT REFERENCES marketing.coupons(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, customer_id)
);

CREATE TABLE marketing.messages (
  id                  SERIAL PRIMARY KEY,
  campaign_id         INT NOT NULL REFERENCES marketing.campaigns(id),
  campaign_type       TEXT NOT NULL,
  campaign_year       INT,
  customer_id         TEXT NOT NULL,
  customer_name       TEXT,
  phone_number        TEXT NOT NULL,
  template_name       TEXT NOT NULL,
  template_language   TEXT NOT NULL DEFAULT 'en',
  template_params     JSONB NOT NULL,
  rendered_body       TEXT NOT NULL,
  coupon_id           INT REFERENCES marketing.coupons(id),
  whatsapp_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DELIVERED','READ','FAILED','SKIPPED')),
  attempts            INT NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  scheduled_for       TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  error_code          TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A customer appears once per campaign. A second insert fails safely.
CREATE UNIQUE INDEX messages_campaign_customer_uq ON marketing.messages (campaign_id, customer_id);

-- A customer gets one birthday message per year, whatever happens to campaign rows.
CREATE UNIQUE INDEX messages_birthday_year_uq
  ON marketing.messages (customer_id, campaign_year)
  WHERE campaign_type = 'BIRTHDAY';

CREATE UNIQUE INDEX messages_wa_id_uq ON marketing.messages (whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;
CREATE INDEX messages_status_idx ON marketing.messages (status, scheduled_for);
CREATE INDEX messages_phone_idx ON marketing.messages (phone_number);

-- Consent. No recorded consent means NOT opted in.
CREATE TABLE marketing.preferences (
  customer_id    TEXT PRIMARY KEY,
  opted_in       BOOLEAN NOT NULL DEFAULT FALSE,
  opt_in_source  TEXT,
  opted_in_at    TIMESTAMPTZ,
  opted_out_at   TIMESTAMPTZ,
  opt_out_source TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE marketing.inbound_messages (
  id            SERIAL PRIMARY KEY,
  wa_message_id TEXT UNIQUE,
  from_phone    TEXT NOT NULL,
  customer_id   TEXT,
  body          TEXT,
  is_opt_out    BOOLEAN NOT NULL DEFAULT FALSE,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only. The application never updates or deletes rows here.
CREATE TABLE marketing.audit_log (
  id         SERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON marketing.audit_log (created_at DESC);

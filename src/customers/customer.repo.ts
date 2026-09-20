import type { Queryable } from '../db/db.js';
import { q, qTable, storeTs, type SchemaMapping } from '../config/schema-mapping.js';
import { normalizePhone } from '../util/phone.js';
import { ageOn } from '../util/time.js';

export interface StoreCustomer {
  customerId: string;
  name: string | null;
  phone: string | null;
  dob: string | null; // YYYY-MM-DD
  optedIn: boolean;
  optedOut: boolean;
}

export interface SpendingCustomer extends StoreCustomer {
  spending: number;
  orderCount: number;
}

export interface ContactAssessment {
  contactable: boolean;
  reason: string | null;
  phoneE164: string | null;
}

/** The single eligibility rule used before every campaign and again before every send. */
export function assessContact(c: Pick<StoreCustomer, 'phone' | 'optedIn' | 'optedOut'>): ContactAssessment {
  if (!c.phone) return { contactable: false, reason: 'NO_WHATSAPP_NUMBER', phoneE164: null };
  const phoneE164 = normalizePhone(c.phone);
  if (!phoneE164) return { contactable: false, reason: 'INVALID_PHONE', phoneE164: null };
  if (c.optedOut) return { contactable: false, reason: 'OPTED_OUT', phoneE164 };
  if (!c.optedIn) return { contactable: false, reason: 'NO_OPT_IN', phoneE164 };
  return { contactable: true, reason: null, phoneE164 };
}

/** Rejects null, placeholder, and implausible dates of birth. */
export function isPlausibleDob(dob: string | null, now: Date): boolean {
  if (!dob) return false;
  if (dob === '1900-01-01' || dob === '1970-01-01') return false;
  const age = ageOn(dob, now);
  return age >= 13 && age <= 110;
}

export function firstName(name: string | null): string {
  const n = (name ?? '').trim().split(/\s+/)[0];
  return n || 'there';
}

function mapRow(r: any): StoreCustomer {
  return {
    customerId: r.customer_id,
    name: r.name,
    phone: r.phone,
    dob: r.dob,
    optedIn: r.opted_in === true,
    optedOut: r.opted_out === true,
  };
}

export class CustomerRepo {
  constructor(private mapping: SchemaMapping) {}

  private select(): string {
    const u = this.mapping.users;
    const nameExpr = `NULLIF(TRIM(CONCAT_WS(' ', ${u.nameColumns.map((c) => `u.${q(c)}`).join(', ')})), '')`;
    const storeOptIn = u.optIn ? `COALESCE(u.${q(u.optIn)}, FALSE)` : 'FALSE';
    return `
      SELECT u.${q(u.id)}::text AS customer_id,
             ${nameExpr} AS name,
             u.${q(u.phone)}::text AS phone,
             to_char(u.${q(u.dateOfBirth)}::date, 'YYYY-MM-DD') AS dob,
             (${storeOptIn} OR COALESCE(p.opted_in, FALSE)) AS opted_in,
             (p.opted_out_at IS NOT NULL) AS opted_out
      FROM ${qTable(u.table)} u
      LEFT JOIN marketing.preferences p ON p.customer_id = u.${q(u.id)}::text`;
  }

  private baseWhere(): string {
    return this.mapping.users.onlyWhere ? `(${this.mapping.users.onlyWhere})` : 'TRUE';
  }

  /** Customers whose birthday is the given India-time day. Feb 29 birthdays are included on Feb 28 when asked. */
  async findBirthdays(db: Queryable, month: number, day: number, includeFeb29: boolean): Promise<StoreCustomer[]> {
    const dob = `u.${q(this.mapping.users.dateOfBirth)}::date`;
    const match = `(EXTRACT(MONTH FROM ${dob}) = $1 AND EXTRACT(DAY FROM ${dob}) = $2)`;
    const feb29 = includeFeb29 ? ` OR (EXTRACT(MONTH FROM ${dob}) = 2 AND EXTRACT(DAY FROM ${dob}) = 29)` : '';
    const r = await db.query(
      `${this.select()} WHERE ${this.baseWhere()} AND u.${q(this.mapping.users.dateOfBirth)} IS NOT NULL AND (${match}${feb29})
       ORDER BY customer_id`,
      [month, day],
    );
    return r.rows.map(mapRow);
  }

  async findAll(db: Queryable): Promise<StoreCustomer[]> {
    const r = await db.query(`${this.select()} WHERE ${this.baseWhere()} ORDER BY customer_id`);
    return r.rows.map(mapRow);
  }

  async findById(db: Queryable, customerId: string): Promise<StoreCustomer | null> {
    const r = await db.query(`${this.select()} WHERE u.${q(this.mapping.users.id)}::text = $1`, [customerId]);
    return r.rows[0] ? mapRow(r.rows[0]) : null;
  }

  async findByPhoneLast10(db: Queryable, digits10: string): Promise<StoreCustomer[]> {
    const r = await db.query(
      `${this.select()} WHERE RIGHT(REGEXP_REPLACE(COALESCE(u.${q(this.mapping.users.phone)}::text, ''), '\\D', '', 'g'), 10) = $1`,
      [digits10],
    );
    return r.rows.map(mapRow);
  }

  async list(db: Queryable, opts: { search?: string; limit: number; offset: number }): Promise<{ rows: StoreCustomer[]; total: number }> {
    const params: unknown[] = [];
    let where = this.baseWhere();
    if (opts.search) {
      params.push(`%${opts.search}%`);
      const u = this.mapping.users;
      const nameExpr = `CONCAT_WS(' ', ${u.nameColumns.map((c) => `u.${q(c)}`).join(', ')})`;
      where += ` AND (${nameExpr} ILIKE $1 OR u.${q(u.phone)}::text ILIKE $1)`;
    }
    const total = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ${qTable(this.mapping.users.table)} u WHERE ${where}`,
      params,
    );
    params.push(opts.limit, opts.offset);
    const r = await db.query(
      `${this.select()} WHERE ${where} ORDER BY customer_id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows: r.rows.map(mapRow), total: total.rows[0]?.n ?? 0 };
  }

  async counts(db: Queryable): Promise<{ total: number; eligible: number }> {
    const r = await db.query<{ total: number; eligible: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE c.phone IS NOT NULL AND c.opted_in AND NOT c.opted_out)::int AS eligible
       FROM (${this.select()} WHERE ${this.baseWhere()}) c`,
    );
    return r.rows[0] ?? { total: 0, eligible: 0 };
  }

  /**
   * Ranked spenders for [start, end). Only completed orders count, so cancelled,
   * refunded, and returned orders drop out. Ordering is fully deterministic:
   * spending, then order count, then earliest first order, then customer id.
   */
  async topSpenders(db: Queryable, start: Date, end: Date, limit: number): Promise<SpendingCustomer[]> {
    const o = this.mapping.orders;
    const amount = o.refundedAmount
      ? `(o.${q(o.amount)} - COALESCE(o.${q(o.refundedAmount)}, 0))`
      : `o.${q(o.amount)}`;
    const r = await db.query(
      `WITH spend AS (
         SELECT o.${q(o.userId)}::text AS customer_id,
                SUM(${amount}) AS spending,
                COUNT(*)::int AS order_count,
                MIN(o.${q(o.date)}) AS first_order
         FROM ${qTable(o.table)} o
         WHERE o.${q(o.userId)} IS NOT NULL
           AND o.${q(o.status)}::text = ANY($3::text[])
           AND o.${q(o.date)} >= ${storeTs(this.mapping, '$1')}
           AND o.${q(o.date)} <  ${storeTs(this.mapping, '$2')}
         GROUP BY o.${q(o.userId)}
         HAVING SUM(${amount}) > 0
       )
       SELECT c.*, s.spending::float8 AS spending, s.order_count
       FROM spend s
       JOIN (${this.select()} WHERE ${this.baseWhere()}) c ON c.customer_id = s.customer_id
       ORDER BY s.spending DESC, s.order_count DESC, s.first_order ASC, c.customer_id ASC
       LIMIT $4`,
      [start.toISOString(), end.toISOString(), o.completedStatuses, limit],
    );
    return r.rows.map((row: any) => ({ ...mapRow(row), spending: Number(row.spending), orderCount: row.order_count }));
  }
}

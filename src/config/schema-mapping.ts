import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a plain column name');
const tableIdent = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/, 'must be table or schema.table');

const mappingSchema = z.object({
  timestampStorage: z.enum(['utc_timestamp', 'timestamptz']).default('utc_timestamp'),
  users: z.object({
    table: tableIdent,
    id: ident,
    nameColumns: z.array(ident).min(1),
    phone: ident,
    dateOfBirth: ident,
    optIn: ident.nullable().default(null),
    /** Trusted raw SQL condition using alias `u`. Keeps staff, test, and blocked accounts out. */
    onlyWhere: z.string().nullable().default(null),
  }),
  orders: z.object({
    table: tableIdent,
    id: ident,
    userId: ident,
    amount: ident,
    date: ident,
    status: ident,
    completedStatuses: z.array(z.string()).min(1),
    refundedAmount: ident.nullable().default(null),
    couponCode: ident.nullable().default(null),
  }),
  storeCoupons: z
    .object({
      table: tableIdent,
      id: ident,
      code: ident,
      type: ident,
      typeCast: z.string().nullable().default(null),
      typeValues: z.object({ FLAT: z.string(), PERCENT: z.string() }),
      value: ident,
      minOrderAmount: ident.nullable().default(null),
      maxDiscount: ident.nullable().default(null),
      usageLimit: ident.nullable().default(null),
      startsAt: ident.nullable().default(null),
      expiresAt: ident.nullable().default(null),
      isActive: ident.nullable().default(null),
    })
    .nullable()
    .default(null),
  storeAdmins: z
    .object({
      email: ident,
      passwordHash: ident,
      /** Trusted raw SQL condition using alias `u`. */
      where: z.string(),
    })
    .nullable()
    .default(null),
});

export type SchemaMapping = z.infer<typeof mappingSchema>;

export function parseMapping(raw: unknown): SchemaMapping {
  return mappingSchema.parse(raw);
}

export function loadMapping(file: string): SchemaMapping {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) {
    throw new Error(`Schema mapping file not found: ${full}. Run "npm run inspect-schema" and create it.`);
  }
  return parseMapping(JSON.parse(fs.readFileSync(full, 'utf8')));
}

/** Quote a validated identifier. Prisma columns are camelCase, so quoting is required. */
export function q(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

export function qTable(name: string): string {
  return name.split('.').map(q).join('.');
}

/**
 * SQL expression that turns a timestamptz parameter into whatever the store uses,
 * so comparisons and inserts are correct regardless of the session time zone.
 */
export function storeTs(mapping: SchemaMapping, param: string): string {
  return mapping.timestampStorage === 'utc_timestamp'
    ? `(${param}::timestamptz AT TIME ZONE 'UTC')`
    : `${param}::timestamptz`;
}

/** SQL expression that reads a store timestamp column as timestamptz. */
export function readStoreTs(mapping: SchemaMapping, column: string): string {
  return mapping.timestampStorage === 'utc_timestamp' ? `(${column} AT TIME ZONE 'UTC')` : column;
}

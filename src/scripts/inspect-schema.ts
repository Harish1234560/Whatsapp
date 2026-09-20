/**
 * Steps 1 and 2 of the plan: connect to the existing store database and report what is there.
 * Read-only. Prints tables, likely user/order/coupon tables, and answers the four
 * questions that must be settled before building further:
 *   coupon table?  opt-in column?  order statuses?  admin auth?
 *
 * Usage: DATABASE_URL=postgres://... npm run inspect-schema
 */
import { loadEnv } from '../config/env.js';
import { createPgDb } from '../db/db.js';

const env = loadEnv();
if (!env.databaseUrl) {
  console.error('Set DATABASE_URL to the existing store database first.');
  process.exit(1);
}

const db = createPgDb(env.databaseUrl);

const cols = await db.query<{ table_schema: string; table_name: string; column_name: string; data_type: string; udt_name: string }>(
  `SELECT table_schema, table_name, column_name, data_type, udt_name
   FROM information_schema.columns
   WHERE table_schema NOT IN ('pg_catalog','information_schema','marketing')
   ORDER BY table_schema, table_name, ordinal_position`,
);

const tables = new Map<string, typeof cols.rows>();
for (const c of cols.rows) {
  const key = c.table_schema === 'public' ? c.table_name : `${c.table_schema}.${c.table_name}`;
  if (!tables.has(key)) tables.set(key, []);
  tables.get(key)!.push(c);
}

console.log(`\nFound ${tables.size} tables.\n`);
const interesting = /user|customer|order|coupon|discount|promo|account|admin/i;
for (const [name, columns] of tables) {
  if (!interesting.test(name)) continue;
  console.log(`■ ${name}`);
  for (const c of columns) console.log(`    ${c.column_name.padEnd(28)} ${c.data_type === 'USER-DEFINED' ? `enum ${c.udt_name}` : c.data_type}`);
  console.log('');
}

const find = (re: RegExp) => cols.rows.filter((c) => re.test(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`);

console.log('── Questions to settle ─────────────────────────────────────────');
const couponTables = [...tables.keys()].filter((t) => /coupon|promo|discount_code/i.test(t));
console.log(`1. Coupon table?      ${couponTables.length ? `YES: ${couponTables.join(', ')}  → COUPON_MODE=existing_table` : 'NO → COUPON_MODE=api, checkout must call /api/integration/coupons/*'}`);
const optIn = find(/opt.?in|marketing|whatsapp.?consent|subscribe|consent/i);
console.log(`2. Opt-in column?     ${optIn.length ? `candidates: ${optIn.join(', ')}` : 'NO → consent is kept in marketing.preferences (default: not opted in)'}`);
console.log(`   Date of birth:     ${find(/^(dob|date_?of_?birth|birth_?date|birthday)$/i).join(', ') || 'NOT FOUND'}`);
console.log(`   Phone:             ${find(/phone|mobile|whatsapp/i).join(', ') || 'NOT FOUND'}`);

const enums = await db.query<{ typname: string; labels: string }>(
  `SELECT t.typname, string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS labels
   FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname ORDER BY t.typname`,
);
console.log('3. Order statuses?    enum types found:');
for (const e of enums.rows.filter((x) => /status|role|coupon/i.test(x.typname))) console.log(`      ${e.typname}: ${e.labels}`);
const pw = find(/password|passwd|pass_hash/i);
console.log(`4. Admin auth?        ${pw.length ? `password columns: ${pw.join(', ')} → store admins can be reused if hashes are bcrypt` : 'none found → use npm run create-admin'}`);
console.log('\nNow edit schema-mapping.json so every name matches what is printed above.\n');

await db.close();

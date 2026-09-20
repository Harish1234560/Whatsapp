import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply pending .sql files in name order. Each file runs in one transaction. */
export async function migrate(db: Db): Promise<string[]> {
  // Checked first so the least-privilege app role, which cannot CREATE, can still start up
  // once the owner has run the migrations.
  const exists = await db.query<{ t: string | null }>(`SELECT to_regclass('marketing.schema_migrations')::text AS t`);
  if (!exists.rows[0]?.t) {
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS marketing;
      CREATE TABLE IF NOT EXISTS marketing.schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  const done = new Set((await db.query<{ name: string }>('SELECT name FROM marketing.schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const safeName = file.replace(/'/g, "''");
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO marketing.schema_migrations (name) VALUES ('${safeName}');\nCOMMIT;`);
    applied.push(file);
  }
  return applied;
}

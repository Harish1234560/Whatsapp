/** Creates the marketing schema and tables. Never touches existing store tables. */
import { loadEnv } from '../config/env.js';
import { createPgDb } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultSettings } from '../settings/settings.service.js';
import { ensureDefaultTemplates } from '../whatsapp/whatsapp.template.js';

const env = loadEnv();
if (!env.databaseUrl) {
  console.error('Set DATABASE_URL first. (Without it, `npm run dev` uses an embedded demo database that migrates itself.)');
  process.exit(1);
}
const db = createPgDb(env.databaseUrl);
const applied = await migrate(db);
await ensureDefaultSettings(db);
await ensureDefaultTemplates(db, false);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply. Schema is up to date.');
await db.close();

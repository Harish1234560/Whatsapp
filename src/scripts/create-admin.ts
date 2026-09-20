/** Usage: npm run create-admin -- someone@example.com "a-long-password" */
import { loadEnv } from '../config/env.js';
import { AuthService } from '../auth/auth.js';
import { createPgDb } from '../db/db.js';
import { migrate } from '../db/migrate.js';

const [email, password] = process.argv.slice(2);
if (!email || !password || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Usage: npm run create-admin -- <email> <password (10+ characters)>');
  process.exit(1);
}
const env = loadEnv();
if (!env.databaseUrl) {
  console.error('Set DATABASE_URL first.');
  process.exit(1);
}
const db = createPgDb(env.databaseUrl);
await migrate(db);
const hash = await AuthService.hash(password);
await db.query(
  `INSERT INTO marketing.admins (email, password_hash) VALUES ($1, $2)
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE`,
  [email.toLowerCase(), hash],
);
console.log(`Marketing admin ready: ${email.toLowerCase()}`);
await db.close();

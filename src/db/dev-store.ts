import bcrypt from 'bcryptjs';
import type { Db } from './db.js';
import { istParts, istToUtc } from '../util/time.js';

/**
 * A stand-in for the existing store database, used only on the embedded dev/test
 * database. It mirrors the shape of the real store tables (Prisma, camelCase
 * columns, enum types) so the default schema mapping is exercised for real.
 * It is NEVER run against a real DATABASE_URL.
 */
export async function createFakeStoreTables(db: Db): Promise<void> {
  await db.exec(`
    DO $$ BEGIN
      CREATE TYPE "UserRole" AS ENUM ('CUSTOMER','STAFF','ADMIN');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "OrderStatus" AS ENUM ('PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED','REFUNDED','RETURN_REQUESTED');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "CouponType" AS ENUM ('PERCENTAGE','FIXED','FREE_SHIPPING');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      email          VARCHAR(255) UNIQUE,
      phone          VARCHAR(20) UNIQUE,
      "passwordHash" VARCHAR(255),
      "firstName"    VARCHAR(100),
      "lastName"     VARCHAR(100),
      dob            DATE,
      role           "UserRole" NOT NULL DEFAULT 'CUSTOMER',
      "isActive"     BOOLEAN NOT NULL DEFAULT TRUE,
      "isBlocked"    BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id            TEXT PRIMARY KEY,
      "userId"      TEXT REFERENCES users(id),
      status        "OrderStatus" NOT NULL DEFAULT 'PENDING',
      "totalAmount" DECIMAL(10,2) NOT NULL,
      "couponCode"  VARCHAR(50),
      "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id               TEXT PRIMARY KEY,
      code             VARCHAR(50) NOT NULL UNIQUE,
      type             "CouponType" NOT NULL,
      value            DECIMAL(10,2) NOT NULL,
      "minOrderAmount" DECIMAL(10,2),
      "maxDiscount"    DECIMAL(10,2),
      "usageLimit"     INT,
      "usedCount"      INT NOT NULL DEFAULT 0,
      "startsAt"       TIMESTAMP(3),
      "expiresAt"      TIMESTAMP(3),
      "isActive"       BOOLEAN NOT NULL DEFAULT TRUE,
      "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export interface FakeUser {
  id: string;
  firstName: string | null;
  lastName?: string | null;
  phone?: string | null;
  dob?: string | null;
  email?: string | null;
  role?: 'CUSTOMER' | 'STAFF' | 'ADMIN';
  passwordHash?: string | null;
  isBlocked?: boolean;
}

export async function insertFakeUser(db: Db, u: FakeUser): Promise<void> {
  await db.query(
    `INSERT INTO users (id, email, phone, "passwordHash", "firstName", "lastName", dob, role, "isBlocked")
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::"UserRole",$9)`,
    [u.id, u.email ?? null, u.phone ?? null, u.passwordHash ?? null, u.firstName, u.lastName ?? null, u.dob ?? null, u.role ?? 'CUSTOMER', u.isBlocked ?? false],
  );
}

export async function insertFakeOrder(
  db: Db,
  o: { id: string; userId: string; amount: number; status?: string; createdAt: Date; couponCode?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO orders (id, "userId", status, "totalAmount", "couponCode", "createdAt")
     VALUES ($1,$2,$3::"OrderStatus",$4,$5,($6::timestamptz AT TIME ZONE 'UTC'))`,
    [o.id, o.userId, o.status ?? 'DELIVERED', o.amount, o.couponCode ?? null, o.createdAt.toISOString()],
  );
}

export async function optInFake(db: Db, customerId: string, source = 'dev-seed'): Promise<void> {
  await db.query(
    `INSERT INTO marketing.preferences (customer_id, opted_in, opt_in_source, opted_in_at)
     VALUES ($1, TRUE, $2, now())
     ON CONFLICT (customer_id) DO UPDATE SET opted_in = TRUE, opted_out_at = NULL, opt_in_source = $2, opted_in_at = now()`,
    [customerId, source],
  );
}

/** Demo data for `npm run dev` without a real database. */
export async function seedFakeStore(db: Db, now: Date): Promise<{ adminEmail: string; adminPassword: string }> {
  const existing = await db.query('SELECT 1 FROM users LIMIT 1');
  const adminEmail = 'admin@example.com';
  const adminPassword = 'admin12345';
  if (existing.rows.length) return { adminEmail, adminPassword };

  const today = istParts(now);
  const mmdd = `${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;

  await insertFakeUser(db, {
    id: 'adm_1', firstName: 'Store', lastName: 'Admin', email: adminEmail, role: 'ADMIN',
    passwordHash: await bcrypt.hash(adminPassword, 10),
  });

  const names = ['Rahul', 'Priya', 'Arun', 'Sita', 'Ravi', 'Kiran', 'Anil', 'Pooja', 'Manoj', 'Sneha', 'Rahul', 'Divya', 'Vikram', 'Meena', 'Suresh', 'Lakshmi', 'Harish', 'Deepa'];
  const surnames = ['Reddy', 'Sharma', 'Kumar', 'Devi', 'Teja', 'Rao', 'Verma', 'Hegde', 'Pillai', 'Iyer', 'Nair', 'Menon', 'Singh', 'Kumari', 'Babu', 'Narayan', 'Gowda', 'Joshi'];

  for (let i = 0; i < names.length; i++) {
    const id = `cus_${String(i + 1).padStart(3, '0')}`;
    // First three customers have their birthday today so the birthday flow is visible.
    const dob = i < 3 ? `${1985 + i}-${mmdd}` : `${1980 + i}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`;
    await insertFakeUser(db, {
      id, firstName: names[i], lastName: surnames[i], phone: `98${String(76500001 + i * 1111).padStart(8, '0')}`,
      dob, email: `${names[i].toLowerCase()}${i}@example.com`,
    });
    // Everyone except two customers has opted in, so "not contactable" rows are visible too.
    if (i !== 4 && i !== 12) await optInFake(db, id);
  }

  // Orders in the previous calendar month (India time), so Top 10 has data.
  const prevMonth = today.month === 1 ? 12 : today.month - 1;
  const prevYear = today.month === 1 ? today.year - 1 : today.year;
  let orderNo = 1;
  for (let i = 0; i < names.length; i++) {
    const orders = 1 + (i % 3);
    for (let k = 0; k < orders; k++) {
      await insertFakeOrder(db, {
        id: `ord_${String(orderNo++).padStart(4, '0')}`,
        userId: `cus_${String(i + 1).padStart(3, '0')}`,
        amount: Math.round((46000 - i * 2300) / orders),
        status: i === 7 && k === 0 ? 'CANCELLED' : 'DELIVERED',
        createdAt: istToUtc(prevYear, prevMonth, 3 + ((i + k * 7) % 24), 11, 30),
      });
    }
  }
  return { adminEmail, adminPassword };
}

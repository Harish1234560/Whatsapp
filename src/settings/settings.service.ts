import { z } from 'zod';
import type { Queryable } from '../db/db.js';

export const birthdaySettingsSchema = z.object({
  enabled: z.boolean(),
  discountType: z.enum(['FLAT', 'PERCENT']),
  discountValue: z.number().positive(),
  validityDays: z.number().int().min(1).max(90),
  minimumOrderAmount: z.number().nonnegative().nullable(),
  maximumDiscount: z.number().positive().nullable(),
  templateName: z.string().min(1),
  couponPrefix: z.string().regex(/^[A-Z0-9]{2,12}$/),
}).refine((s) => s.discountType !== 'PERCENT' || s.discountValue <= 100, { message: 'A percentage discount cannot exceed 100.' });

export const generalSettingsSchema = z.object({
  /** Shown on the confirmation screen as an estimate. Set it to your current Meta rate. */
  perMessageCostInr: z.number().nonnegative(),
  /** Your WhatsApp account's daily messaging tier. Larger audiences are spread over days. */
  dailyTierLimit: z.number().int().positive(),
  sendWindowStartHour: z.number().int().min(0).max(23),
  sendWindowEndHour: z.number().int().min(1).max(24),
  requireDifferentApprover: z.boolean(),
});

export type BirthdaySettings = z.infer<typeof birthdaySettingsSchema>;
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

export const DEFAULT_BIRTHDAY: BirthdaySettings = {
  enabled: true,
  discountType: 'FLAT',
  discountValue: 300,
  validityDays: 7,
  minimumOrderAmount: null,
  maximumDiscount: null,
  templateName: 'birthday_offer',
  couponPrefix: 'BD300',
};

export const DEFAULT_GENERAL: GeneralSettings = {
  perMessageCostInr: 0.9,
  dailyTierLimit: 1000,
  sendWindowStartHour: 9,
  sendWindowEndHour: 20,
  requireDifferentApprover: false,
};

export async function ensureDefaultSettings(db: Queryable): Promise<void> {
  for (const [key, value] of [['birthday', DEFAULT_BIRTHDAY], ['general', DEFAULT_GENERAL]] as const) {
    await db.query(
      `INSERT INTO marketing.settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)],
    );
  }
}

async function read<T>(db: Queryable, key: string, dflt: T): Promise<T> {
  const r = await db.query<{ value: T }>('SELECT value FROM marketing.settings WHERE key = $1', [key]);
  return r.rows[0] ? { ...dflt, ...r.rows[0].value } : dflt;
}

async function write(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO marketing.settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export const getBirthdaySettings = (db: Queryable) => read(db, 'birthday', DEFAULT_BIRTHDAY);
export const getGeneralSettings = (db: Queryable) => read(db, 'general', DEFAULT_GENERAL);
export const saveBirthdaySettings = (db: Queryable, v: BirthdaySettings) => write(db, 'birthday', birthdaySettingsSchema.parse(v));
export const saveGeneralSettings = (db: Queryable, v: GeneralSettings) => write(db, 'general', generalSettingsSchema.parse(v));

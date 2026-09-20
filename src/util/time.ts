/**
 * All business dates are India time (Asia/Kolkata). India has no daylight saving,
 * so a fixed +05:30 offset is exact and avoids depending on the server time zone.
 */
export const IST_OFFSET_MINUTES = 330;
export const IST_TZ_NAME = 'Asia/Kolkata';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

export function istParts(d: Date): IstParts {
  const s = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth() + 1,
    day: s.getUTCDate(),
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
  };
}

/** Build the UTC instant for a wall-clock time in India. */
export function istToUtc(year: number, month: number, day: number, hh = 0, mm = 0, ss = 0, ms = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hh, mm, ss, ms) - IST_OFFSET_MINUTES * 60_000);
}

export function istStartOfDay(year: number, month: number, day: number): Date {
  return istToUtc(year, month, day, 0, 0, 0, 0);
}

export function istEndOfDay(year: number, month: number, day: number): Date {
  return istToUtc(year, month, day, 23, 59, 59, 999);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function parseYmd(s: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date "${s}". Expected YYYY-MM-DD.`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date "${s}".`);
  }
  return { year, month, day };
}

export function parseYm(s: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid month "${s}". Expected YYYY-MM.`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month "${s}".`);
  return { year, month };
}

/** [start, end) of a calendar month in India time, as UTC instants. */
export function istMonthRange(ym: string): { start: Date; end: Date } {
  const { year, month } = parseYm(ym);
  const start = istStartOfDay(year, month, 1);
  const end = month === 12 ? istStartOfDay(year + 1, 1, 1) : istStartOfDay(year, month + 1, 1);
  return { start, end };
}

export function ymOf(d: Date): string {
  const p = istParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function ymdOf(d: Date): string {
  const p = istParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** "25 October 2026" in India time. */
export function formatDateLong(d: Date): string {
  const p = istParts(d);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

export function monthLabel(ym: string): string {
  const { year, month } = parseYm(ym);
  return `${MONTHS[month - 1]} ${year}`;
}

/** End of the India-time day that falls `days` after `from`. */
export function endOfDayAfter(from: Date, days: number): Date {
  const p = istParts(new Date(from.getTime() + days * 86_400_000));
  return istEndOfDay(p.year, p.month, p.day);
}

/** Whole years between a YYYY-MM-DD birth date and now (India time). */
export function ageOn(dobYmd: string, now: Date): number {
  const dob = parseYmd(dobYmd);
  const p = istParts(now);
  let age = p.year - dob.year;
  if (p.month < dob.month || (p.month === dob.month && p.day < dob.day)) age -= 1;
  return age;
}

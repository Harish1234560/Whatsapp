import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { q, qTable } from '../config/schema-mapping.js';

const COOKIE = 'mk_session';
const SESSION_HOURS = 12;

export interface AdminIdentity {
  email: string;
  source: 'local' | 'store';
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminIdentity;
    rawBody?: Buffer;
  }
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Two kinds of admin can sign in:
 *  1. marketing.admins, created with `npm run create-admin`.
 *  2. The store's own ADMIN users (bcrypt hashes, read-only), when the mapping has storeAdmins.
 * Every marketing action needs a signed session. There are no anonymous write routes.
 */
export class AuthService {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private ctx: AppContext) {}

  sign(identity: AdminIdentity): string {
    const payload = b64url(JSON.stringify({ ...identity, exp: Date.now() + SESSION_HOURS * 3600_000 }));
    const mac = crypto.createHmac('sha256', this.ctx.env.sessionSecret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  verify(token: string | undefined): AdminIdentity | null {
    if (!token) return null;
    const [payload, mac] = token.split('.');
    if (!payload || !mac) return null;
    const expected = crypto.createHmac('sha256', this.ctx.env.sessionSecret).update(payload).digest('base64url');
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
      return { email: data.email, source: data.source };
    } catch {
      return null;
    }
  }

  private throttle(key: string): void {
    const now = Date.now();
    const a = this.attempts.get(key);
    if (!a || a.resetAt < now) {
      this.attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
      return;
    }
    a.count++;
    if (a.count > 10) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  }

  async login(email: string, password: string, ip: string): Promise<AdminIdentity> {
    this.throttle(`${ip}:${email.toLowerCase()}`);
    const db = this.ctx.db;

    const local = await db.query<{ email: string; password_hash: string }>(
      'SELECT email, password_hash FROM marketing.admins WHERE lower(email) = lower($1) AND is_active',
      [email],
    );
    if (local.rows[0] && (await bcrypt.compare(password, local.rows[0].password_hash))) {
      return { email: local.rows[0].email, source: 'local' };
    }

    const sa = this.ctx.mapping.storeAdmins;
    if (this.ctx.env.allowStoreAdminLogin && sa) {
      const u = this.ctx.mapping.users;
      const store = await db.query<{ email: string; hash: string | null }>(
        `SELECT u.${q(sa.email)}::text AS email, u.${q(sa.passwordHash)}::text AS hash
         FROM ${qTable(u.table)} u WHERE lower(u.${q(sa.email)}) = lower($1) AND (${sa.where})`,
        [email],
      );
      const row = store.rows[0];
      if (row?.hash && (await bcrypt.compare(password, row.hash))) return { email: row.email, source: 'store' };
    }

    // Same cost whether or not the account exists.
    await bcrypt.compare(password, '$2a$10$CwTycUXWue0Thq9StjUM0uJ8iVh2gcyVt1tVwYQ2qj3o1pKc0xK8K');
    throw new HttpError(401, 'Wrong email or password.');
  }

  static async hash(password: string): Promise<string> {
    if (password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters.');
    return bcrypt.hash(password, 12);
  }

  setCookie(res: Response, token: string): void {
    const secure = this.ctx.env.nodeEnv === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  }

  clearCookie(res: Response): void {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  private tokenFrom(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    const cookies = req.headers.cookie ?? '';
    for (const part of cookies.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return undefined;
  }

  /** Only authorised admins can create, generate, approve, send, cancel, or change discounts. */
  requireAdmin = (req: Request, _res: Response, next: NextFunction): void => {
    const identity = this.verify(this.tokenFrom(req));
    if (!identity) return next(new HttpError(401, 'Sign in required.'));
    req.admin = identity;
    next();
  };

  /** For server-to-server calls from the store (coupon redemption, consent capture). */
  requireApiKey = (req: Request, _res: Response, next: NextFunction): void => {
    const expected = this.ctx.env.integrationApiKey;
    const given = String(req.headers['x-api-key'] ?? '');
    if (!expected || expected.length < 24) return next(new HttpError(503, 'INTEGRATION_API_KEY is not configured (24+ characters).'));
    const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) return next(new HttpError(401, 'Invalid API key.'));
    next();
  };
}

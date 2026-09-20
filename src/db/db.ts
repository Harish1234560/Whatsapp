import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Run several statements without parameters (migrations, seeds). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pg' | 'pglite';
}

/** Production driver: the store's real PostgreSQL database. */
export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });

  const wrap = (client: { query: (sql: string, params?: any[]) => Promise<pg.QueryResult> }): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await client.query(sql, params as any[]);
      return { rows: (r.rows ?? []) as T[], rowCount: r.rowCount ?? (r.rows?.length ?? 0) };
    },
  });

  return {
    kind: 'pg',
    ...wrap(pool),
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Dev and test driver: an embedded PostgreSQL (PGlite). Real Postgres semantics,
 * so unique indexes and conditional updates behave exactly as in production.
 */
export async function createPgliteDb(dataDir = ''): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;

  const wrap = (runner: { query: (sql: string, params?: any[]) => Promise<any> }): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await runner.query(sql, params as any[]);
      const rows = (r.rows ?? []) as T[];
      return { rows, rowCount: Math.max(r.affectedRows ?? 0, rows.length) };
    },
  });

  return {
    kind: 'pglite',
    ...wrap(lite),
    async exec(sql: string) {
      await lite.exec(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return (await lite.transaction(async (tx) => fn(wrap(tx)))) as T;
    },
    async close() {
      await lite.close();
    },
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as any).code === '23505';
}

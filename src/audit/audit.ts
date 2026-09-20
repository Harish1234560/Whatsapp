import type { Queryable } from '../db/db.js';

/** Append-only record of who did what. Never updated or deleted by the application. */
export async function audit(
  db: Queryable,
  actor: string,
  action: string,
  entity: string,
  entityId: string | number | null,
  details?: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO marketing.audit_log (actor, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [actor, action, entity, entityId === null ? null : String(entityId), details === undefined ? null : JSON.stringify(details)],
  );
}

export const SYSTEM_ACTOR = 'system';

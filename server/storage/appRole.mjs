import { POSTGRES_SCHEMA } from './contract.mjs';

/**
 * Separates the runtime role from the owner. The owner (the migrate role) owns every table; the app
 * connects as a plain login role that can read and write rows but owns nothing: it cannot TRUNCATE,
 * cannot ALTER TABLE … DISABLE TRIGGER, and cannot set session_replication_role, so the append-only
 * rules on admin_audit hold against the running app. Idempotent; run after every migration.
 * @param {import('pg').Pool} pool connected as the owner (migration) role
 * @param {{ role: string, password?: string }} options
 */
export async function ensureAppRole(pool, { role, password }) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(String(role ?? ''))) throw new Error('APP_DB_USER must be a lower-case identifier');
  const client = await pool.connect();
  try {
    const owner = (await client.query('select current_user as u')).rows[0].u;
    if (owner === role) throw new Error('APP_DB_USER must differ from the owner/migration role');
    const lit = (value) => client.escapeLiteral(String(value));
    await client.query('begin');
    const exists = (await client.query('select 1 from pg_roles where rolname = $1', [role])).rowCount > 0;
    const attrs = 'login nosuperuser nocreatedb nocreaterole noreplication nobypassrls';
    if (!exists) await client.query(`create role ${role} ${attrs}${password ? ` password ${lit(password)}` : ''}`);
    else await client.query(`alter role ${role} ${attrs}${password ? ` password ${lit(password)}` : ''}`);
    const db = (await client.query('select current_database() as d')).rows[0].d;
    await client.query(`grant connect on database ${client.escapeIdentifier(db)} to ${role}`);
    await client.query(`grant usage on schema ${POSTGRES_SCHEMA} to ${role}`);
    await client.query(`revoke create on schema ${POSTGRES_SCHEMA} from ${role}`);
    await client.query(`revoke all on all tables in schema ${POSTGRES_SCHEMA} from ${role}`);
    await client.query(`grant select, insert, update, delete on all tables in schema ${POSTGRES_SCHEMA} to ${role}`);
    await client.query(`grant usage, select on all sequences in schema ${POSTGRES_SCHEMA} to ${role}`);
    // Migration bookkeeping is the owner's business.
    await client.query(`revoke insert, update, delete on ${POSTGRES_SCHEMA}.schema_migrations from ${role}`);
    // The audit log is append-only for the app (the triggers also refuse UPDATE/DELETE/TRUNCATE).
    const audit = (await client.query(`select to_regclass('${POSTGRES_SCHEMA}.admin_audit') as t`)).rows[0].t;
    if (audit) await client.query(`revoke update, delete, truncate on ${POSTGRES_SCHEMA}.admin_audit from ${role}`);
    await client.query('commit');
    return { owner, role, created: !exists, auditTable: Boolean(audit) };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

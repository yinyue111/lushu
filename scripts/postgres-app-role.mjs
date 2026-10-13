// Creates/updates the runtime DB role (APP_DB_USER / APP_DB_PASSWORD) with row-level grants only.
// Run as the owner (migration) role: DATABASE_URL points at the owner. Idempotent; run after migrate.
import { ensureAppRole } from '../server/storage/appRole.mjs';
import { createPostgresPool, redactPostgresError } from '../server/storage/postgresConnection.mjs';

const role = String(process.env.APP_DB_USER ?? '').trim();
const password = String(process.env.APP_DB_PASSWORD ?? '');
const pool = createPostgresPool({ connectionString: process.env.MIGRATION_DATABASE_URL || undefined, applicationName: 'trusted-routebook-app-role', max: 1 });
try {
  if (!role) throw new Error('APP_DB_USER is required');
  const result = await ensureAppRole(pool, { role, password: password || undefined });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  process.stderr.write(`app role setup failed: ${redactPostgresError(error.message)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

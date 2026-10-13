import { resolve } from 'node:path';
import { applyPostgresMigrations } from '../server/storage/migrationRunner.mjs';
import { createPostgresPool, redactPostgresError } from '../server/storage/postgresConnection.mjs';

const options = parseArgs(process.argv.slice(2));
const pool = createPostgresPool({
  connectionString: options.databaseUrl || process.env.MIGRATION_DATABASE_URL || undefined,
  applicationName: 'trusted-routebook-migrate',
  max: 1
});

try {
  const result = await applyPostgresMigrations(pool, {
    ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {})
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`PostgreSQL migration failed: ${redactPostgresError(error.message)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

function parseArgs(args) {
  const output = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--database-url') output.databaseUrl = requireValue(args, ++index, arg);
    else if (arg === '--migrations-dir') output.migrationsDir = resolve(requireValue(args, ++index, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return output;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

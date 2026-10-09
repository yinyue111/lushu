import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSTGRES_SCHEMA } from './contract.mjs';
import { sha256 } from './jsonCanonical.mjs';

export const DEFAULT_POSTGRES_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const MIGRATION_LOCK_ID = 1937018147;

export async function applyPostgresMigrations(pool, { migrationsDir = DEFAULT_POSTGRES_MIGRATIONS_DIR } = {}) {
  const directory = resolve(migrationsDir);
  const migrationNames = (await readdir(directory)).filter((name) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(name)).sort();
  if (!migrationNames.length) throw new Error(`No PostgreSQL migrations found in ${directory}`);

  const client = await pool.connect();
  const applied = [];
  const skipped = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      create schema if not exists ${POSTGRES_SCHEMA};
      revoke all on schema ${POSTGRES_SCHEMA} from public;
      create table if not exists ${POSTGRES_SCHEMA}.schema_migrations (
        migration_name text primary key,
        migration_sha256 text not null,
        applied_at timestamptz not null default clock_timestamp(),
        constraint schema_migrations_name_check check (btrim(migration_name) <> ''),
        constraint schema_migrations_sha256_check check (migration_sha256 ~ '^[0-9a-f]{64}$')
      );
      revoke all on ${POSTGRES_SCHEMA}.schema_migrations from public;
    `);

    for (const migrationName of migrationNames) {
      const migrationSql = await readFile(join(directory, migrationName), 'utf8');
      const migrationSha256 = sha256(migrationSql);
      const existing = await client.query(`select migration_sha256 from ${POSTGRES_SCHEMA}.schema_migrations where migration_name = $1`, [migrationName]);
      if (existing.rowCount) {
        if (existing.rows[0].migration_sha256 !== migrationSha256) {
          const error = /** @type {Error & Record<string, any>} */ (new Error(`Applied PostgreSQL migration checksum changed: ${migrationName}`));
          error.code = 'POSTGRES_MIGRATION_CHECKSUM_MISMATCH';
          throw error;
        }
        skipped.push(migrationName);
        continue;
      }

      await client.query('begin');
      try {
        await client.query(migrationSql);
        await client.query(`insert into ${POSTGRES_SCHEMA}.schema_migrations (migration_name, migration_sha256) values ($1, $2)`, [
          migrationName,
          migrationSha256
        ]);
        await client.query('commit');
        applied.push(migrationName);
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }

  return {
    migrationsDir: directory,
    total: migrationNames.length,
    applied,
    skipped
  };
}

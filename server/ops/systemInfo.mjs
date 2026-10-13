// Read-only system info for the admin console (build design §4). No actions here.
// Commit / build time are injected at image build (ARG GIT_COMMIT / BUILD_TIME → APP_COMMIT / APP_BUILD_TIME);
// image digest and deploy time are injected at deploy (APP_IMAGE_DIGEST / APP_DEPLOY_TIME).
// Anything not injected is reported as "unknown" — never guessed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config/index.mjs';
import { POSTGRES_STORAGE_SCHEMA_VERSION } from '../storage/contract.mjs';
import { usesPostgresStorage, getPostgresStorage } from '../storage/runtime.mjs';
import { configStatus } from '../config/runtime.mjs';

const clean = (v) => String(v ?? '').trim();
export const APP_COMMIT = clean(process.env.APP_COMMIT) || 'unknown';
const startedAt = new Date().toISOString();

export async function systemInfo() {
  const migration = { expectedSchemaVersion: POSTGRES_STORAGE_SCHEMA_VERSION, schemaVersion: null, latest: null, backend: usesPostgresStorage() ? 'postgres' : 'jsonl' };
  if (usesPostgresStorage()) {
    try {
      const pool = getPostgresStorage().pool;
      const state = await pool.query('select schema_version from trusted_routebook.storage_state where singleton_id = 1');
      const latest = await pool.query('select migration_name, applied_at from trusted_routebook.schema_migrations order by migration_name desc limit 1');
      migration.schemaVersion = state.rows[0]?.schema_version ?? null;
      migration.latest = latest.rows[0] ? { name: latest.rows[0].migration_name, appliedAt: new Date(latest.rows[0].applied_at).toISOString() } : null;
    } catch {
      migration.schemaVersion = null;
    }
  }
  let packageVersion = 'unknown';
  try {
    packageVersion = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    // keep unknown
  }
  return {
    commit: APP_COMMIT,
    buildTime: clean(process.env.APP_BUILD_TIME) || 'unknown',
    imageDigest: clean(process.env.APP_IMAGE_DIGEST) || 'unknown',
    deployTime: clean(process.env.APP_DEPLOY_TIME) || 'unknown',
    processStartedAt: startedAt,
    packageVersion,
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    migration,
    config: configStatus()
  };
}

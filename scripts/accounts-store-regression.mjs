// Runs the account-store contract against PostgreSQL (fresh database, all migrations applied).
import { spawn } from 'node:child_process';
import { applyPostgresMigrations } from '../server/storage/migrationRunner.mjs';
import { createPostgresPool, redactPostgresError } from '../server/storage/postgresConnection.mjs';
import { createPostgresStore } from '../server/accounts/store.mjs';
import { runAccountStoreContract } from '../test/support/account-store-contract.mjs';

const databaseName = `trusted_routebook_accounts_${process.pid}_${Date.now().toString(36)}`;
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed: ${redactPostgresError(stderr)}`))));
  });

let pool;
let failure;
try {
  await run('createdb', ['--no-password', '--template', 'template0', '--encoding', 'UTF8', databaseName]);
  pool = createPostgresPool({ database: databaseName, applicationName: 'accounts-store-regression', max: 4 });
  const migrations = await applyPostgresMigrations(pool);
  if (!migrations.applied.includes('0008_accounts.sql')) throw new Error('0008_accounts.sql was not applied');
  const again = await applyPostgresMigrations(pool);
  if (again.applied.length) throw new Error('migrations are not idempotent');
  await runAccountStoreContract(createPostgresStore(() => pool));
  console.log(JSON.stringify({ ok: true, store: 'postgres', migrations: migrations.applied.length }));
} catch (error) {
  failure = error;
} finally {
  await pool?.end().catch(() => {});
  await run('dropdb', ['--no-password', '--if-exists', databaseName]).catch(() => {});
}
if (failure) {
  console.error(redactPostgresError(failure?.stack || failure));
  process.exit(1);
}

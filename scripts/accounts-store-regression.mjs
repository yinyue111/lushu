// Runs the account-store contract against PostgreSQL (fresh database, all migrations applied).
import { spawn } from 'node:child_process';
import { applyPostgresMigrations } from '../server/storage/migrationRunner.mjs';
import { createPostgresPool, redactPostgresError } from '../server/storage/postgresConnection.mjs';
import { createPostgresStore } from '../server/accounts/store.mjs';
import { runAccountStoreContract } from '../test/support/account-store-contract.mjs';
import { createPostgresStore as createEnrichPostgresStore } from '../server/enrich/store.mjs';
import { runEnrichStoreContract } from '../test/support/enrich-store-contract.mjs';
import { createPostgresStore as createAdminPostgresStore } from '../server/admin/store.mjs';
import { runAdminStoreContract } from '../test/support/admin-store-contract.mjs';

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
  for (const name of ['0008_accounts.sql', '0009_account_email.sql', '0010_fact_enrichment.sql', '0012_admin_config.sql'])
    if (!migrations.applied.includes(name)) throw new Error(`${name} was not applied`);
  const again = await applyPostgresMigrations(pool);
  if (again.applied.length) throw new Error('migrations are not idempotent');
  await runAccountStoreContract(createPostgresStore(() => pool));
  await runEnrichStoreContract(createEnrichPostgresStore(() => pool));
  await runAdminStoreContract(
    createAdminPostgresStore(() => pool),
    {
      label: 'postgres',
      seedReport: async (id) => {
        await pool.query(`insert into trusted_routebook.enrich_reports (id, routebook_id, stop_key, field) values ($1, 'rb1', 's1', 'price')`, [id]);
      },
      // The audit table is append-only at the database level, not just by convention.
      appendOnly: async () => {
        for (const sql of ["update trusted_routebook.admin_audit set action = 'x'", 'delete from trusted_routebook.admin_audit', 'truncate trusted_routebook.admin_audit']) {
          const blocked = await pool.query(sql).then(
            () => false,
            () => true
          );
          if (!blocked) throw new Error(`admin_audit accepted: ${sql}`);
        }
      }
    }
  );
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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const migrationPath = fileURLToPath(
  new URL('../migrations/0001_content_routebook_foundation.sql', import.meta.url)
);
const databaseName = `trusted_routebook_schema_${process.pid}_${Date.now().toString(36)}`;
const commandEnv = {
  ...process.env,
  PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '5'
};

function redact(value) {
  return String(value || '')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/(password\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
}

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: commandEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      reject(new Error(`${command} is unavailable: ${redact(error.message)}`));
    });
    child.once('close', (code, signal) => {
      const result = { code, signal, stdout, stderr };
      if (code === 0 || allowFailure) {
        resolve(result);
        return;
      }
      const detail = redact(stderr.trim() || stdout.trim() || `exit code ${code}`);
      reject(new Error(`${command} failed: ${detail}`));
    });
  });
}

async function requireTool(command) {
  const result = await run(command, ['--version'], { allowFailure: true });
  if (result.code !== 0) {
    throw new Error(`${command} is unavailable: ${redact(result.stderr || result.stdout)}`);
  }
}

async function psql(args) {
  return run('psql', [
    '--no-password',
    '--no-psqlrc',
    '--set',
    'ON_ERROR_STOP=1',
    '--dbname',
    databaseName,
    ...args
  ]);
}

async function query(sql) {
  const result = await psql(['--tuples-only', '--no-align', '--command', sql]);
  return result.stdout.trim();
}

async function expectSqlFailure(label, sql, expectedPattern) {
  const result = await run('psql', [
    '--no-password',
    '--no-psqlrc',
    '--set',
    'ON_ERROR_STOP=1',
    '--dbname',
    databaseName,
    '--command',
    sql
  ], { allowFailure: true });
  assert.notEqual(result.code, 0, `${label} unexpectedly succeeded`);
  assert.match(
    redact(`${result.stderr}\n${result.stdout}`),
    expectedPattern,
    `${label} failed for an unexpected reason`
  );
}

function sqlTextList(values) {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');
}

async function assertCatalogNames({ label, sql, expected }) {
  const actual = (await query(sql)).split('\n').filter(Boolean);
  assert.deepEqual(actual, [...expected].sort(), `${label} do not match the migration contract`);
}

async function main() {
  await Promise.all(['psql', 'createdb', 'dropdb'].map(requireTool));

  let failure = null;
  try {
    await run('createdb', [
      '--no-password',
      '--template',
      'template0',
      '--encoding',
      'UTF8',
      databaseName
    ]);

    await psql(['--file', migrationPath]);
    await psql(['--command', `
      alter table trusted_routebook.routebook_versions
        drop constraint routebook_versions_snapshot_no_credentials_check;
      alter table trusted_routebook.routebook_versions
        add constraint routebook_versions_snapshot_no_credentials_check check (
          snapshot::text !~* '"editToken"[[:space:]]*:'
        );
    `]);
    await psql(['--file', migrationPath]);

    const tables = [
      'checkins',
      'content_import_batches',
      'poi_corrections',
      'poi_evidence',
      'poi_fact_evidence',
      'poi_facts',
      'poi_review_events',
      'pois',
      'profiles',
      'routebook_copy_events',
      'routebook_status_events',
      'routebook_versions',
      'routebooks'
    ];
    await assertCatalogNames({
      label: 'tables',
      expected: tables,
      sql: `
        select tablename
        from pg_catalog.pg_tables
        where schemaname = 'trusted_routebook'
        order by tablename
      `
    });

    const constraints = [
      'checkins_profile_routebook_client_local_key',
      'poi_evidence_poi_id_id_key',
      'poi_fact_evidence_evidence_poi_fkey',
      'poi_fact_evidence_fact_poi_fkey',
      'poi_fact_evidence_pkey',
      'poi_facts_poi_id_id_key',
      'routebook_versions_routebook_id_id_key',
      'routebook_versions_routebook_version_key',
      'routebook_versions_snapshot_no_credentials_check',
      'routebooks_current_version_fkey',
      'routebooks_published_version_fkey'
    ];
    await assertCatalogNames({
      label: 'key constraints',
      expected: constraints,
      sql: `
        select conname
        from pg_catalog.pg_constraint
        where connamespace = 'trusted_routebook'::regnamespace
          and conname in (${sqlTextList(constraints)})
        order by conname
      `
    });

    const indexes = [
      'checkins_poi_timeline_idx',
      'checkins_routebook_timeline_idx',
      'poi_evidence_poi_review_idx',
      'poi_fact_evidence_evidence_idx',
      'poi_facts_expiry_idx',
      'poi_review_events_poi_timeline_idx',
      'pois_city_review_status_idx',
      'routebook_copy_events_source_version_idx',
      'routebook_status_events_timeline_idx',
      'routebook_versions_timeline_idx',
      'routebooks_city_publish_status_idx'
    ];
    await assertCatalogNames({
      label: 'query indexes',
      expected: indexes,
      sql: `
        select indexname
        from pg_catalog.pg_indexes
        where schemaname = 'trusted_routebook'
          and indexname in (${sqlTextList(indexes)})
        order by indexname
      `
    });

    assert.equal(
      await query(`
        select count(*)
        from information_schema.columns
        where table_schema = 'trusted_routebook'
          and is_identity = 'YES'
      `),
      '12',
      'every entity table should use an identity primary key'
    );
    assert.equal(
      await query(`
        select count(*)
        from pg_catalog.pg_trigger
        where tgrelid = 'trusted_routebook.routebook_versions'::regclass
          and tgname = 'routebook_versions_immutable_trigger'
          and not tgisinternal
      `),
      '1',
      'routebook version immutability trigger should exist exactly once'
    );
    assert.equal(
      await query(`select has_schema_privilege('public', 'trusted_routebook', 'usage')`),
      'f',
      'PUBLIC must not have schema usage'
    );

    await psql(['--command', `
      insert into trusted_routebook.profiles (public_id, display_name)
      values ('profile-regression', 'Schema regression');

      insert into trusted_routebook.routebooks (
        public_id,
        owner_profile_id,
        city,
        title
      )
      select 'routebook-regression', id, 'Hangzhou', 'Schema regression routebook'
      from trusted_routebook.profiles
      where public_id = 'profile-regression';

      insert into trusted_routebook.routebook_versions (
        public_id,
        routebook_id,
        version,
        snapshot,
        snapshot_sha256,
        created_by_profile_id
      )
      select
        'routebook-version-regression',
        routebooks.id,
        1,
        '{"title":"Schema regression routebook"}'::jsonb,
        repeat('a', 64),
        profiles.id
      from trusted_routebook.routebooks
      join trusted_routebook.profiles
        on profiles.public_id = 'profile-regression'
      where routebooks.public_id = 'routebook-regression';

      update trusted_routebook.routebooks
      set current_version_id = routebook_versions.id
      from trusted_routebook.routebook_versions
      where routebooks.public_id = 'routebook-regression'
        and routebook_versions.public_id = 'routebook-version-regression';

      insert into trusted_routebook.checkins (
        public_id,
        profile_id,
        routebook_id,
        routebook_version_id,
        client_local_id,
        status,
        trust_state
      )
      select
        'checkin-regression',
        profiles.id,
        routebooks.id,
        routebook_versions.id,
        'client-local-regression',
        'visited',
        'profile-owned'
      from trusted_routebook.profiles
      join trusted_routebook.routebooks
        on routebooks.public_id = 'routebook-regression'
      join trusted_routebook.routebook_versions
        on routebook_versions.public_id = 'routebook-version-regression'
      where profiles.public_id = 'profile-regression';

      insert into trusted_routebook.routebook_versions (
        public_id,
        routebook_id,
        version,
        snapshot,
        snapshot_sha256,
        created_by_profile_id
      )
      select
        'routebook-version-business-fields',
        routebooks.id,
        2,
        '{
          "title": "Secret Garden route",
          "sourceAuthorization": "user-generated",
          "authorizationStatus": "approved",
          "secretSpot": "Hidden viewpoint",
          "passwordHint": "Credentials are stored outside snapshots",
          "passwordPolicy": "No password stored",
          "accessTokenPolicy": "Credentials stay outside snapshots",
          "apiKeyboardLayout": "standard"
        }'::jsonb,
        repeat('d', 64),
        profiles.id
      from trusted_routebook.routebooks
      join trusted_routebook.profiles
        on profiles.public_id = 'profile-regression'
      where routebooks.public_id = 'routebook-regression';

      insert into trusted_routebook.pois (
        public_id,
        city,
        name,
        normalized_name
      ) values
        ('poi-regression-a', 'Hangzhou', 'POI A', 'poi-a'),
        ('poi-regression-b', 'Hangzhou', 'POI B', 'poi-b');

      insert into trusted_routebook.poi_evidence (
        public_id,
        poi_id,
        kind,
        source_label
      )
      select 'evidence-regression-a', id, 'official', 'Official source A'
      from trusted_routebook.pois
      where public_id = 'poi-regression-a'
      union all
      select 'evidence-regression-b', id, 'official', 'Official source B'
      from trusted_routebook.pois
      where public_id = 'poi-regression-b';

      insert into trusted_routebook.poi_facts (
        public_id,
        poi_id,
        field,
        value,
        origin
      )
      select 'fact-regression-a', id, 'open_hours', '{"weekday":"09:00-17:00"}'::jsonb, 'operator'
      from trusted_routebook.pois
      where public_id = 'poi-regression-a'
      union all
      select 'fact-regression-b', id, 'open_hours', '{"weekday":"10:00-18:00"}'::jsonb, 'operator'
      from trusted_routebook.pois
      where public_id = 'poi-regression-b';

      insert into trusted_routebook.poi_fact_evidence (
        poi_id,
        poi_fact_id,
        poi_evidence_id
      )
      select facts.poi_id, facts.id, evidence.id
      from trusted_routebook.poi_facts as facts
      join trusted_routebook.poi_evidence as evidence
        on evidence.poi_id = facts.poi_id
      where facts.public_id = 'fact-regression-a'
        and evidence.public_id = 'evidence-regression-a';
    `]);

    assert.equal(
      await query(`
        select count(*)
        from trusted_routebook.poi_fact_evidence
      `),
      '1',
      'facts and evidence from the same POI should be linkable'
    );

    await expectSqlFailure(
      'invalid POI review status',
      `
        insert into trusted_routebook.pois (
          public_id, city, name, normalized_name, review_status
        ) values (
          'poi-invalid-status', 'Hangzhou', 'Invalid', 'invalid', 'unchecked'
        )
      `,
      /pois_review_status_check/
    );
    await expectSqlFailure(
      'duplicate routebook version',
      `
        insert into trusted_routebook.routebook_versions (
          public_id, routebook_id, version, snapshot, snapshot_sha256
        )
        select
          'routebook-version-duplicate', id, 1, '{}'::jsonb, repeat('b', 64)
        from trusted_routebook.routebooks
        where public_id = 'routebook-regression'
      `,
      /routebook_versions_routebook_version_key/
    );
    await expectSqlFailure(
      'duplicate checkin idempotency key',
      `
        insert into trusted_routebook.checkins (
          public_id,
          profile_id,
          routebook_id,
          client_local_id,
          status,
          trust_state
        )
        select
          'checkin-idempotency-duplicate',
          profiles.id,
          routebooks.id,
          'client-local-regression',
          'visited',
          'profile-owned'
        from trusted_routebook.profiles
        join trusted_routebook.routebooks
          on routebooks.public_id = 'routebook-regression'
        where profiles.public_id = 'profile-regression'
      `,
      /checkins_profile_routebook_client_local_key/
    );
    await expectSqlFailure(
      'cross-POI evidence link',
      `
        insert into trusted_routebook.poi_fact_evidence (
          poi_id, poi_fact_id, poi_evidence_id
        )
        select facts.poi_id, facts.id, evidence.id
        from trusted_routebook.poi_facts as facts
        cross join trusted_routebook.poi_evidence as evidence
        where facts.public_id = 'fact-regression-a'
          and evidence.public_id = 'evidence-regression-b'
      `,
      /poi_fact_evidence_evidence_poi_fkey/
    );
    await expectSqlFailure(
      'cross-POI fact link',
      `
        insert into trusted_routebook.poi_fact_evidence (
          poi_id, poi_fact_id, poi_evidence_id
        )
        select evidence.poi_id, facts.id, evidence.id
        from trusted_routebook.poi_facts as facts
        cross join trusted_routebook.poi_evidence as evidence
        where facts.public_id = 'fact-regression-a'
          and evidence.public_id = 'evidence-regression-b'
      `,
      /poi_fact_evidence_fact_poi_fkey/
    );

    const sensitiveSnapshotCases = [
      ['camel-case edit token', { private: { editToken: 'must-not-persist' } }],
      ['project profile access token', { private: { profileAccessToken: 'must-not-persist' } }],
      ['project routebook API token', { private: { routebookApiToken: 'must-not-persist' } }],
      ['project request token header', { private: { 'x-routebook-token': 'must-not-persist' } }],
      ['project OpenAI API key', { private: { openaiApiKey: 'must-not-persist' } }],
      ['uppercase underscore access token', { private: { ACCESS_TOKEN: 'must-not-persist' } }],
      ['spaced access token', { private: { 'access token': 'must-not-persist' } }],
      ['hyphenated API key', { private: { 'api-key': 'must-not-persist' } }],
      ['camel-case API key', { private: { apiKey: 'must-not-persist' } }],
      ['authorization header', { private: { Authorization: 'Bearer must-not-persist' } }],
      ['underscore client secret', { private: { client_secret: 'must-not-persist' } }],
      ['camel-case private key', { private: { privateKey: 'must-not-persist' } }],
      ['password', { private: { password: 'must-not-persist' } }],
      ['passphrase', { private: { passphrase: 'must-not-persist' } }]
    ];
    for (const [label, snapshot] of sensitiveSnapshotCases) {
      const snapshotJson = JSON.stringify(snapshot).replaceAll("'", "''");
      await expectSqlFailure(
        `snapshot containing ${label}`,
        `
          insert into trusted_routebook.routebook_versions (
            public_id, routebook_id, version, snapshot, snapshot_sha256
          )
          select
            'routebook-version-credential-leak',
            id,
            3,
            '${snapshotJson}'::jsonb,
            repeat('c', 64)
          from trusted_routebook.routebooks
          where public_id = 'routebook-regression'
        `,
        /routebook_versions_snapshot_no_credentials_check/
      );
    }
    await expectSqlFailure(
      'routebook version mutation',
      `
        update trusted_routebook.routebook_versions
        set snapshot = '{"title":"mutated"}'::jsonb
        where public_id = 'routebook-version-regression'
      `,
      /routebook_versions rows are immutable/
    );

    assert.equal(
      await query(`
        select count(*)
        from trusted_routebook.routebook_versions
        where routebook_id = (
          select id
          from trusted_routebook.routebooks
          where public_id = 'routebook-regression'
        )
      `),
      '2',
      'failed version writes must preserve both valid immutable snapshots'
    );
    assert.equal(
      await query(`
        select count(*)
        from trusted_routebook.checkins
        where client_local_id = 'client-local-regression'
      `),
      '1',
      'failed idempotency writes must leave one checkin'
    );

    console.log(JSON.stringify({
      ok: true,
      migrationRuns: 2,
      tables: tables.length,
      catalogAssertions: constraints.length + indexes.length + 3,
      negativeAssertions: 6 + sensitiveSnapshotCases.length
    }));
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = await run(
      'dropdb',
      ['--no-password', '--if-exists', '--force', databaseName],
      { allowFailure: true }
    ).catch((error) => ({ code: 1, stderr: error.message, stdout: '' }));
    if (cleanup.code !== 0 && !failure) {
      failure = new Error(`temporary database cleanup failed: ${redact(cleanup.stderr || cleanup.stdout)}`);
    }
  }

  if (failure) throw failure;
}

main().catch((error) => {
  console.error(`PostgreSQL schema regression failed: ${redact(error.message)}`);
  process.exitCode = 1;
});

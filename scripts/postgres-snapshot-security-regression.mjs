import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportStorageSnapshotToJsonl, loadFilesystemStorageSnapshot } from '../server/storage/filesystemSnapshot.mjs';
import { buildStorageSnapshot, compareStorageSnapshots } from '../server/storage/snapshot.mjs';

const PROFILE_ID_SECRET = 'snapshot-security-regression-profile-secret';
const ROOT_EDIT_TOKEN = 'rt_legacy_root_token_1234567890';
const NESTED_EDIT_TOKEN = 'rt_nested_token_1234567890';
const ARRAY_EDIT_TOKEN = 'rt_array_token_1234567890';
const PROFILE_ACCESS_TOKEN = 'profile_access_token_must_disappear';

const root = await mkdtemp(join(tmpdir(), 'trusted-routebook-snapshot-security-'));
try {
  const sourceDir = join(root, 'legacy-source');
  const exportDir = join(root, 'sanitized-export');
  await writeRoutebookRows(sourceDir, [
    {
      id: 'legacy-routebook',
      editToken: ROOT_EDIT_TOKEN,
      profileAccessToken: PROFILE_ACCESS_TOKEN,
      title: '旧版明文凭据路书',
      private: {
        edit_token: NESTED_EDIT_TOKEN,
        'profile-access-token': PROFILE_ACCESS_TOKEN,
        retained: true
      },
      versions: [
        {
          EditToken: ARRAY_EDIT_TOKEN,
          Profile_Access_Token: PROFILE_ACCESS_TOKEN,
          version: 1
        }
      ]
    }
  ]);

  const snapshot = await loadFilesystemStorageSnapshot(sourceDir, {
    profileIdSecret: PROFILE_ID_SECRET
  });
  const [sanitized] = snapshot.streams.routebooks.rows;
  assert.equal(sanitized.editTokenHash, expectedHash(ROOT_EDIT_TOKEN));
  assert.equal(sanitized.private.editTokenHash, expectedHash(NESTED_EDIT_TOKEN));
  assert.equal(sanitized.versions[0].editTokenHash, expectedHash(ARRAY_EDIT_TOKEN));
  assert.equal(sanitized.private.retained, true);
  assert.equal(sanitized.versions[0].version, 1);
  assertNoPlaintextCredentialKeys(sanitized);
  assertNoPlaintextValues(JSON.stringify(snapshot));

  const exportResult = await exportStorageSnapshotToJsonl(snapshot, exportDir, {
    profileIdSecret: PROFILE_ID_SECRET
  });
  const exportedText = await readFile(join(exportDir, 'routebooks.jsonl'), 'utf8');
  assertNoPlaintextValues(exportedText);
  assert.equal(JSON.parse(exportedText).editTokenHash, expectedHash(ROOT_EDIT_TOKEN));
  const exportedSnapshot = await loadFilesystemStorageSnapshot(exportDir, {
    profileIdSecret: PROFILE_ID_SECRET
  });
  assert.deepEqual(compareStorageSnapshots(snapshot, exportedSnapshot).differences, []);
  assert.equal(exportResult.manifestSha256, exportedSnapshot.manifestSha256);

  const unsafeProgrammaticSnapshot = buildStorageSnapshot({
    source: 'unsafe-programmatic-regression-fixture',
    streams: {
      routebooks: {
        rows: [
          {
            id: 'programmatic-legacy-routebook',
            editToken: ROOT_EDIT_TOKEN,
            nested: { profileAccessToken: PROFILE_ACCESS_TOKEN }
          }
        ]
      }
    }
  });
  const programmaticExportDir = join(root, 'programmatic-export');
  await exportStorageSnapshotToJsonl(unsafeProgrammaticSnapshot, programmaticExportDir, {
    profileIdSecret: PROFILE_ID_SECRET
  });
  const programmaticExport = await readFile(join(programmaticExportDir, 'routebooks.jsonl'), 'utf8');
  assertNoPlaintextValues(programmaticExport);
  assert.equal(JSON.parse(programmaticExport).editTokenHash, expectedHash(ROOT_EDIT_TOKEN));

  const invalidDir = join(root, 'invalid-token');
  await writeRoutebookRows(invalidDir, [{ id: 'invalid-token', editToken: 'token with spaces!' }]);
  await assert.rejects(() => loadFilesystemStorageSnapshot(invalidDir, { profileIdSecret: PROFILE_ID_SECRET }), { code: 'INVALID_ROUTEBOOK_EDIT_TOKEN' });

  const conflictingDir = join(root, 'conflicting-hash');
  await writeRoutebookRows(conflictingDir, [
    {
      id: 'conflicting-token-hash',
      editToken: ROOT_EDIT_TOKEN,
      editTokenHash: '000000000000000000'
    }
  ]);
  await assert.rejects(() => loadFilesystemStorageSnapshot(conflictingDir, { profileIdSecret: PROFILE_ID_SECRET }), {
    code: 'ROUTEBOOK_EDIT_TOKEN_HASH_CONFLICT'
  });

  const missingSecretDir = join(root, 'missing-production-secret');
  await writeRoutebookRows(missingSecretDir, [{ id: 'missing-secret', editToken: ROOT_EDIT_TOKEN }]);
  await assert.rejects(() => loadFilesystemStorageSnapshot(missingSecretDir, { env: { NODE_ENV: 'production' } }), {
    code: 'ROUTEBOOK_CREDENTIAL_SECRET_REQUIRED'
  });

  console.log('postgres snapshot security regression: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}

function expectedHash(token) {
  return createHmac('sha256', `${PROFILE_ID_SECRET}:profile-token`).update(token).digest('hex').slice(0, 18);
}

function assertNoPlaintextCredentialKeys(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoPlaintextCredentialKeys);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/[\s._-]+/g, '').toLowerCase();
    assert.notEqual(normalized, 'edittoken');
    assert.notEqual(normalized, 'profileaccesstoken');
    assertNoPlaintextCredentialKeys(nested);
  }
}

function assertNoPlaintextValues(serialized) {
  for (const plaintext of [ROOT_EDIT_TOKEN, NESTED_EDIT_TOKEN, ARRAY_EDIT_TOKEN, PROFILE_ACCESS_TOKEN]) {
    assert.equal(serialized.includes(plaintext), false, `plaintext credential leaked: ${plaintext}`);
  }
}

async function writeRoutebookRows(directory, rows) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'routebooks.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

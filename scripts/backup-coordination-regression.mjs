import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readAndVerifyBackup } from './lib/backupArchive.mjs';
import { acquireJsonlRuntimeWriterLease, inspectSourceCoordinationLease, sourceCoordinationPaths } from '../server/storage/sourceCoordination.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'trusted-routebook-backup-coordination-'));
const source = join(root, 'source');
const blockedArchive = join(root, 'blocked.trbk');
const archive = join(root, 'backup.trbk');
const restoreTarget = join(root, 'restore-target');
const encryptionKey = 'backup-coordination-regression-key';
let writerLease;

try {
  const missingSource = join(root, 'missing-source');
  const missingSourceBackup = await runScript('scripts/backup-data.mjs', ['--data-dir', missingSource, '--output', join(root, 'missing-source.trbk')]);
  assert.equal(missingSourceBackup.code, 1);
  assert.match(missingSourceBackup.stderr, /data directory does not exist/);
  await assert.rejects(() => access(missingSource), { code: 'ENOENT' });

  await mkdir(join(source, 'photos'), { recursive: true, mode: 0o700 });
  await writeFile(join(source, 'routebooks.jsonl'), '{"id":"coordinated-route"}\n', { mode: 0o600 });
  await writeFile(join(source, 'photos', 'photo-a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { mode: 0o600 });

  writerLease = await acquireJsonlRuntimeWriterLease({ dataDir: source, operation: 'backup-regression-writer' });
  const blockedBackup = await runScript('scripts/backup-data.mjs', ['--data-dir', source, '--output', blockedArchive]);
  assert.equal(blockedBackup.code, 1);
  assert.match(blockedBackup.stderr, /SOURCE_COORDINATION_LEASE_HELD/);
  await assert.rejects(() => access(blockedArchive), { code: 'ENOENT' });
  await writerLease.release();
  writerLease = null;

  const { coordinationDir } = sourceCoordinationPaths(source);
  await writeFile(join(coordinationDir, 'operator-note-that-must-not-be-backed-up'), 'not archive data\n', { mode: 0o600 });
  const successfulBackup = await runScript('scripts/backup-data.mjs', ['--data-dir', source, '--output', archive]);
  assert.equal(successfulBackup.code, 0, successfulBackup.stderr);
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  assert.equal((await inspectSourceCoordinationLease(source)).state, 'available');

  const verified = await readAndVerifyBackup({ inputPath: archive, encryptionKey });
  assert.deepEqual(
    verified.files.map((file) => file.path),
    ['photos/photo-a.jpg', 'routebooks.jsonl']
  );
  assert.equal(
    verified.files.some((file) => file.path === '.source-coordination' || file.path.startsWith('.source-coordination/')),
    false
  );

  writerLease = await acquireJsonlRuntimeWriterLease({
    dataDir: restoreTarget,
    operation: 'restore-regression-writer'
  });
  const blockedRestore = await runScript('scripts/restore-data.mjs', ['--input', archive, '--data-dir', restoreTarget, '--apply']);
  assert.equal(blockedRestore.code, 1);
  assert.match(blockedRestore.stderr, /SOURCE_COORDINATION_LEASE_HELD/);
  await assert.rejects(() => access(join(restoreTarget, 'routebooks.jsonl')), { code: 'ENOENT' });
  await writerLease.release();
  writerLease = null;

  const successfulRestore = await runScript('scripts/restore-data.mjs', ['--input', archive, '--data-dir', restoreTarget, '--apply']);
  assert.equal(successfulRestore.code, 0, successfulRestore.stderr);
  assert.equal(await readFile(join(restoreTarget, 'routebooks.jsonl'), 'utf8'), '{"id":"coordinated-route"}\n');
  assert.equal((await inspectSourceCoordinationLease(restoreTarget)).state, 'available');
  await stat(join(restoreTarget, '.source-coordination'));

  await writeFile(join(restoreTarget, 'obsolete.jsonl'), '{"obsolete":true}\n', { mode: 0o600 });
  const refusedOverwrite = await runScript('scripts/restore-data.mjs', ['--input', archive, '--data-dir', restoreTarget, '--apply']);
  assert.equal(refusedOverwrite.code, 1);
  assert.match(refusedOverwrite.stderr, /restore target is not empty/);
  assert.equal((await inspectSourceCoordinationLease(restoreTarget)).state, 'available');

  const forcedRestore = await runScript('scripts/restore-data.mjs', ['--input', archive, '--data-dir', restoreTarget, '--apply', '--force']);
  assert.equal(forcedRestore.code, 0, forcedRestore.stderr);
  await assert.rejects(() => access(join(restoreTarget, 'obsolete.jsonl')), { code: 'ENOENT' });
  assert.equal((await inspectSourceCoordinationLease(restoreTarget)).state, 'available');

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      missingSourceRejectedWithoutCreation: true,
      activeWriterBlockedBackup: true,
      coordinationFilesExcluded: true,
      activeWriterBlockedRestore: true,
      restoreLeaseSurvivedApply: true,
      forcedRestorePreservedCoordination: true
    })}\n`
  );
} finally {
  await writerLease?.release().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

function runScript(scriptPath, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(projectRoot, scriptPath), ...args], {
      cwd: projectRoot,
      env: { ...process.env, BACKUP_ENCRYPTION_KEY: encryptionKey },
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
    child.once('error', rejectRun);
    child.once('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

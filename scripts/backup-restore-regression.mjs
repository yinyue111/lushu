import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEncryptedBackup, readAndVerifyBackup, restoreVerifiedBackup } from './lib/backupArchive.mjs';

const root = await mkdtemp(join(tmpdir(), 'trusted-routebook-backup-'));
try {
  const source = join(root, 'source');
  const archive = join(root, 'backup.trbk');
  const restored = join(root, 'restored');
  const key = 'regression-only-backup-key-32-bytes';
  await mkdir(join(source, 'photos'), { recursive: true });
  await writeFile(join(source, 'routebooks.jsonl'), '{"id":"route-a"}\n', 'utf8');
  await writeFile(join(source, 'photos', 'photo-a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const created = await createEncryptedBackup({ dataDir: source, outputPath: archive, encryptionKey: key });
  assert.equal(created.fileCount, 2);
  assert.equal((await stat(archive)).mode & 0o777, 0o600);

  const verified = await readAndVerifyBackup({ inputPath: archive, encryptionKey: key });
  assert.equal(verified.fileCount, 2);
  await assert.rejects(() => readAndVerifyBackup({ inputPath: archive, encryptionKey: 'wrong-regression-key-value' }), /authentication failed/);

  const result = await restoreVerifiedBackup({ verified, dataDir: restored });
  assert.equal(result.fileCount, 2);
  assert.equal(await readFile(join(restored, 'routebooks.jsonl'), 'utf8'), '{"id":"route-a"}\n');
  assert.deepEqual(await readFile(join(restored, 'photos', 'photo-a.jpg')), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal((await stat(restored)).mode & 0o777, 0o700);
  assert.equal((await stat(join(restored, 'routebooks.jsonl'))).mode & 0o777, 0o600);

  await assert.rejects(() => restoreVerifiedBackup({ verified, dataDir: restored }), /not empty/);
  console.log('backup/restore regression passed');
} finally {
  await rm(root, { recursive: true, force: true });
}

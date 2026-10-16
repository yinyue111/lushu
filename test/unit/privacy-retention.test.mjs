import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKUP_RETENTION_DAYS, pruneBackups } from '../../scripts/lib/backupRetention.mjs';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('privacy policy has no retention placeholder and states the one-month backup window', async () => {
  const src = await read('src/components/Legal/PrivacyPage.jsx');
  assert.doesNotMatch(src, /TODO\('(各类数据的保存期限|备份保留周期)'\)/);
  assert.doesNotMatch(src, /XX ?天|按备份周期清除/);
  assert.match(src, /最多保留一个月/);
});

test('deletion copy on 我的 page does not use an undefined backup period', async () => {
  const src = await read('src/components/My/MyPage.jsx');
  assert.doesNotMatch(src, /按备份周期清除|XX ?天/);
  assert.match(src, /最多保留一个月/);
});

test('retention constant matches the one-month promise', () => {
  assert.equal(BACKUP_RETENTION_DAYS, 30);
});

test('pruneBackups removes only backups older than 30 days', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prune-'));
  const now = Date.parse('2026-10-16T00:00:00Z');
  const day = 86400000;
  const files = { 'trusted-routebook-old.trbk': 31, 'trusted-routebook-new.trbk': 29, 'other.txt': 90 };
  for (const [name, age] of Object.entries(files)) {
    const path = join(dir, name);
    await writeFile(path, 'x');
    const t = new Date(now - age * day);
    await utimes(path, t, t);
  }
  const dry = await pruneBackups({ dir, now, dryRun: true });
  assert.deepEqual(dry.removed, ['trusted-routebook-old.trbk']);
  assert.equal((await readdir(dir)).length, 3);
  const result = await pruneBackups({ dir, now });
  assert.deepEqual(result.removed, ['trusted-routebook-old.trbk']);
  assert.deepEqual((await readdir(dir)).sort(), ['other.txt', 'trusted-routebook-new.trbk']);
  assert.deepEqual(await pruneBackups({ dir: join(dir, 'missing'), now }), { removed: [], kept: [] });
});

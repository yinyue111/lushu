import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKUP_RETENTION_DAYS, backupTimestampFromName, pruneBackups } from '../../scripts/lib/backupRetention.mjs';
import { THIRD_PARTY_CATEGORIES, operatorCopy, thirdPartySentence } from '../../src/lib/privacyCopy.js';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const DAY = 86400000;
const nameFor = (ms) => `trusted-routebook-${new Date(ms).toISOString().replace(/[:.]/g, '-')}.trbk`;

test('privacy policy has no placeholder and states the 30-day backup window', async () => {
  // JSX collapses line breaks to one space, so normalise whitespace as the browser renders it.
  const src = (await read('src/components/Legal/PrivacyPage.jsx')).replace(/\s+/g, ' ');
  assert.doesNotMatch(src, /待确认|TODO|XX ?天|按备份周期清除|一个月/);
  assert.equal(src.match(/最多保留 30 天/g)?.length, 3);
  assert.doesNotMatch(src, /数据存储地点|数据出境/);
});

test('deletion copy on 我的 page states the 30-day backup window', async () => {
  const src = await read('src/components/My/MyPage.jsx');
  assert.doesNotMatch(src, /按备份周期清除|XX ?天|一个月/);
  assert.match(src, /最多保留 30 天/);
});

test('provider sentence lists only categories integrated in code', () => {
  assert.deepEqual(THIRD_PARTY_CATEGORIES, ['邮件', 'AI 模型']);
  assert.equal(thirdPartySentence(), '我们会使用第三方的邮件和 AI 模型服务来提供功能，只传给它们完成这项功能所需的信息。');
  assert.doesNotMatch(thirdPartySentence(), /短信|审核|内容安全/);
  assert.equal(thirdPartySentence(['邮件', '短信', 'AI 模型']), '我们会使用第三方的邮件、短信和 AI 模型服务来提供功能，只传给它们完成这项功能所需的信息。');
});

test('operator copy renders nothing when unset and never a placeholder', () => {
  assert.deepEqual(operatorCopy(null), { operatorLine: '', supportLine: '' });
  assert.deepEqual(operatorCopy({ name: ' ', email: '' }), { operatorLine: '', supportLine: '' });
  const set = operatorCopy({ name: '示例公司', email: 'help@example.com' });
  assert.equal(set.operatorLine, '运营主体：示例公司，联系邮箱 help@example.com。');
  assert.equal(set.supportLine, '发邮件到 help@example.com，7 个工作日内回复。');
});

test('retention constant matches the 30-day promise', () => {
  assert.equal(BACKUP_RETENTION_DAYS, 30);
});

test('backup filename timestamps parse; junk does not', () => {
  assert.equal(backupTimestampFromName('trusted-routebook-2026-10-16T00-05-00-123Z.trbk'), Date.parse('2026-10-16T00:05:00.123Z'));
  assert.ok(Number.isNaN(backupTimestampFromName('trusted-routebook-manual.trbk')));
  assert.ok(Number.isNaN(backupTimestampFromName('trusted-routebook-2026-13-40T00-00-00-000Z.trbk')));
});

test('pruneBackups uses filename date, not mtime; skips unparseable with a warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prune-'));
  const now = Date.parse('2026-10-16T00:00:00Z');
  const old = nameFor(now - 31 * DAY);
  const recent = nameFor(now - 29 * DAY);
  const files = [old, recent, 'trusted-routebook-manual.trbk', 'other.txt'];
  for (const name of files) await writeFile(join(dir, name), 'x');
  // recent filename but ancient mtime must survive
  await utimes(join(dir, recent), new Date(now - 90 * DAY), new Date(now - 90 * DAY));
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const dry = await pruneBackups({ dir, now, dryRun: true, warn });
  assert.deepEqual(dry.removed, [old]);
  assert.equal((await readdir(dir)).length, 4);
  const result = await pruneBackups({ dir, now, warn });
  assert.deepEqual(result.removed, [old]);
  assert.deepEqual(result.skipped, ['trusted-routebook-manual.trbk']);
  assert.match(warnings.join('\n'), /cannot parse date/);
  assert.deepEqual((await readdir(dir)).sort(), ['other.txt', recent, 'trusted-routebook-manual.trbk'].sort());
});

test('fresh mtime but filename date older than 30 days is deleted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prune-'));
  const name = nameFor(Date.now() - 31 * DAY);
  await writeFile(join(dir, name), 'x'); // mtime = now
  const result = await pruneBackups({ dir, warn: () => {} });
  assert.deepEqual(result.removed, [name]);
  assert.deepEqual(await readdir(dir), []);
});

test('missing backup directory is an error, also in dry run', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'prune-')), 'missing');
  await assert.rejects(pruneBackups({ dir }), /does not exist/);
  await assert.rejects(pruneBackups({ dir, dryRun: true }), /does not exist/);
});

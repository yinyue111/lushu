import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lushu-daily-'));
process.env.ROUTEBOOK_DATA_DIR = dir;
process.env.STORAGE_BACKEND = 'jsonl';
const now = Date.now();
const row = (kind, extra = {}) => JSON.stringify({ kind, status: 'ok', profileId: 'p', createdAt: new Date(now - 3600_000).toISOString(), ...extra });
writeFileSync(
  join(dir, 'ai-logs.jsonl'),
  [
    row('generate-routebook'),
    row('patch-routebook'),
    row('generate-routebook', { status: 'cancelled' }),
    row('generate-routebook', { createdAt: new Date(now - 2 * 86_400_000).toISOString() })
  ].join('\n') + '\n'
);
const { peekDailyGenerationLimit, enforceDailyGenerationLimit } = await import('../../server/ai/generationGuard.mjs');

test('daily cap counts all users, generations + patches, last 24h, excluding cancelled', async () => {
  assert.deepEqual(await peekDailyGenerationLimit({ limit: 3, nowMs: now }), { limited: false, used: 2, limit: 3 });
  assert.equal((await peekDailyGenerationLimit({ limit: 2, nowMs: now })).limited, true);
  await assert.rejects(
    enforceDailyGenerationLimit({ limit: 2, nowMs: now }),
    (/** @type {any} */ error) => error.code === 'GENERATION_DAILY_LIMIT' && (error.status ?? error.statusCode) === 429
  );
  assert.equal((await peekDailyGenerationLimit({ limit: 0 })).limited, false, '0 = off');
});

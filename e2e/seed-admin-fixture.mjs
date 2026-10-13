// E2E fixture for the admin console: two draft routebooks sharing one place (cacheKey) plus an enrichment
// claim and a user report, written into ROUTEBOOK_DATA_DIR before the server starts. Values are clearly
// labelled test data (no real prices or hours).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const dataDir = process.env.ROUTEBOOK_DATA_DIR;
if (!dataDir) throw new Error('ROUTEBOOK_DATA_DIR is required');
process.env.ENRICH_ENABLED = 'false';
const now = new Date().toISOString();
const rb = (id, title, profileId, extra = {}) => ({
  id,
  publicId: id,
  city: '苏州',
  title,
  profileId,
  publishStatus: 'draft',
  createdAt: now,
  updatedAt: now,
  stops: [
    { id: 's1', name: 'E2E 示例园林', day: 'Day 1' },
    { id: 's2', name: 'E2E 示例街区', day: 'Day 1' }
  ],
  ...extra
});
writeFileSync(
  join(dataDir, 'routebooks.jsonl'),
  [rb('e2e-rb-a', 'E2E 苏州一日（甲）', 'p_e2e_a'), rb('e2e-rb-b', 'E2E 苏州一日（乙）', 'p_e2e_b', { publishStatus: 'published' })]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n'
);

const { enrichStore } = await import('../server/enrich/store.mjs');
const { reportEnrichment } = await import('../server/enrich/service.mjs');
const store = enrichStore();
const claim = {
  stopKey: 's1',
  stopName: 'E2E 示例园林',
  field: 'price',
  status: 'filled',
  value: 'E2E 示例值',
  display: '门票：E2E 示例值',
  cacheKey: '苏州|E2E 示例园林|price',
  method: 'pages',
  retrievedAt: now,
  sources: [
    {
      kind: 'web',
      url: 'https://example.org/e2e-fixture',
      title: 'E2E 示例来源页',
      domain: 'example.org',
      quote: '（E2E 测试摘录，非真实信息）',
      retrievedAt: now
    }
  ]
};
for (const id of ['e2e-rb-a', 'e2e-rb-b']) {
  await store.enqueue({ routebookId: id, userId: 'u_e2e' });
  await store.putResult(id, [claim]);
}
await reportEnrichment({ routebookId: 'e2e-rb-a', stopKey: 's1', field: 'price', note: 'E2E：用户说这个值不对', userId: 'u_e2e' });
console.log('seeded');

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT, fetchJson, startServer, writeJsonl } from '../helpers/server.mjs';

const HAS_DIST = existsSync(join(PROJECT_ROOT, 'dist', 'index.html'));
const CREATOR = 'p_creatoridleak01';

test('creator landing: legacy byline → 这位作者的路线; id never in title/meta/body', { skip: !HAS_DIST && 'requires npm run build' }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-creator-'));
  await writeJsonl(dataDir, 'routebooks.jsonl', [
    {
      id: 'creator-test',
      publicId: 'creator-test',
      title: '作者页测试路线',
      city: '杭州',
      publishStatus: 'published',
      version: 1,
      stops: [],
      creator: { id: CREATOR, name: '匿名旅行者', sourceAuthorization: 'user-generated' }
    }
  ]);
  const server = await startServer({ dataDir });
  try {
    const res = await fetch(`${server.baseUrl}/creator/${CREATOR}`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<title>这位作者的路线｜AI 可信路书<\/title>/);
    assert.match(html, /og:title" content="这位作者的路线｜AI 可信路书"/);
    assert.doesNotMatch(html, /og:url|rel="canonical"/);
    assert.ok(!html.includes(CREATOR), 'creator id leaked into SSR html');
    assert.ok(!html.includes('匿名旅行者'));

    const api = await fetchJson(`${server.baseUrl}/api/creators/${CREATOR}`);
    assert.equal(api.data.profile.creator.name, null);

    const unknown = await fetchJson(`${server.baseUrl}/api/creators/p_nobodyhere0000`);
    if (unknown.data?.profile) assert.equal(unknown.data.profile.creator.name, null);
  } finally {
    await server.stop();
  }
});

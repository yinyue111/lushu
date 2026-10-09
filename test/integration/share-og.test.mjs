import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT, fetchJson, startServer, writeJsonl } from '../helpers/server.mjs';
import { aigcMetadata } from '../../src/lib/aigc.js';

const HAS_DIST = existsSync(join(PROJECT_ROOT, 'dist', 'index.html'));

test('aigc metadata: derived from provider / model-origin stops, edited routes say so, public label wins', () => {
  assert.equal(aigcMetadata({ provider: { generatedAt: '2026-10-01T00:00:00Z' }, publicId: 'r1' }).label, 'AI 生成');
  assert.equal(aigcMetadata({ provider: { generatedAt: 'x', editedAt: 'y' } }).label, 'AI 生成 · 经用户编辑');
  assert.equal(aigcMetadata({ stops: [{ provenance: { origin: 'model' } }] }).generated, true);
  assert.equal(aigcMetadata({ stops: [{ provenance: { origin: 'user-added' } }] }).generated, false);
  assert.equal(aigcMetadata({ aigc: { generated: true, label: 'AI 生成', labelVersion: 1 } }).label, 'AI 生成');
});

test(
  'public share page: AIGC metadata in API and HTML, og:url/canonical, escaped noscript pre-render',
  { skip: !HAS_DIST && 'requires npm run build' },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'routebook-og-aigc-'));
    await writeJsonl(dataDir, 'routebooks.jsonl', [
      {
        id: 'og-aigc',
        publicId: 'og-aigc',
        title: '西湖一日',
        summary: '慢走西湖',
        city: '杭州',
        publishStatus: 'published',
        version: 1,
        provider: { name: 'test', model: 'fake-model', generatedAt: '2026-10-01T00:00:00.000Z' },
        stops: [
          { id: 's1', day: 'Day 1', name: '柳浪闻莺' },
          { id: 's2', day: 'Day 1', name: '<script>alert(1)</script>' }
        ]
      }
    ]);
    const server = await startServer({ dataDir, env: { PUBLIC_BASE_URL: 'https://routebook.example' } });
    t.after(server.stop);
    const api = await fetchJson(`${server.baseUrl}/api/share/og-aigc`);
    assert.equal(api.status, 200, JSON.stringify(api.data));
    assert.equal(api.data.routebook.aigc.generated, true);
    assert.equal(api.data.routebook.provider, undefined, 'provider details stay private');
    const html = await fetch(`${server.baseUrl}/share/og-aigc`).then((response) => response.text());
    assert.match(html, /<meta property="og:url" content="https:\/\/routebook\.example\/share\/og-aigc">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/routebook\.example\/share\/og-aigc">/);
    assert.match(html, /<meta property="og:locale" content="zh_CN">/);
    assert.match(html, /<meta name="aigc" content="\{&quot;generated&quot;:true/);
    assert.match(html, /<noscript><article><h1>西湖一日<\/h1><p>AI 生成<\/p>/);
    assert.match(html, /<li>Day 1 · 柳浪闻莺<\/li>/);
    assert.doesNotMatch(html, /<script>alert/);
  }
);

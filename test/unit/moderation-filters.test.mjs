import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keywordPrefilter, parseKeywordList } from '../../server/moderation/filters.mjs';
import { createDomesticModerationAdapter, strictestDecision } from '../../server/moderation/providers.mjs';

test('keyword list parsing and pre-filter decisions', () => {
  const keywords = parseKeywordList('# 注释\nblock:禁词甲\nreview:待审词\n普通词\n\n');
  assert.deepEqual(
    keywords.map((entry) => entry.severity),
    ['block', 'review', 'review']
  );
  assert.equal(keywordPrefilter({ comment: '风景很好，排队十分钟' }, { keywords }).decision, 'pass');
  assert.equal(keywordPrefilter({ comment: '这里有普通词' }, { keywords }).decision, 'review');
  assert.equal(keywordPrefilter({ comment: '待审词', pitfall: '禁词甲' }, { keywords }).decision, 'block');
  const contact = keywordPrefilter({ comment: '订座加微信 travel_123 或打 13912345678' });
  assert.equal(contact.decision, 'review');
  assert.deepEqual(contact.hits.map((hit) => hit.category).sort(), ['contact-im', 'contact-phone']);
  assert.ok(!JSON.stringify(keywordPrefilter({ c: '禁词甲' }, { keywords })).includes('禁词甲'), 'matched terms are not echoed');
  assert.equal(keywordPrefilter({ comment: '门票 120 元，开放到 17:30' }).decision, 'pass');
});

test('domestic adapter is a stub contract that fails closed into review', async () => {
  assert.equal((await createDomesticModerationAdapter().check('x', 'ugc')).decision, 'review');
  const calls = [];
  const ok = createDomesticModerationAdapter({
    url: 'http://moderation.mock/check',
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ decision: 'block', labels: ['politics'] }) };
    }
  });
  assert.deepEqual(await ok.check('文本', 'checkin'), { decision: 'block', labels: ['politics'] });
  assert.deepEqual(calls[0].body, { text: '文本', scene: 'checkin' });
  const failing = createDomesticModerationAdapter({
    url: 'http://moderation.mock/check',
    apiKey: 'k',
    fetchImpl: async () => {
      throw new Error('down');
    }
  });
  assert.equal((await failing.check('文本', 'ugc')).decision, 'review');
  assert.equal(strictestDecision('pass', 'review', 'pass'), 'review');
  assert.equal(strictestDecision('review', 'block'), 'block');
});

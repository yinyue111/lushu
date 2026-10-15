import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestedCityFor } from '../../server/ai/citySuggestion.mjs';

test('suggests the model city only when it clearly differs from the chosen one', () => {
  assert.equal(suggestedCityFor('杭州', '西双版纳傣族自治州景洪市'), '西双版纳傣族自治州景洪');
  assert.equal(suggestedCityFor('杭州', '杭州'), null);
  assert.equal(suggestedCityFor('杭州', '杭州市'), null);
  assert.equal(suggestedCityFor('景洪', '西双版纳傣族自治州景洪市'), null);
  assert.equal(suggestedCityFor('杭州', ''), null);
  assert.equal(suggestedCityFor('杭州', '<script>'), null);
  assert.equal(suggestedCityFor('', '苏州'), null);
});

test('generation keeps the chosen city and only carries a suggestion', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../server/ai/generate.mjs', import.meta.url), 'utf8');
  assert.match(src, /city: payload\.city,\n\s+\.\.\.\(suggestedCityFor\(payload\.city, routebook\.city\)/);
  const view = readFileSync(new URL('../../src/components/Route/RouteView.jsx', import.meta.url), 'utf8');
  assert.match(view, /这些地点好像在「\{cityPrompt\}」，城市要改成它吗？/);
  assert.match(view, /onClick=\{\(\) => actions\.setCity\(cityPrompt\)\}/);
});

test('storage keeps the suggestion until the city matches it', async () => {
  const { normalizeRoutebookForStorage } = await import('../../server/routebooks/normalize.mjs');
  const base = {
    id: 'rb-city-1',
    title: 't',
    stops: [
      { id: 's1', name: 'a', day: 'Day 1' },
      { id: 's2', name: 'b', day: 'Day 1' }
    ]
  };
  assert.equal(normalizeRoutebookForStorage({ ...base, city: '杭州', suggestedCity: '西双版纳' }).suggestedCity, '西双版纳');
  assert.equal(normalizeRoutebookForStorage({ ...base, city: '西双版纳', suggestedCity: '西双版纳' }).suggestedCity, undefined);
  assert.equal(normalizeRoutebookForStorage({ ...base, city: '杭州' }).suggestedCity, undefined);
});

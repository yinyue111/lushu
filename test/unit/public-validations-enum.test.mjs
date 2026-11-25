import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PUBLIC_VALIDATION_STATES, publicValidationRows } from '../../server/lib/termCopy.mjs';
import { buildTransportEstimateValidation } from '../../server/routebooks/normalize.mjs';
import { buildTimeOfDayValidation } from '../../src/lib/timeOfDay.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const PRODUCER_FILES = {
  'edit-routing': 'server/routing/routeExecution.mjs',
  'edit-tempo': 'server/routing/routeExecution.mjs',
  'edit-detour': 'server/routing/routeExecution.mjs',
  'edit-time-of-day': 'src/lib/timeOfDay.js',
  'edit-transport-estimate': 'server/routebooks/normalize.mjs',
  'edit-hours': 'server/routebooks/normalize.mjs',
  'edit-geo': 'server/routebooks/normalize.mjs',
  'source-trust': 'server/routebooks/normalize.mjs',
  'day-count-compressed': 'server/ai/generate.mjs'
};

test('§4.4 every allowed state in PUBLIC_VALIDATION_STATES is literally produced by its source file', () => {
  assert.deepEqual(Object.keys(PUBLIC_VALIDATION_STATES).sort(), Object.keys(PRODUCER_FILES).sort());
  for (const [id, states] of Object.entries(PUBLIC_VALIDATION_STATES)) {
    const relPath = PRODUCER_FILES[id];
    const source = readFileSync(`${ROOT}/${relPath}`, 'utf8');
    assert.equal(source.includes(`'${id}'`) || source.includes(`"${id}"`), true, `${relPath} must emit id "${id}"`);
    for (const state of states) {
      assert.equal(source.includes(`'${state}'`) || source.includes(`"${state}"`), true, `${relPath} no longer writes allowed state "${state}" for ${id}`);
    }
  }
});

test('§2.2 & §4.4 transport estimate validation: hidden for transit and self-drive, shown when taxi fallback applies', () => {
  const stops = [
    { id: 's1', day: 'Day 1', time: '09:30', name: '柳浪闻莺', lat: 30.242, lng: 120.1617 },
    { id: 's2', day: 'Day 1', time: '14:00', name: '法喜寺', lat: 30.2366, lng: 120.0954 }
  ];
  assert.equal(buildTransportEstimateValidation(stops, { constraints: { transport: '公交地铁 + 步行' } }), null);
  assert.equal(buildTransportEstimateValidation(stops, { constraints: { transport: '地铁优先' } }), null);
  assert.equal(buildTransportEstimateValidation(stops, { constraints: { transport: '自驾' } }), null);
  const fallback = buildTransportEstimateValidation(stops, { constraints: { transport: '少换乘' } });
  assert.equal(fallback?.id, 'edit-transport-estimate');
  assert.equal(fallback?.state, '待核对');
});

test('§4.4 time-of-day validation flags night/sunset stops scheduled in the morning', () => {
  const mismatch = buildTimeOfDayValidation([{ id: 's1', day: 'Day 1', time: '09:00', name: '钱塘江夜景看台' }]);
  assert.equal(mismatch?.id, 'edit-time-of-day');
  assert.equal(mismatch?.state, '待核对');
  assert.equal(buildTimeOfDayValidation([{ id: 's1', day: 'Day 1', time: '19:30', name: '钱塘江夜景看台' }]), null);
});

test('§4.4 non-enum states clamp to 待确认 in publicValidationRows', () => {
  const rows = publicValidationRows([
    { id: 'source-trust', label: '导入来源', state: '避开老板娘家楼下', detail: '私密备注' },
    { id: 'edit-routing', label: '路线', state: '已更新', detail: '旧数据' }
  ]);
  assert.deepEqual(rows, [
    { id: 'source-trust', label: '导入来源', state: '待确认' },
    { id: 'edit-routing', label: '路线', state: '待确认' }
  ]);
});

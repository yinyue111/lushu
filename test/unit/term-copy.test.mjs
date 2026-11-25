import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEGACY_VALIDATION_STATES,
  PUBLIC_VALIDATION_STATES,
  modernOwnerRoutebookCopy,
  modernTermCopy,
  modernValidationState
} from '../../server/lib/termCopy.mjs';

test('legacy stored terms read as 核对; v4 state names untouched', () => {
  assert.equal(modernTermCopy('待验证'), '待核对');
  assert.equal(modernTermCopy('最近验证'), '最近核对');
  assert.equal(modernTermCopy('POI 待验证'), '地点待核对');
  assert.equal(modernTermCopy('未核验'), '未核对');
  assert.equal(modernTermCopy('无需核验'), '无需核对');
  assert.equal(modernTermCopy('资料核验分'), '资料核对分');
  assert.equal(modernTermCopy('编辑校验'), '编辑核对');
  for (const keep of ['核对中', '已核对', '已反馈待复核', '人工核实', '待确认', '待复核']) {
    assert.equal(modernTermCopy(keep), keep);
  }
  assert.equal(modernTermCopy(undefined), undefined);
});

test('§7 per-id legacy validation states map only on their designated id', () => {
  const expectedSix = [
    ['edit-routing', '已核验', '已查过'],
    ['edit-routing', '需复核', '还没查'],
    ['edit-tempo', '待复核', '还没查'],
    ['edit-detour', '待复核', '还没查'],
    ['edit-hours', '需填出行日期', '未核对'],
    ['edit-hours', '无数据', '未核对']
  ];
  for (const [id, legacy, mapped] of expectedSix) {
    assert.equal(modernValidationState(id, legacy), mapped, `${id}: ${legacy} -> ${mapped}`);
    assert.equal(PUBLIC_VALIDATION_STATES[id].includes(mapped), true, `mapped state ${mapped} must be valid in ${id} enum`);
  }

  // 「需复核」 stays valid on edit-hours, edit-geo and source-trust
  for (const id of ['edit-hours', 'edit-geo', 'source-trust']) {
    assert.equal(modernValidationState(id, '需复核'), '需复核');
    assert.equal(PUBLIC_VALIDATION_STATES[id].includes('需复核'), true);
  }

  // Legacy values placed on a different validation id are never mis-mapped to another id's target
  assert.notEqual(modernValidationState('edit-hours', '已核验'), '已查过');
  assert.equal(modernValidationState('edit-hours', '待复核'), '待复核');
  assert.equal(modernValidationState('edit-geo', '无数据'), '无数据');
  assert.equal(modernValidationState('edit-geo', '需填出行日期'), '需填出行日期');
  assert.equal(modernValidationState('edit-tempo', '需复核'), '需复核');

  // 「已更新」 on edit-routing is intentionally NOT mapped in release-v7
  assert.equal(modernValidationState('edit-routing', '已更新'), '已更新');
  assert.equal(PUBLIC_VALIDATION_STATES['edit-routing'].includes('已更新'), false);

  // Guard: clearing LEGACY_VALIDATION_STATES would break the 6 required mappings
  assert.deepEqual(Object.keys(LEGACY_VALIDATION_STATES).sort(), ['edit-detour', 'edit-hours', 'edit-routing', 'edit-tempo']);
});

test('modernOwnerRoutebookCopy rewrites owner output without mutating stored object', () => {
  const stored = Object.freeze({
    id: 'rb-owner-copy',
    validations: Object.freeze([
      Object.freeze({ id: 'edit-routing', label: '路线核验', state: '已核验', detail: '保存后已按道路结果核验 2 段。' }),
      Object.freeze({ id: 'source-trust', label: '导入来源', state: '避开老板娘家楼下', detail: '经过已审核 POI 校验。' })
    ]),
    metrics: Object.freeze([Object.freeze({ label: '编辑校验', value: '未核验' })])
  });
  const out = modernOwnerRoutebookCopy(stored);
  assert.equal(out.validations[0].label, '路线核对');
  assert.equal(out.validations[0].state, '已查过');
  assert.equal(out.validations[0].detail, '保存后已按道路结果核对 2 段。');
  assert.equal(out.validations[1].state, '避开老板娘家楼下');
  assert.equal(out.validations[1].detail, '经过已核对 POI 核对。');
  assert.equal(out.metrics[0].label, '编辑核对');
  assert.equal(out.metrics[0].value, '未核对');
  // Original frozen object was untouched
  assert.equal(stored.validations[0].state, '已核验');
});

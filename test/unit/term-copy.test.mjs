import assert from 'node:assert/strict';
import test from 'node:test';
import { modernTermCopy } from '../../server/lib/termCopy.mjs';

test('legacy stored terms read as 核对; v4 state names untouched', () => {
  assert.equal(modernTermCopy('待验证'), '待核对');
  assert.equal(modernTermCopy('最近验证'), '最近核对');
  assert.equal(modernTermCopy('POI 待验证'), '地点待核对');
  assert.equal(modernTermCopy('未核验'), '未核对');
  for (const keep of ['核对中', '已核对', '已反馈待复核', '人工核实', '待确认', '待复核']) assert.equal(modernTermCopy(keep), keep);
  assert.equal(modernTermCopy(undefined), undefined);
});

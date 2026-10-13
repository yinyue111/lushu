import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInitialPoiEditorForm,
  buildPoiEditorPayload,
  createEmptyEvidence,
  createEmptyFact,
  validatePoiEditorForm
} from '../../admin/src/ops/poiEditorModel.js';

const poi = {
  poiId: 'poi-editor-test',
  city: '杭州',
  name: '柳浪闻莺',
  reviewStatus: 'pending',
  location: { lat: 30.242, lng: 120.1617 },
  evidence: [{ id: 'existing-evidence', url: 'https://example.com/official', capturedAt: '2026-10-01', reviewStatus: 'approved', sourceType: 'official' }],
  facts: [
    {
      id: 'existing-fact',
      field: '开放时间',
      value: '全天',
      reviewStatus: 'approved',
      sourceType: 'official',
      validUntil: '2099-12-31',
      evidenceIds: ['existing-evidence']
    }
  ],
  audits: [{ id: 'existing-audit', note: '历史审核', createdAt: '2026-10-01' }]
};

test('POI review state change requires note', () => {
  const form = buildInitialPoiEditorForm(poi);
  form.reviewStatus = 'approved';
  assert.match(validatePoiEditorForm(poi, form).errors.join(), /审核备注/u);
});

test('approved evidence needs traceable source and collection date', () => {
  const form = buildInitialPoiEditorForm(poi);
  form.reviewNote = '核验新增证据完整性';
  form.evidence.push({ ...createEmptyEvidence(), reviewStatus: 'approved' });
  const errors = validatePoiEditorForm(poi, form).errors.join();
  assert.match(errors, /URL 或受控文档 ID/u);
  assert.match(errors, /采集日期/u);
});

test('approved fact must reference approved evidence', () => {
  const form = buildInitialPoiEditorForm(poi);
  form.reviewNote = '审核事实引用合法性';
  form.facts.push({ ...createEmptyFact(), field: '预约', value: '需要预约', reviewStatus: 'approved' });
  assert.match(validatePoiEditorForm(poi, form).errors.join(), /至少一条已通过证据/u);
});

test('payload preserves history and excludes references to blank evidence drafts', () => {
  const form = buildInitialPoiEditorForm(poi);
  const blank = createEmptyEvidence();
  form.evidence.push(blank);
  form.facts[0].evidenceIds.push(blank.id);
  form.reviewStatus = 'approved';
  form.reviewNote = '官方事实复核通过';
  const payload = buildPoiEditorPayload(poi, form, { auditCreatedAt: '2026-10-09T00:00:00.000Z' });
  assert.equal(payload.evidence.length, 1);
  assert.deepEqual(payload.facts[0].evidenceIds, ['existing-evidence']);
  assert.equal(payload.audits[0].id, 'existing-audit');
  assert.equal(payload.audits.at(-1).source, 'ops-editor');
  assert.equal(payload.audits.at(-1).action, 'manual-review');
});

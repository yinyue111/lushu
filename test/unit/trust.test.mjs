import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_TRUST_SAMPLE_THRESHOLD,
  evaluatePoiTrustSample,
  formatVerifiedDate,
  getRouteTrustBadgeState,
  getRouteTrustPresentation,
  getStopTrustBadge,
  maskTrustMetrics
} from '../../src/lib/trust.js';

const verifiedMeta = (overrides = {}) => ({
  source: 'verified-feedback', sampleCount: PUBLIC_TRUST_SAMPLE_THRESHOLD, displayScore: 87.6, label: '', ...overrides
});

test('route trust is verified only with verified-feedback, enough samples and a 0-100 score', () => {
  const ok = getRouteTrustPresentation({ trustMeta: verifiedMeta({ latestVerifiedAt: '2026-10-01' }) });
  assert.equal(ok.verified, true);
  assert.equal(ok.score, 88);
  assert.equal(ok.scoreText, '88');
  assert.equal(ok.label, '真实打卡验证可信分');
  assert.equal(ok.sampleProgressText, '');
  assert.equal(ok.latestVerifiedAt, '2026-10-01');
  for (const meta of [
    verifiedMeta({ source: 'prediction' }),
    verifiedMeta({ sampleCount: PUBLIC_TRUST_SAMPLE_THRESHOLD - 1 }),
    verifiedMeta({ displayScore: 101 }),
    verifiedMeta({ displayScore: -1 }),
    verifiedMeta({ displayScore: '' }),
    verifiedMeta({ displayScore: null }),
    verifiedMeta({ displayScore: 'abc' })
  ]) {
    const presentation = getRouteTrustPresentation({ trustMeta: meta });
    assert.equal(presentation.verified, false, JSON.stringify(meta));
    assert.equal(presentation.score, null);
    assert.equal(presentation.scoreText, '待验证');
    assert.equal(presentation.latestVerifiedAt, null);
  }
});

test('unverified routes show sample progress capped at the threshold', () => {
  assert.equal(getRouteTrustPresentation({ trustMeta: { sampleCount: 1 } }).sampleProgressText, `已收集 1/${PUBLIC_TRUST_SAMPLE_THRESHOLD} 份真实验证`);
  assert.equal(getRouteTrustPresentation({ trustMeta: { sampleCount: 99, source: 'x' } }).sampleProgressText, `已收集 ${PUBLIC_TRUST_SAMPLE_THRESHOLD}/${PUBLIC_TRUST_SAMPLE_THRESHOLD} 份真实验证`);
  assert.equal(getRouteTrustPresentation({ feedbackSummary: { validArrivalCount: 2 } }).sampleCount, 2);
  assert.equal(getRouteTrustPresentation(null).sampleCount, 0);
  assert.equal(getRouteTrustPresentation({ trustMeta: { sampleCount: -5 } }).sampleCount, 0);
  assert.equal(getRouteTrustPresentation({ trustMeta: { label: ' 自定义 ' } }).label, '自定义');
});

test('badge state: trial for non-launch cities, verified/prediction otherwise', () => {
  assert.equal(getRouteTrustBadgeState({ city: '成都', trustMeta: verifiedMeta() }).tone, 'trial');
  const verified = getRouteTrustBadgeState({ city: '杭州', trustMeta: verifiedMeta() });
  assert.deepEqual([verified.tone, verified.badgeClass, verified.value, verified.score], ['verified', 'badge-green', '88', 88]);
  const prediction = getRouteTrustBadgeState({ city: '上海', trustMeta: { sampleCount: 1 } });
  assert.deepEqual([prediction.tone, prediction.value, prediction.score], ['prediction', '待验证', null]);
});

test('POI trust sample evaluation and stop badges', () => {
  assert.deepEqual(evaluatePoiTrustSample({ sampleCount: 3, score: 90 }), { sampleCount: 3, score: 90, verified: true });
  assert.equal(evaluatePoiTrustSample({ sampleCount: 2, score: 90 }).verified, false);
  assert.equal(evaluatePoiTrustSample({ sampleCount: 3.5, score: 90 }).sampleCount, 0);
  assert.equal(evaluatePoiTrustSample({ sampleCount: 3, score: '90' }).score, null);
  assert.equal(evaluatePoiTrustSample(undefined).verified, false);
  assert.equal(getStopTrustBadge({ poiTrust: { sampleCount: 5, score: 79.5 } }, 'trial').tone, 'trial');
  assert.deepEqual(getStopTrustBadge({ poiTrust: { sampleCount: 5, score: 79.5 } }, 'verified'), {
    tone: 'verified', badgeClass: 'badge-green', verified: true, value: '80', label: 'POI 可信 80'
  });
  assert.equal(getStopTrustBadge({}, 'prediction').value, '待验证');
});

test('trust metric masking and verified date formatting', () => {
  const metrics = [{ label: '可信分', value: 90 }, { label: '站点数', value: 6 }, { label: '平均评分', value: 4.8 }];
  assert.deepEqual(maskTrustMetrics(metrics, 'verified'), metrics);
  assert.deepEqual(maskTrustMetrics(metrics, 'prediction').map((metric) => metric.value), ['待验证', 6, '待验证']);
  assert.deepEqual(maskTrustMetrics(metrics, 'trial', 2).map((metric) => metric.value), ['待复核', 6]);
  assert.equal(formatVerifiedDate(''), '待验证');
  assert.equal(formatVerifiedDate('not a date'), '待验证');
  assert.match(formatVerifiedDate('2026-10-08T00:00:00Z'), /2026/);
});

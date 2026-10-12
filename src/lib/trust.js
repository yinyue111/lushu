import { trustedCities } from './content.js';

// 与服务端 publicTrustMeta 契约一致的公开采样阈值：独立有效样本达到该值、
// source === 'verified-feedback' 且 displayScore 合法（0-100）才允许展示真实可信分。
export const PUBLIC_TRUST_SAMPLE_THRESHOLD = 3;

export function getRouteTrustPresentation(routebook) {
  const meta = routebook?.trustMeta ?? {};
  const sampleCount = Math.max(0, Number(meta.sampleCount ?? routebook?.feedbackSummary?.validArrivalCount ?? 0) || 0);
  const scorePresent = typeof meta.displayScore === 'number' || (typeof meta.displayScore === 'string' && meta.displayScore.trim() !== '');
  const displayScore = scorePresent ? Number(meta.displayScore) : Number.NaN;
  const verified =
    meta.source === 'verified-feedback' &&
    sampleCount >= PUBLIC_TRUST_SAMPLE_THRESHOLD &&
    Number.isFinite(displayScore) &&
    displayScore >= 0 &&
    displayScore <= 100;
  const metaLabel = typeof meta.label === 'string' && meta.label.trim() ? meta.label.trim() : '';
  const label = verified ? metaLabel || '真实打卡验证可信分' : metaLabel || '资料核验 · 待真实验证';
  const sampleProgressText = verified ? '' : `已收集 ${Math.min(sampleCount, PUBLIC_TRUST_SAMPLE_THRESHOLD)}/${PUBLIC_TRUST_SAMPLE_THRESHOLD} 份真实验证`;

  return {
    verified,
    score: verified ? Math.round(displayScore) : null,
    scoreText: verified ? String(Math.round(displayScore)) : '待验证',
    compactText: verified ? `${label} ${Math.round(displayScore)}` : label,
    label,
    sampleProgressText,
    sampleCount,
    latestVerifiedAt: verified ? meta.latestVerifiedAt || null : null
  };
}

// 路线可信徽章的唯一出口：所有页面（首页/目的地/我的/达人/分享预览/公开分享页）
// 必须复用这里的状态，禁止在组件内重新实现徽章判断。
// tone: 'trial'（非首批可信城市，人工复核前不输出任何可信文案与数值）
//     | 'verified'（严格满足服务端 publicTrustMeta 契约，可展示真实可信分）
//     | 'prediction'（其余一律按预测处理，不虚标「已验证」）。
export function getRouteTrustBadgeState(routebook) {
  if (!trustedCities.includes(routebook?.city)) {
    return {
      show: true,
      tone: 'trial',
      badgeClass: 'badge-orange',
      verified: false,
      value: '待复核',
      text: 'AI 草稿 · 未实地确认',
      compactText: 'AI 草稿 · 未实地确认',
      sampleProgressText: '',
      score: null
    };
  }
  const presentation = getRouteTrustPresentation(routebook);
  if (presentation.verified) {
    return {
      show: true,
      tone: 'verified',
      badgeClass: 'badge-green',
      verified: true,
      value: presentation.scoreText,
      text: presentation.label,
      compactText: presentation.compactText,
      sampleProgressText: '',
      score: presentation.score
    };
  }
  return {
    show: true,
    tone: 'prediction',
    badgeClass: 'badge-blue',
    verified: false,
    value: '待验证',
    text: presentation.label,
    compactText: presentation.compactText,
    sampleProgressText: presentation.sampleProgressText,
    score: null
  };
}

// 站点级 verified 判定的唯一出口：独立有效样本达到 PUBLIC_TRUST_SAMPLE_THRESHOLD
// 且 score 为 0-100 的合法数值才算已验证。所有组件禁止重复实现该判定。
export function evaluatePoiTrustSample(poiTrust) {
  const sampleCount = Number.isInteger(poiTrust?.sampleCount) && poiTrust.sampleCount > 0 ? poiTrust.sampleCount : 0;
  const rawScore = poiTrust?.score;
  const score = Number.isFinite(rawScore) ? rawScore : null;
  const verified = sampleCount >= PUBLIC_TRUST_SAMPLE_THRESHOLD && Number.isFinite(score) && score >= 0 && score <= 100;
  return { sampleCount, score, verified };
}

// 站点级可信状态：与路线级共用同一采样阈值；trial 路线下所有站点一律待复核。
export function getStopTrustState(stop, routeTone) {
  const { tone, value } = getStopTrustBadge(stop, routeTone);
  return { tone, value };
}

// 站点徽章完整字段（tone/badgeClass/verified/value/label）：
// 站点列表、分享预览等页面统一从这里取，禁止在组件内重新拼徽章判断。
export function getStopTrustBadge(stop, routeTone) {
  if (routeTone === 'trial') {
    return { tone: 'trial', badgeClass: 'badge-orange', verified: false, value: '待复核', label: 'AI 草稿 · 未实地确认' };
  }
  const { score, verified } = evaluatePoiTrustSample(stop?.poiTrust);
  return verified
    ? { tone: 'verified', badgeClass: 'badge-green', verified: true, value: String(Math.round(score)), label: `POI 可信 ${Math.round(score)}` }
    : { tone: 'prediction', badgeClass: 'badge-blue', verified: false, value: '待验证', label: 'POI 待验证' };
}

// 可信指标遮罩：路线未达 verified 时，带「可信/预测/均分/评分/得分」字样的指标
// 一律遮罩为待验证/待复核，避免把预测数值当成真实数据展示。
export function maskTrustMetrics(metrics = [], routeTone, limit = 6) {
  return metrics.slice(0, limit).map((metric) => {
    if (routeTone === 'verified' || !/(可信|预测|均分|评分|得分)/.test(String(metric?.label ?? ''))) return metric;
    return { ...metric, value: routeTone === 'trial' ? '待复核' : '待验证' };
  });
}

export function formatVerifiedDate(value) {
  if (!value) return '待验证';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '待验证' : date.toLocaleDateString('zh-CN');
}

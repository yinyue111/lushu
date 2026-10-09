export function averageSourcePrediction(sources) {
  if (!sources.length) return 0;
  const scores = sources.map(sourcePredictionValue).filter((score) => score != null);
  return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
}

export function sourcePredictionValue(source) {
  const value = source?.predictionScore ?? source?.trustScore;
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}

/** Visual tone for a source prediction score: sky (>=70 or unknown), warn (45-69), bad (<45). */
export function sourcePredictionTone(score) {
  if (score == null || score >= 70) return 'sky';
  return score >= 45 ? 'warn' : 'bad';
}

// Budget choices state both the basis (每人) and the scope (全程/每日) so the
// server-side budget check knows what it is comparing against. '' = 不设预算.
export const BUDGET_OPTIONS = Object.freeze([
  { label: '不设预算', value: '' },
  { label: '全程 500 元内', value: '每人全程 500 元内' },
  { label: '全程 900 元左右', value: '每人全程 900 元左右' },
  { label: '全程 1500 元左右', value: '每人全程 1500 元左右' },
  { label: '每日 300 元左右', value: '每人每日 300 元左右' }
]);

export function budgetValueForLabel(label) {
  return BUDGET_OPTIONS.find((option) => option.label === label)?.value ?? '';
}

export function budgetHint(budget) {
  const value = String(budget ?? '').trim();
  if (!value) return '不设预算：生成时不按预算筛选，路书里只汇总已知费用。';
  if (BUDGET_OPTIONS.some((option) => option.value === value)) return '按每人计算；“全程”是整趟行程合计，“每日”会按天数折算。';
  const scoped = /全程|每日|每天|日均|总预算/.test(value);
  return `当前预算：${value}${scoped ? '' : '（没写全程还是每日，系统会按全程计算）'}。`;
}

const IMPORT_STATUS_LABELS = {
  fetched: '已读取公开内容',
  'metadata-only': '只识别到链接',
  unavailable: '页面已删除或需登录',
  failed: '抓取失败'
};

export function importStatusLabel(status) {
  return IMPORT_STATUS_LABELS[status] ?? '状态待补充';
}

/** Typed 必去 text plus candidates the user marked 必去 (and kept included), de-duplicated. */
export function mergeMustGoConstraint(mustGoText, candidatePlaces = []) {
  const typed = String(mustGoText ?? '')
    .split(/[、，,;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const marked = (Array.isArray(candidatePlaces) ? candidatePlaces : [])
    .filter((place) => place?.mustGo && place?.included !== false)
    .map((place) => String(place.name ?? '').trim())
    .filter(Boolean);
  return [...new Set([...typed, ...marked])].join('、');
}

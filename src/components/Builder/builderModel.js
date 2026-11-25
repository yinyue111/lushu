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

// Six canonical transport preferences offered on the Builder page (§2.2 & §10).
export const DEFAULT_TRANSPORT = '公交地铁 + 步行';
export const TRANSPORT_OPTIONS = Object.freeze(['公交地铁 + 步行', '地铁优先', '步行 + 打车', '自驾', '少换乘', '亲子少走路']);

export const DEFAULT_MEAL_PLAN = '留出正餐时段';
export const MEAL_PLAN_OPTIONS = Object.freeze(['留出正餐时段', '顺路简餐', '不排餐饮']);

// 江浙沪全部 25 座开放城市的主要车站/机场快捷项（配合 coordinates.js 真实坐标锚定起止顺序）。
export const CITY_TRANSIT_HUBS = Object.freeze({
  上海: Object.freeze(['上海虹桥站', '上海站', '上海南站', '浦东机场']),
  南京: Object.freeze(['南京南站', '南京站', '禄口机场']),
  无锡: Object.freeze(['无锡东站', '无锡站', '硕放机场']),
  徐州: Object.freeze(['徐州东站', '徐州站', '观音机场']),
  常州: Object.freeze(['常州北站', '常州站', '奔牛机场']),
  苏州: Object.freeze(['苏州站', '苏州北站', '苏州园区站']),
  南通: Object.freeze(['南通西站', '南通站', '兴东机场']),
  连云港: Object.freeze(['连云港站', '白塔埠机场']),
  淮安: Object.freeze(['淮安东站', '涟水机场']),
  盐城: Object.freeze(['盐城站', '南洋机场']),
  扬州: Object.freeze(['扬州东站', '扬州站', '扬泰机场']),
  镇江: Object.freeze(['镇江站', '镇江南站']),
  泰州: Object.freeze(['泰州站', '扬泰机场']),
  宿迁: Object.freeze(['宿迁站']),
  杭州: Object.freeze(['杭州东站', '杭州西站', '杭州站', '萧山机场']),
  宁波: Object.freeze(['宁波站', '栎社机场']),
  温州: Object.freeze(['温州南站', '温州北站', '龙湾机场']),
  嘉兴: Object.freeze(['嘉兴南站', '嘉兴站']),
  湖州: Object.freeze(['湖州站', '湖州东站']),
  绍兴: Object.freeze(['绍兴北站', '绍兴站']),
  金华: Object.freeze(['金华站', '金华南站', '义乌站']),
  衢州: Object.freeze(['衢州站', '衢州西站']),
  舟山: Object.freeze(['普陀山机场', '朱家尖蜈蚣峙码头']),
  台州: Object.freeze(['台州站', '台州西站', '路桥机场']),
  丽水: Object.freeze(['丽水站'])
});

export function transitHubsForCity(city) {
  const key = String(city ?? '')
    .trim()
    .replace(/市$/u, '');
  return CITY_TRANSIT_HUBS[key] ?? [];
}

export function formatTransitWindowSummary(constraints = {}) {
  const arrTime = String(constraints?.arrivalTime ?? '').trim();
  const arrHub = String(constraints?.arrivalHub ?? '').trim();
  const depTime = String(constraints?.departureTime ?? '').trim();
  const depHub = String(constraints?.departureHub ?? '').trim();
  const parts = [];
  if (arrTime || arrHub) parts.push(`首日${arrTime ? ` ${arrTime}` : ''}到${arrHub || '目的地'}`);
  if (depTime || depHub) parts.push(`末日${depTime ? ` ${depTime}` : ''}从${depHub || '返程站'}走`);
  return parts.join(' · ');
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

/**
 * @param {string} status
 * @param {string} [unavailableReason] 'too-little' for title-only / near-empty pages
 */
export function importStatusLabel(status, unavailableReason = '') {
  if (status === 'unavailable' && unavailableReason === 'too-little') return '内容太少，读不到攻略';
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

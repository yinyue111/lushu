// Verifiable trust signals shared by the server (scoring, storage) and the UI
// (labels, explanation). Nothing here reads a model's opinion of itself: the
// evidence score is built only from where a stop came from, whether it matches
// the reviewed POI catalog, how its coordinate was obtained, and how many
// reviewed facts with evidence and an unexpired validity window back it.
// Real check-ins are blended in separately (server/trust/feedback.mjs).

/** Where a stop came from. `unknown` is used for routebooks saved before provenance existed. */
export const STOP_ORIGINS = Object.freeze({
  'user-guide': { label: '来自你的攻略', detail: '站点名称出现在你提供的攻略或必去清单里。', points: 20 },
  'imported-source': { label: '来自导入来源', detail: '站点名称出现在平台读取并存证的导入来源里。', points: 15 },
  'user-added': { label: '你手动添加', detail: '这一站是你在编辑时添加或改名的。', points: 10 },
  model: { label: 'AI 补充推荐', detail: '你的输入里没有提到这一站，是 AI 补充的，出发前请自行核对。', points: 0 },
  unknown: { label: '来源未记录', detail: '这条路书保存时还没有记录站点来源。', points: 5 }
});

export const REVIEWED_POI_POINTS = 20;
export const COORDINATE_POINTS = Object.freeze({ verified: 40, approximate: 10, none: 0 });
export const VERIFIED_FACT_POINTS = Object.freeze({ one: 10, twoOrMore: 20 });
export const STOP_EVIDENCE_MAX = 100;

export const TRUST_SCORE_EXPLANATION =
  '资料核验分按站点平均：站点来源最多 40 分（来自你的攻略 20、导入来源 15、手动添加 10、AI 补充 0，命中运营已审核 POI 再加 20），' +
  '坐标核验最多 40 分（已审核 POI 或地图服务精确定位 40、近似坐标 10），有证据且在有效期内的已审核事实最多 20 分。' +
  '模型对自己的打分不计入。有真实 GPS 到达打卡后，真实打卡的权重逐步提高（最多 75%）。';

const VERIFIED_COORDINATE_SOURCES = new Set(['known-poi', 'amap-poi', 'amap-geocode', 'ops-poi']);
const COARSE_COORDINATE_SOURCES = new Set(['city-center', 'region-center', 'country-center']);

export function normalizeStopOrigin(value) {
  return Object.hasOwn(STOP_ORIGINS, value) ? value : 'unknown';
}

/**
 * @param {any} stop
 * @returns {'verified' | 'approximate' | 'none'}
 */
export function coordinateVerificationLevel(stop) {
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return 'none';
  const source = String(stop?.coordinateSource ?? '');
  if (COARSE_COORDINATE_SOURCES.has(source)) return 'none';
  if (VERIFIED_COORDINATE_SOURCES.has(source) && stop?.navigationDisabled !== true) return 'verified';
  return 'approximate';
}

/**
 * Points for one stop. `verifiedFactCount` is supplied by the server from the
 * reviewed POI catalog (approved facts with approved evidence and a validity
 * date in the future); the client never invents it.
 * @param {any} stop
 */
export function stopEvidenceSignals(stop) {
  const provenance = stop?.provenance ?? {};
  const origin = normalizeStopOrigin(provenance.origin);
  const reviewedPoi = provenance.reviewedPoi === true;
  const coordinate = coordinateVerificationLevel(stop);
  const factCount = Math.max(0, Math.floor(Number(provenance.verifiedFactCount) || 0));
  const originPoints = STOP_ORIGINS[origin].points + (reviewedPoi ? REVIEWED_POI_POINTS : 0);
  const coordinatePoints = COORDINATE_POINTS[coordinate];
  const factPoints = factCount >= 2 ? VERIFIED_FACT_POINTS.twoOrMore : factCount === 1 ? VERIFIED_FACT_POINTS.one : 0;
  return {
    origin,
    reviewedPoi,
    coordinate,
    verifiedFactCount: factCount,
    originPoints,
    coordinatePoints,
    factPoints,
    points: originPoints + coordinatePoints + factPoints
  };
}

/**
 * Route-level evidence score (0-100, or null without stops) and a breakdown the
 * UI can explain. No clamping to a flattering range: an all-AI route with
 * approximate coordinates scores 10.
 * @param {any[]} stops
 */
export function routeEvidenceScore(stops) {
  const list = Array.isArray(stops) ? stops : [];
  if (!list.length) return { score: null, breakdown: emptyBreakdown() };
  const signals = list.map(stopEvidenceSignals);
  const avg = (key) => Math.round((signals.reduce((sum, item) => sum + item[key], 0) / signals.length) * 10) / 10;
  const origins = Object.fromEntries(Object.keys(STOP_ORIGINS).map((key) => [key, 0]));
  for (const item of signals) origins[item.origin] += 1;
  return {
    score: Math.round(signals.reduce((sum, item) => sum + item.points, 0) / signals.length),
    breakdown: {
      stopCount: signals.length,
      origins,
      reviewedPoiCount: signals.filter((item) => item.reviewedPoi).length,
      verifiedCoordinateCount: signals.filter((item) => item.coordinate === 'verified').length,
      approximateCoordinateCount: signals.filter((item) => item.coordinate === 'approximate').length,
      verifiedFactStopCount: signals.filter((item) => item.verifiedFactCount > 0).length,
      originPoints: avg('originPoints'),
      coordinatePoints: avg('coordinatePoints'),
      factPoints: avg('factPoints')
    }
  };
}

function emptyBreakdown() {
  return {
    stopCount: 0,
    origins: Object.fromEntries(Object.keys(STOP_ORIGINS).map((key) => [key, 0])),
    reviewedPoiCount: 0,
    verifiedCoordinateCount: 0,
    approximateCoordinateCount: 0,
    verifiedFactStopCount: 0,
    originPoints: 0,
    coordinatePoints: 0,
    factPoints: 0
  };
}

// ---- text mention matching (used to derive `origin`) -----------------------

const GENERIC_PLACE_SUFFIXES = ['风景名胜区', '风景区', '景区', '历史文化街区', '历史文化名街', '公园', '古镇', '街区'];

export function normalizePlaceText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s·•，,。.、“”‘’'"()（）[\]【】_\-—~!！?？:：;；/|]+/g, '')
    .toLowerCase();
}

/** Name variants that may legitimately appear in free text for this place. */
export function placeNameVariants(name, aliases = []) {
  const variants = new Set();
  for (const raw of [name, ...(Array.isArray(aliases) ? aliases : [])]) {
    const normalized = normalizePlaceText(raw);
    if (normalized.length >= 2) variants.add(normalized);
    for (const suffix of GENERIC_PLACE_SUFFIXES) {
      if (normalized.endsWith(suffix) && normalized.length - suffix.length >= 2) variants.add(normalized.slice(0, -suffix.length));
    }
  }
  return [...variants];
}

/**
 * Returns the variant of `name`/`aliases` found in `text`, or '' when none is.
 * Only whole variants are matched (no fuzzy similarity), so a mention is a fact
 * about the user's text, not a guess.
 */
export function findPlaceMention(text, name, aliases = []) {
  const haystack = normalizePlaceText(text);
  if (!haystack) return '';
  return placeNameVariants(name, aliases).find((variant) => haystack.includes(variant)) ?? '';
}

const SKY_STATES = new Set(['无需核对', '无需判断', '已压缩', '无预算约束', '未设置']);

const WARN_STATES = new Set([
  '待确认',
  '低可信',
  '未核对',
  '还没查',
  '需复核',
  '部分待复核',
  '待核对',
  '待补充',
  '偏紧',
  '需重排',
  '时间冲突',
  '时段冲突',
  '闭馆冲突'
]);

const OK_STATES = new Set(['通过', '已查过', '可执行', '可参考', '已更新', '已应用', '充足', '正常']);

const WARN_PATTERN = /复核|还没查|偏紧|需重排|缓冲|无数据|偏远|待|超|风险|未|冲突|不满足|低可信/;
const OK_PATTERN = /通过|已查过|可执行|可参考|已更新|已应用|充足|正常/;
const SKY_PATTERN = /无需|已压缩|无预算约束|未设置/;

/**
 * Maps a validation state label to a semantic Chip/badge tone.
 * Unknown states outside known pass/info sets fall back to 'warn'.
 * @param {string | null | undefined} state
 * @returns {'ok' | 'warn' | 'sky'}
 */
export function validationStateTone(state) {
  const text = String(state ?? '').trim();
  if (!text) return 'warn';
  if (SKY_STATES.has(text)) return 'sky';
  if (WARN_STATES.has(text)) return 'warn';
  if (OK_STATES.has(text)) return 'ok';
  if (SKY_PATTERN.test(text)) return 'sky';
  if (WARN_PATTERN.test(text)) return 'warn';
  if (OK_PATTERN.test(text)) return 'ok';
  return 'warn';
}

/** @type {Record<string, (state: string, tone: 'ok' | 'warn' | 'sky') => string>} */
const FALLBACK_BY_ID = {
  'edit-routing': (state, tone) => {
    if (state === '无需核对' || tone === 'sky') return '单日站点较少，无需核对站间路线。';
    if (tone === 'ok') return '站间路线距离与耗时已查过。';
    if (state === '部分待复核') return '部分站间路线还没查过，出发前建议看一眼地图导航。';
    return '站间路线距离还没查过，出发前建议用地图确认耗时。';
  },
  'edit-tempo': (state, tone) => {
    if (tone === 'ok') return '单日站点数量与停留时长安排在合理范围内。';
    if (state === '时间冲突') return '站点时间段有重叠或倒挂，建议调整先后顺序或出发时间。';
    return '当天停留和赶路加起来偏紧，建议删减一站或放宽时间。';
  },
  'edit-detour': (_state, tone) => {
    if (tone === 'sky') return '站点较少或缺少精确坐标，暂不判断绕路情况。';
    if (tone === 'ok') return '按当前顺序走比较顺路，没有明显折返。';
    return '前后站点可能有折返绕路，建议对照地图看一眼顺序。';
  },
  'edit-time-of-day': (_state, tone) => {
    if (tone === 'ok') return '各站到访时段与常见游览时间匹配。';
    return '部分站点到访时段可能不太合适，建议留意早晚或用餐时间。';
  },
  'edit-transport-estimate': (_state, tone) => {
    if (tone === 'sky') return '无需额外估算站间转场耗时。';
    if (tone === 'ok') return '站间转场耗时已按所选出行方式估算。';
    return '站间转场耗时为粗略估算，出发前请以实时导航为准。';
  },
  'edit-hours': (state, tone) => {
    if (tone === 'ok') return '到访时间与已知开放时段没有明显冲突。';
    if (state === '闭馆冲突') return '到访时间可能撞上休息日或打烊时段，出发前请核对营业时间。';
    return '部分地点的营业时间和预约要求尚未核对，出发前请确认。';
  },
  'edit-geo': (_state, tone) => {
    if (tone === 'ok') return '各站地图定位已查过，可直接发起导航。';
    return '部分站点还没有精确地图定位，出发前请在地图里确认位置。';
  },
  'source-trust': (state, tone) => {
    if (tone === 'ok') return '参考资料信息较完整，具体营业和票务仍建议出发前确认。';
    if (state === '低可信') return '参考资料线索较少或可信度偏低，出发前请逐项核对地点与时间。';
    return '参考资料仅辅助整理路线，出发前请核对关键信息。';
  },
  'day-count-compressed': () => '原始攻略站点较少，已按合适节奏合并压缩天数。'
};

/**
 * Returns `item.detail` when present; otherwise provides calm generic Chinese copy
 * for stripped public/copied validation items.
 * @param {{ id?: string, label?: string, state?: string, detail?: string } | null | undefined} item
 * @returns {string}
 */
export function validationFallbackDetail(item) {
  const existing = String(item?.detail ?? '').trim();
  if (existing) return existing;
  const state = String(item?.state ?? '').trim();
  if (state === '待确认') return '这项状态待确认，出发前请自行核对。';
  const tone = validationStateTone(state);
  const id = String(item?.id ?? '').trim();
  const builder = FALLBACK_BY_ID[id];
  if (builder) return builder(state, tone);
  if (tone === 'ok') return '这项检查已通过，整体安排可照常参考。';
  if (tone === 'sky') return '这项为补充说明，可按实际行程灵活调整。';
  return '这项内容还需留意，出发前请自行核对。';
}

const TONE_RANK = { warn: 0, ok: 1, sky: 2 };

/**
 * Sorts validation items so actionable warnings ('warn') come first, followed by
 * passed checks ('ok') and supplementary notes ('sky'), preserving original order within each tier.
 * @param {any[]} [validations]
 */
export function sortValidationsByPriority(validations) {
  if (!Array.isArray(validations)) return [];
  return validations
    .map((item, idx) => ({ item, idx, rank: TONE_RANK[validationStateTone(item?.state)] ?? 0 }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .map(({ item }) => item);
}

/**
 * Counts validation items by semantic tone ('warn' | 'ok' | 'sky').
 * @param {any[]} [validations]
 */
export function summarizeValidationCounts(validations) {
  let warnCount = 0;
  let okCount = 0;
  let skyCount = 0;
  for (const item of Array.isArray(validations) ? validations : []) {
    const tone = validationStateTone(item?.state);
    if (tone === 'ok') okCount += 1;
    else if (tone === 'sky') skyCount += 1;
    else warnCount += 1;
  }
  return { warnCount, okCount, skyCount };
}

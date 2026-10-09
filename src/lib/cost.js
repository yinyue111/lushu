// Structured stop cost. Shared by the server (generation, storage, budget
// checks) and the UI (display). New routebooks get `costInfo` straight from the
// model's structured output; older routebooks only have a free-text `cost`
// string, which parseCostText converts with explicit, tested rules.
//
// costInfo = {
//   amount: number|null,       // single known amount (CNY)
//   min: number|null, max: number|null,   // range bounds (equal to amount when exact)
//   currency: 'CNY',
//   unit: 'ticket'|'meal'|'transport'|'experience'|'other'|null,   // what is paid for
//   per: 'person'|'group'|'item'|null,   // price basis
//   free: boolean, reservationRequired: boolean,
//   note: string,
//   items: [{ label, min, max }],    // components when several prices are added up
//   source: 'model'|'legacy-text'|'user', known: boolean
// }

export const COST_UNITS = Object.freeze({ ticket: '门票', meal: '餐饮', transport: '交通', experience: '体验', other: '其他' });
export const COST_PER = Object.freeze({ person: '每人', group: '每组', item: '每份' });

const round = (value) => Math.round(Number(value) * 100) / 100;
const finite = (value) => value != null && value !== '' && Number.isFinite(Number(value));

function emptyCost(source, note = '') {
  return {
    amount: null,
    min: null,
    max: null,
    currency: 'CNY',
    unit: null,
    per: null,
    free: false,
    reservationRequired: false,
    note,
    items: [],
    source,
    known: false
  };
}

const DATE_PATTERN = /\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g;
const CLOCK_PATTERN = /\d{1,2}\s*[:：]\s*\d{2}/g;
// Numbers that measure something other than money.
const NON_MONEY_PATTERN =
  /(\d+(?:\.\d+)?)\s*(?:个?小时|分钟|分(?!钱)|h(?![a-z])|min|天|晚|夜|人(?!民币)|位|岁|号|点|km|公里|千米|米|m(?![a-z])|%|折|楼|层|站|路|元起?\/?(?=\s*起)|\s*-\s*\d+\s*岁)/gi;
const MONEY_MARKER_AFTER = '(?:元|块|rmb|cny|人民币)';
const LABEL_BEFORE =
  '(?:门票|票价|成人票|全票|半票|学生票|票|人均|均价|消费|约|大概|预计|费用|价格|价钱|车费|船票|索道|缆车|茶|餐|饭|午餐|晚餐|早餐|咖啡|小吃)';
const CONNECTOR_PATTERN = /[+＋]|加上?|另加|另外|外加|再加|以及|和(?=\s*[\u4e00-\u9fa5]{0,6}\s*\d)/;

function detectPer(text) {
  if (/人均|每人|每位|\/\s*人|一人|单人|per\s*person/i.test(text)) return 'person';
  if (/每桌|一桌|整车|包车|包船|每组|每间|每船|一船|整船|每车/.test(text)) return 'group';
  if (/每份|一份|每杯|一杯|每个|\/\s*份|\/\s*杯|一壶|每壶/.test(text)) return 'item';
  return null;
}

function detectUnit(text) {
  if (/门票|票价|成人票|学生票|入园|入场|景区/.test(text)) return 'ticket';
  if (/餐|饭|吃|茶|咖啡|小吃|人均消费|酒/.test(text)) return 'meal';
  if (/车|船|地铁|公交|打车|索道|缆车|交通/.test(text)) return 'transport';
  if (/体验|门票外|手作|演出|表演|租/.test(text)) return 'experience';
  return null;
}

/**
 * Parse a legacy free-text cost. Rules:
 * - dates, clock times and durations/counts are removed before looking for money;
 * - a number counts as money if it carries ¥/元/块, follows a price label
 *   (门票、人均、茶…), or is the only number left;
 * - several prices joined by +/加/另 are added up, item by item;
 * - a range "80-120" keeps both bounds; 免费 with no other price is 0.
 * @param {unknown} value
 */
export function parseCostText(value) {
  const raw = String(value ?? '')
    .normalize('NFKC')
    .trim();
  if (!raw) return emptyCost('legacy-text');
  const reservationRequired = /预约|预订|预定|提前订|实名/.test(raw);
  const per = detectPer(raw);
  const unit = detectUnit(raw);
  if (/^(?:待估算|待确认|未知|不详|面议|价格待定|暂无|无数据|n\/a|na|none|null|-)$/i.test(raw)) {
    return { ...emptyCost('legacy-text', ''), reservationRequired };
  }
  let text = raw
    .replace(DATE_PATTERN, ' ')
    .replace(CLOCK_PATTERN, ' ')
    .replace(/[,，](?=\d{3}(?:\D|$))/g, '');
  text = text.replace(NON_MONEY_PATTERN, (match) => (/元|块/.test(match) ? match : ' '));

  const number = '(\\d+(?:\\.\\d+)?)';
  const tokenPattern = new RegExp(
    `(?:([\\u4e00-\\u9fa5]{1,6})\\s*)?(?:[¥￥]\\s*)?${number}(?:\\s*(?:-|–|—|~|～|至|到)\\s*(?:[¥￥]\\s*)?${number})?\\s*(${MONEY_MARKER_AFTER})?`,
    'gi'
  );
  const tokens = [];
  let match;
  while ((match = tokenPattern.exec(text)) !== null) {
    const [whole, label = '', left, right, markerAfter] = match;
    const markerBefore = /[¥￥]/.test(whole);
    const labelled = new RegExp(`${LABEL_BEFORE}$`).test(label) || new RegExp(`^${LABEL_BEFORE}`).test(label);
    const min = Number(left);
    const max = right != null ? Number(right) : min;
    tokens.push({
      label: label.replace(/(?:约|大概|预计)$/, ''),
      min: Math.min(min, max),
      max: Math.max(min, max),
      money: Boolean(markerAfter || markerBefore || labelled),
      index: match.index
    });
  }
  const moneyTokens = tokens.filter((token) => token.money);
  const candidates = moneyTokens.length ? moneyTokens : tokens.length === 1 ? tokens : [];
  const mentionsFree = /免费|免票|不收费|无需门票|不要钱/.test(raw);

  if (!candidates.length) {
    if (mentionsFree) {
      return { ...emptyCost('legacy-text'), amount: 0, min: 0, max: 0, free: true, known: true, reservationRequired, per, unit, note: noteFrom(raw) };
    }
    return { ...emptyCost('legacy-text', noteFrom(raw)), reservationRequired, per, unit };
  }
  const additive = candidates.length > 1 && CONNECTOR_PATTERN.test(text);
  const used = additive ? candidates : [candidates[0]];
  const min = round(used.reduce((sum, token) => sum + token.min, 0));
  const max = round(used.reduce((sum, token) => sum + token.max, 0));
  return {
    amount: min === max ? min : null,
    min,
    max,
    currency: 'CNY',
    unit: additive ? 'other' : unit,
    per,
    free: min === 0 && max === 0,
    reservationRequired,
    note: candidates.length > 1 && !additive ? `原文含多个价格，按第一个：${noteFrom(raw)}` : noteFrom(raw),
    items: additive ? used.map((token) => ({ label: token.label || '费用', min: token.min, max: token.max })) : [],
    source: 'legacy-text',
    known: true
  };
}

function noteFrom(raw) {
  return raw.slice(0, 60);
}

/**
 * Validates a structured cost (from the model or a client) without trusting
 * its arithmetic: bounds are re-derived and negative/NaN values dropped.
 * Returns null when the input is not an object.
 * @param {any} input
 * @param {'model'|'user'|'legacy-text'} [source]
 */
export function normalizeCostInfo(input, source = 'model') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const free = input.free === true;
  const amount = finite(input.amount) && Number(input.amount) >= 0 ? round(input.amount) : null;
  let min = finite(input.min) && Number(input.min) >= 0 ? round(input.min) : amount;
  let max = finite(input.max) && Number(input.max) >= 0 ? round(input.max) : amount;
  if (min == null && max != null) min = max;
  if (max == null && min != null) max = min;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  if (free) {
    min = 0;
    max = 0;
  }
  const items = (Array.isArray(input.items) ? input.items : [])
    .slice(0, 6)
    .map((item) => {
      const itemMin = finite(item?.min ?? item?.amount) ? round(item.min ?? item.amount) : null;
      const itemMax = finite(item?.max ?? item?.amount) ? round(item.max ?? item.amount) : itemMin;
      return { label: String(item?.label ?? '').slice(0, 16) || '费用', min: itemMin, max: itemMax };
    })
    .filter((item) => item.min != null && item.min >= 0);
  const known = free || (min != null && max != null);
  return {
    amount: known && min === max ? min : null,
    min: known ? min : null,
    max: known ? max : null,
    currency: 'CNY',
    unit: Object.hasOwn(COST_UNITS, input.unit) ? input.unit : null,
    per: Object.hasOwn(COST_PER, input.per) ? input.per : null,
    free: known && min === 0 && max === 0,
    reservationRequired: input.reservationRequired === true,
    note: String(input.note ?? '').slice(0, 60),
    items,
    source: ['model', 'user', 'legacy-text'].includes(input.source) ? input.source : source,
    known
  };
}

/**
 * costInfo for a stop: the structured value when it still describes the stop's
 * cost text (`text` snapshot matches), otherwise the legacy text parsed again,
 * so an edited cost string is never shadowed by a stale structured value.
 */
export function stopCostInfo(stop) {
  const structured = normalizeCostInfo(stop?.costInfo, stop?.costInfo?.source ?? 'model');
  const costText = String(stop?.cost ?? '').trim();
  if (structured && (!costText || String(stop?.costInfo?.text ?? '') === costText)) return { ...structured, text: costText };
  return { ...parseCostText(costText), text: costText };
}

/** Short display text, e.g. "门票 约 75 元/人"、"免费（需预约）"、"80–120 元"、"费用待补充". */
export function formatCostInfo(info) {
  if (!info?.known) return info?.reservationRequired ? '费用待补充（需预约）' : '费用待补充';
  const reservation = info.reservationRequired ? '（需预约）' : '';
  if (info.free) return `免费${reservation}`;
  const amount = info.min === info.max ? `${info.min} 元` : `${info.min}–${info.max} 元`;
  const per = info.per ? `/${{ person: '人', group: '组', item: '份' }[info.per]}` : '';
  return `${amount}${per}${reservation}`;
}

/** Sum of stop costs, keeping unknowns separate (never treated as 0). */
export function sumStopCosts(stops = []) {
  const rows = (Array.isArray(stops) ? stops : []).map(stopCostInfo);
  const known = rows.filter((row) => row.known);
  return {
    knownCount: known.length,
    unknownCount: rows.length - known.length,
    allKnown: rows.length === known.length,
    min: known.length ? round(known.reduce((sum, row) => sum + row.min, 0)) : null,
    max: known.length ? round(known.reduce((sum, row) => sum + row.max, 0)) : null,
    estimate: known.length ? round(known.reduce((sum, row) => sum + (row.min + row.max) / 2, 0)) : null,
    reservationCount: rows.filter((row) => row.reservationRequired).length
  };
}

// Anti-fabrication guard. The model may only state specific facts (store branches, street addresses,
// prices / ticket prices, opening hours, phone numbers, event dates) that appear in the user's source
// (guide text, imported sources, constraints) or in reviewed POI data. Everything else is rewritten to
// 「待确认」 (or the branch qualifier is dropped from a stop name) and logged as a guard event, so no
// unsupported claim is ever kept silently. Itinerary times (stop.time) and stay durations are not claims.

const PENDING = '待确认';
const PENDING_LABEL = { address: '地址待确认', hours: '营业时间待确认', phone: '电话待确认', date: '日期待确认', price: '价格待确认' };

/** "分店不明" / "门店待确认" talk about uncertainty; they are not branch claims. */
const HEDGE_AROUND =
  /不明|未指定|未指明|未说明|未写|未注明|未明确|无具体|没有|没写|不清楚|就近|任一|待确认|需确认|请确认|自行确认|多家|多分店|哪一家|哪家|核实|不确定/;

/** @type {{ kind: string, re: RegExp }[]} Order matters: longer / more specific patterns first. */
const CLAIM_PATTERNS = [
  { kind: 'phone', re: /(?:电话|热线|Tel)?[:：]?\s*(?:400-?\d{3}-?\d{4}|0\d{2,3}-\d{7,8}|0\d{9,11}|1[3-9]\d{9})/g },
  { kind: 'address', re: /[\u4e00-\u9fa5]{1,8}(?:路|街|巷|道|弄|胡同)\s*\d+(?:-\d+)?\s*号(?:院|楼)?/g },
  { kind: 'address', re: /\d+(?:-\d+)?\s*号(?:院|楼)/g },
  {
    kind: 'hours',
    re: /(?:营业|开放|开门|闭馆|关门|营运)(?:时间)?[^，。；;、\n]{0,6}?\d{1,2}[:：]\d{2}(?:\s*[-–—~至到]\s*(?:次日)?\d{1,2}[:：]\d{2})?/g
  },
  { kind: 'price', re: /(?:¥|￥)\s*\d+(?:\.\d+)?(?:\s*[-–~至]\s*\d+(?:\.\d+)?)?(?:\s*元)?(?:\s*\/\s*(?:人|位|张|份))?/g },
  { kind: 'price', re: /\d+(?:\.\d+)?(?:\s*[-–~至到]\s*\d+(?:\.\d+)?)?\s*(?:元|块钱|块)(?:\s*\/\s*(?:人|位|张|份))?/g },
  { kind: 'date', re: /(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}\s*年\s*\d{1,2}\s*月/g },
  { kind: 'branch', re: /[（(][^（）()]{0,16}店[^（）()]{0,10}[）)]/g },
  { kind: 'branch', re: /(?:(?![号路街巷])[\u4e00-\u9fa5]){0,6}?(?:总店|(?<!部)分店|旗舰店)/g }
];

const normalize = (value) =>
  String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[：]/g, ':')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[￥]/g, '¥')
    .replace(/[–—~至到]/g, '-')
    .toLowerCase();

/** Words that make a "XX店" parenthetical a branch claim rather than a harmless note. */
const BRANCH_HINT = /店/;

/** The clause (between Chinese/ASCII sentence or comma breaks) that contains [start, end). */
function clauseAround(text, start, end) {
  const breaks = /[，,。；;！!？?\n]/;
  let a = start;
  while (a > 0 && !breaks.test(text[a - 1])) a -= 1;
  let b = end;
  while (b < text.length && !breaks.test(text[b])) b += 1;
  return text.slice(a, b);
}

/**
 * Specific claims in a text.
 * @param {string} text
 * @returns {{ kind: string, text: string, index: number }[]}
 */
export function extractClaims(text) {
  const source = String(text ?? '');
  const claims = [];
  const taken = [];
  for (const { kind, re } of CLAIM_PATTERNS) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (kind === 'branch' && !BRANCH_HINT.test(match[0])) continue;
      if (kind === 'branch' && HEDGE_AROUND.test(clauseAround(source, start, end))) continue;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      claims.push({ kind, text: match[0].trim(), index: start });
    }
  }
  return claims.sort((a, b) => a.index - b.index);
}

/** The core of a claim that must appear in the evidence (numbers for prices/hours, the text otherwise). */
function claimKeys(claim) {
  const value = normalize(claim.text);
  if (claim.kind === 'price') return [value.replace(/[¥元块钱/人位张份]/g, '')].filter(Boolean);
  if (claim.kind === 'hours') return (value.match(/\d{1,2}:\d{2}/g) ?? []).map((time) => time.replace(/^0/, ''));
  if (claim.kind === 'phone') return [value.replace(/^(?:电话|热线|tel)?:?/, '').replace(/-/g, '')];
  if (claim.kind === 'branch') return [value.replace(/[()]/g, '')];
  return [value];
}

/**
 * @param {{ kind: string, text: string }} claim
 * @param {string} evidence normalized evidence text
 */
export function isSupported(claim, evidence) {
  const keys = claimKeys(claim);
  if (!keys.length) return true;
  if (claim.kind === 'price') {
    // A bare number is not enough (coordinates and dates are full of digits): it must be a price there too.
    return keys.every((key) => evidence.includes(`¥${key}`) || evidence.includes(`${key}元`) || evidence.includes(`${key}块`));
  }
  if (claim.kind === 'hours') {
    const hours = evidence.replace(/(^|\D)0(\d:\d\d)/g, '$1$2');
    return keys.every((key) => hours.includes(key));
  }
  if (claim.kind === 'phone') {
    const digits = evidence.replace(/-/g, '');
    return keys.every((key) => digits.includes(key));
  }
  return keys.every((key) => evidence.includes(key));
}

/** All text the model was allowed to rely on. */
export function buildEvidence({ guide = '', importedSources = [], constraints = {}, poiCandidates = [], city = '' } = {}) {
  const imported = (Array.isArray(importedSources) ? importedSources : [])
    .map((source) => [source?.title, source?.text, source?.excerpt, source?.content, source?.summary].filter(Boolean).join(' '))
    .join(' ');
  return normalize([guide, imported, JSON.stringify(constraints ?? {}), (poiCandidates ?? []).join(' '), city].join(' '));
}

/**
 * Rewrites unsupported claims in one text field.
 * @param {string} text
 * @param {string} evidence
 * @param {{ field: string, stopName?: boolean, events: any[] }} context
 */
export function guardText(text, evidence, { field, stopName = false, events }) {
  if (typeof text !== 'string' || !text) return text;
  const claims = extractClaims(text).filter((claim) => !isSupported(claim, evidence));
  if (!claims.length) return text;
  let out = '';
  let cursor = 0;
  for (const claim of claims) {
    const start = claim.index;
    if (start < cursor) continue;
    out += text.slice(cursor, start);
    const isParen = /^[（(].*[）)]$/.test(claim.text);
    let replacement;
    if (claim.kind === 'branch') replacement = stopName || isParen ? '' : claim.text.replace(/(?:总店|分店|旗舰店)$/, '门店（待确认）');
    else replacement = isParen ? `（${PENDING_LABEL[claim.kind] ?? PENDING}）` : (PENDING_LABEL[claim.kind] ?? PENDING);
    out += replacement;
    cursor = start + claim.text.length;
    events.push({ field, kind: claim.kind, claim: claim.text, action: replacement ? 'rewritten' : 'removed' });
  }
  out += text.slice(cursor);
  // Tidy: no doubled markers, no empty brackets, no leading separators left behind.
  return out
    .replace(/((?:地址|营业时间|电话|日期|价格)?待确认)(?:[，、\s]*\1)+/g, '$1')
    .replace(/(?:约|大约|大概)\s*((?:价格)?待确认)/g, '$1')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Applies the guard to a normalized routebook.
 * @param {any} routebook
 * @param {Parameters<typeof buildEvidence>[0]} source
 * @returns {{ routebook: any, events: any[] }}
 */
export function guardRoutebookFacts(routebook, source) {
  const evidence = buildEvidence(source);
  const events = [];
  const guard = (value, field, options = {}) => guardText(value, evidence, { field, events, ...options });
  const stops = (routebook.stops ?? []).map((stop, index) => {
    const before = events.length;
    const name = guard(stop.name, `stops[${index}].name`, { stopName: true }) || stop.name;
    const cost = guard(stop.cost, `stops[${index}].cost`);
    const priceRemoved = events.slice(before).some((event) => event.kind === 'price' && event.field.endsWith('.cost'));
    const next = {
      ...stop,
      name,
      ...(stop.provenance && typeof stop.provenance === 'object' && stop.provenance.name
        ? {
            provenance: {
              ...stop.provenance,
              name: guardText(stop.provenance.name, evidence, { field: `stops[${index}].provenance.name`, events: [], stopName: true }) || stop.provenance.name
            }
          }
        : {}),
      verify: guard(stop.verify, `stops[${index}].verify`),
      risk: guard(stop.risk, `stops[${index}].risk`),
      cost: priceRemoved ? '价格待确认' : cost
    };
    if (priceRemoved && stop.costInfo && typeof stop.costInfo === 'object') {
      next.costInfo = { ...stop.costInfo, amount: null, min: null, max: null, known: false, text: '价格待确认' };
    } else if (stop.costInfo?.text) {
      next.costInfo = { ...stop.costInfo, text: guard(stop.costInfo.text, `stops[${index}].costInfo.text`) };
    }
    // v3: 记下价格的依据。攻略里写了的（数字已经过守卫，「免费」要在攻略里出现）算 guide；
    // 其余是模型凭记忆写的（如「免费」），要交给核对核对，没核对前界面显示「价格待确认」。
    if (!priceRemoved && next.costInfo && typeof next.costInfo === 'object') {
      const costText = String(next.cost ?? '');
      const freeClaim = /免费/.test(costText) || next.costInfo.free === true;
      const basis = freeClaim ? (evidence.includes('免费') ? 'guide' : 'model') : /\d/.test(costText) ? 'guide' : next.costInfo.basis;
      if (basis) next.costInfo = { ...next.costInfo, basis };
    }
    if (stop.costInfo?.note) next.costInfo = { ...next.costInfo, note: guard(stop.costInfo.note, `stops[${index}].costInfo.note`) };
    return next;
  });
  const aiNotes = (routebook.aiNotes ?? []).map((note, index) =>
    note && typeof note === 'object'
      ? { ...note, label: guard(note.label, `aiNotes[${index}].label`), detail: guard(note.detail, `aiNotes[${index}].detail`) }
      : note
  );
  const guarded = {
    ...routebook,
    title: guard(routebook.title, 'title'),
    summary: guard(routebook.summary, 'summary'),
    stops,
    aiNotes
  };
  if (events.length) {
    guarded.aiNotes = [
      ...guarded.aiNotes,
      {
        label: '具体信息待确认',
        detail: `攻略里没有的 ${events.length} 处具体信息（门店、地址、价格、营业时间等）已改成“待确认”，出发前请以现场和官方信息为准。`
      }
    ];
  }
  return { routebook: guarded, events };
}

/** Counts per kind, for logs. */
export function summarizeGuardEvents(events) {
  const byKind = {};
  for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
  return { total: events.length, byKind };
}

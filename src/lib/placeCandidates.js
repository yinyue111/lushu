// Candidate places from the user's free text (F04). Rule-based and explainable:
// every candidate carries the rule that produced it and a confidence derived
// from that rule (not a fixed 90). Candidates are never pre-selected, and
// text-derived candidates are recomputed from the full text on every change,
// so deleting text removes its candidates and typing does not pile up prefixes.

/** Rule → confidence and the reason shown to the user. */
export const CANDIDATE_RULES = Object.freeze({
  dictionary: { confidence: 85, reason: '和已收录地点同名' },
  suffix: { confidence: 60, reason: '名称像地点（以寺、湖、路等结尾）' },
  listed: { confidence: 40, reason: '列表里的短词，可能是地点，请确认' }
});

const PLACE_SUFFIX =
  /(?:路|街|巷|弄|寺|庙|观|宫|园|馆|湖|山|峰|塔|桥|镇|村|坞|埠|堤|岛|洞|泉|溪|潭|古城|景区|公园|广场|商场|市场|码头|茶园|博物馆|美术馆|夜市|书店|咖啡馆|老街|故居|遗址|大厦|中心|车站|东站|西站|南站|北站)$/;
// Leading intent/verb words stripped before judging a clause.
const LEADING_INTENT =
  /^(?:我|我们|他们|还|也|再|就|先|然后|最后|顺便|一定要|必须|必|想要|想|希望|打算|准备|计划|去|逛逛|逛|游览|游|看看|看|到|打卡|推荐|可以|和|还有|以及|喝|吃|拍)+/;
// Clauses that state a preference, a constraint or an activity, not a place.
const PREFERENCE_CLAUSE =
  /^(?:不想|不要|不去|别|避开|避免|少|尽量|最好|不喜欢|喜欢|希望|怕|不能|不用|不需要|带|跟|和朋友|一个人)|走路|太多|太累|太远|人多|排队|预算|小时|分钟|天|晚上|早上|上午|下午|中午|时间|休息|拍照|好吃|好看|好玩|轻松|松弛|适合|亲子|老人|孩子/;
const STOP_WORDS =
  /^(?:这个|那个|这里|那里|今天|明天|周末|我们|他们|攻略|路线|推荐|打卡|地方|景点|美食|东西|一下|一些|很多|附近|周边|市区|城市|杭州|上海|苏州|北京|咖啡|喝茶|茶|小吃|夜景|日落|日出|拍照|照片|晚饭|午饭|早饭|吃饭|特产|散步|骑行|坐船|划船)$/;
const AVOID_INTENT = /^(?:不想去|不要去|别去|避开|不去)/;

/** Same normalization as the stored place keys (NFKC, no spaces/punctuation, lowercase). */
export function normalizeCandidateKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s·•，,。.、“”‘’'"()（）[\]【】「」_\-—~!！?？:：;；/|]+/g, '')
    .toLowerCase();
}

function cleanName(value) {
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(/[「」“”"'【】[\]()（）]/g, '')
    .trim();
  if (text.length < 2 || text.length > 18) return '';
  if (STOP_WORDS.test(text)) return '';
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(text)) return '';
  return text;
}

/**
 * @param {string} text
 * @param {{ knownPlaces?: string[] }} [options] names/aliases from the reviewed POI catalog for the city
 * @returns {{ name: string, rule: keyof typeof CANDIDATE_RULES, confidence: number, reason: string, intent: 'visit' | 'avoid' }[]}
 */
export function extractPlaceCandidates(text, { knownPlaces = [] } = {}) {
  const value = String(text ?? '').replace(/https?:\/\/\S+/gi, ' ');
  /** @type {Map<string, string>} */
  const known = new Map();
  for (const name of knownPlaces) {
    const key = normalizeCandidateKey(name);
    if (key.length >= 2) known.set(key, name);
  }
  const found = new Map();
  const add = (name, rule, intent) => {
    const cleaned = cleanName(name);
    const key = normalizeCandidateKey(cleaned);
    if (!cleaned || !key) return;
    const existing = found.get(key);
    if (existing && CANDIDATE_RULES[existing.rule].confidence >= CANDIDATE_RULES[rule].confidence) return;
    found.set(key, { name: cleaned, rule, confidence: CANDIDATE_RULES[rule].confidence, reason: CANDIDATE_RULES[rule].reason, intent });
  };

  // 1) Dictionary hits anywhere in the text (reviewed catalog names/aliases).
  const normalizedText = normalizeCandidateKey(value);
  for (const [key, name] of known) {
    if (normalizedText.includes(key)) add(name, 'dictionary', 'visit');
  }

  // 2) Clause by clause: strip intent words, skip preferences, then judge the rest.
  const clauses = value.split(/[，,。.；;、\n\r!！?？]+|(?:还有|以及|然后|和|跟|再去|再到|顺便|之后|喝|吃|拍)/);
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause) continue;
    const intent = AVOID_INTENT.test(clause) ? 'avoid' : 'visit';
    const stripped = clause.replace(AVOID_INTENT, '').replace(LEADING_INTENT, '').trim();
    if (!stripped || (intent === 'visit' && PREFERENCE_CLAUSE.test(clause))) continue;
    const key = normalizeCandidateKey(stripped);
    if (known.has(key)) {
      add(known.get(key), 'dictionary', intent);
      continue;
    }
    if (PREFERENCE_CLAUSE.test(stripped)) continue;
    if (PLACE_SUFFIX.test(stripped) && stripped.length <= 12) {
      add(stripped, 'suffix', intent);
      continue;
    }
    // A short bare word in a list ("西湖、法喜寺、龙井") is probably a place name.
    if (/^[\u4e00-\u9fa5]{2,6}$/.test(stripped)) add(stripped, 'listed', intent);
  }
  // Several aliases of one catalog place ("柳浪闻莺" inside "柳浪闻莺公园"): keep the longest.
  const values = [...found.values()];
  return values
    .filter(
      (item) =>
        item.rule !== 'dictionary' ||
        !values.some(
          (other) =>
            other !== item &&
            other.rule === 'dictionary' &&
            normalizeCandidateKey(other.name).includes(normalizeCandidateKey(item.name)) &&
            other.name.length > item.name.length
        )
    )
    .slice(0, 18);
}

/**
 * Re-derives the text candidates while keeping the user's decisions.
 * Candidates from other origins (imported sources, OCR, manual) are untouched;
 * a text candidate disappears when its text is removed.
 * @param {any[]} previous current candidate list
 * @param {ReturnType<typeof extractPlaceCandidates>} extracted
 * @param {{ max?: number }} [options]
 */
export function reconcileTextCandidates(previous, extracted, { max = 24 } = {}) {
  const prev = Array.isArray(previous) ? previous : [];
  const byKey = new Map(prev.map((place) => [normalizeCandidateKey(place.name), place]));
  const textKeys = new Set(extracted.map((place) => normalizeCandidateKey(place.name)));
  const kept = prev.filter((place) => place.origin !== 'guide-text' || textKeys.has(normalizeCandidateKey(place.name)));
  const keptKeys = new Set(kept.map((place) => normalizeCandidateKey(place.name)));
  const next = kept.map((place) => {
    const fresh = extracted.find((item) => normalizeCandidateKey(item.name) === normalizeCandidateKey(place.name));
    return fresh && place.origin === 'guide-text' ? { ...place, confidence: fresh.confidence, reason: fresh.reason, intent: fresh.intent } : place;
  });
  for (const place of extracted) {
    const key = normalizeCandidateKey(place.name);
    if (keptKeys.has(key) || byKey.has(key)) continue;
    next.push({
      name: place.name,
      source: '你的攻略',
      origin: 'guide-text',
      confidence: place.confidence,
      reason: place.reason,
      intent: place.intent,
      note: place.intent === 'avoid' ? '文字里说想避开' : '',
      included: false,
      decided: false,
      mustGo: false
    });
  }
  return next.slice(0, max);
}

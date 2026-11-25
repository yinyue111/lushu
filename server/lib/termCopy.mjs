// §2.1 & release-v7 §3/§4.4/§7:
// Pure string/validation terminology & enum helpers shared by server and client bundles.
// IMPORTANT: Keep zero imports, zero process.env reads and zero Node built-ins so Vite only bundles the tables.

const LEGACY = [
  ['POI 待验证', '地点待核对'],
  ['待验证', '待核对'],
  ['最近验证', '最近核对'],
  ['未核验', '未核对'],
  ['无需核验', '无需核对'],
  ['资料核验分', '资料核对分'],
  ['道路核验', '道路核对'],
  ['编辑校验', '编辑核对'],
  ['可信校验', '可信核对'],
  ['AI 路线校验', 'AI 路线核对'],
  ['已审核', '已核对'],
  ['核验', '核对'],
  ['校验', '核对']
];

/**
 * §7 Per-validation-id legacy state mapping (4ded5b3..04d2427 stored values).
 * Scoped strictly to each validation id so valid states like 「需复核」 on
 * edit-hours / edit-geo / source-trust are untouched, and legacy values placed
 * on a different id are never mis-mapped. 「已更新」 on edit-routing is intentionally
 * NOT mapped (stays 「已更新」 for owner, becomes 「待确认」 in public views).
 */
export const LEGACY_VALIDATION_STATES = Object.freeze({
  'edit-routing': Object.freeze({
    已核验: '已查过',
    需复核: '还没查'
  }),
  'edit-tempo': Object.freeze({
    待复核: '还没查'
  }),
  'edit-detour': Object.freeze({
    待复核: '还没查'
  }),
  'edit-hours': Object.freeze({
    需填出行日期: '未核对',
    无数据: '未核对'
  })
});

/**
 * §4.2 & §4.4 Public validation whitelist (9 system validation types) and fixed state enums.
 * 「edit-budget」 and 「edit-constraints」 are excluded completely; any state outside
 * the id's enum renders as 「待确认」 in public views.
 */
export const PUBLIC_VALIDATION_STATES = Object.freeze({
  'edit-routing': Object.freeze(['无需核对', '已查过', '还没查']),
  'edit-tempo': Object.freeze(['无需判断', '时间冲突', '偏紧', '还没查', '待补充', '可执行']),
  'edit-detour': Object.freeze(['无需判断', '需重排', '还没查', '可执行']),
  'edit-time-of-day': Object.freeze(['待核对']),
  'edit-transport-estimate': Object.freeze(['待核对']),
  'edit-hours': Object.freeze(['时段冲突', '未核对', '需复核', '闭馆冲突', '部分待复核', '通过']),
  'edit-geo': Object.freeze(['需复核', '通过']),
  'source-trust': Object.freeze(['可参考', '需复核', '低可信']),
  'day-count-compressed': Object.freeze(['已压缩'])
});

export function modernTermCopy(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  for (const [from, to] of LEGACY) out = out.split(from).join(to);
  return out;
}

/**
 * Rewrites a validation state at read time: applies per-id legacy state mapping first,
 * then general terminology normalization.
 * @param {string} id
 * @param {string} state
 */
export function modernValidationState(id, state) {
  if (typeof state !== 'string' || !state) return state;
  const trimmed = state.trim();
  const byId = Object.hasOwn(LEGACY_VALIDATION_STATES, id) ? LEGACY_VALIDATION_STATES[id] : null;
  if (byId && Object.hasOwn(byId, trimmed)) return byId[trimmed];
  return modernTermCopy(trimmed);
}

/**
 * Normalizes validation rows for public views and private draft copies:
 * - keeps ONLY the 9 whitelisted system validation IDs
 * - strips `detail` completely (only `{ id, label, state }`)
 * - maps legacy states & terminology, then clamps to `PUBLIC_VALIDATION_STATES[id]` or `'待确认'`.
 * @param {any[]} [validations]
 */
export function publicValidationRows(validations) {
  if (!Array.isArray(validations)) return [];
  const rows = [];
  for (const item of validations) {
    const id = String(item?.id ?? '')
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 64);
    if (!id || !Object.hasOwn(PUBLIC_VALIDATION_STATES, id)) continue;
    const rawLabel = String(item?.label ?? '')
      .trim()
      .slice(0, 60);
    const rawState = String(item?.state ?? '')
      .trim()
      .slice(0, 40);
    const mappedState = modernValidationState(id, rawState);
    const allowed = PUBLIC_VALIDATION_STATES[id];
    const state = allowed.includes(mappedState) ? mappedState : '待确认';
    rows.push({
      id,
      label: modernTermCopy(rawLabel),
      state
    });
    if (rows.length >= 9) break;
  }
  return rows;
}

function modernOwnerStopCopy(stop) {
  if (!stop || typeof stop !== 'object') return stop;
  return {
    ...stop,
    ...(typeof stop.verify === 'string' ? { verify: modernTermCopy(stop.verify) } : {}),
    ...(typeof stop.risk === 'string' ? { risk: modernTermCopy(stop.risk) } : {}),
    ...(Array.isArray(stop.sourceEvidence)
      ? {
          sourceEvidence: stop.sourceEvidence.map((ev) =>
            ev && typeof ev === 'object' && typeof ev.label === 'string' ? { ...ev, label: modernTermCopy(ev.label) } : ev
          )
        }
      : {}),
    ...(Array.isArray(stop.facts)
      ? {
          facts: stop.facts.map((fact) =>
            fact && typeof fact === 'object'
              ? {
                  ...fact,
                  ...(typeof fact.sourceLabel === 'string' ? { sourceLabel: modernTermCopy(fact.sourceLabel) } : {}),
                  ...(typeof fact.status === 'string' ? { status: modernTermCopy(fact.status) } : {})
                }
              : fact
          )
        }
      : {})
  };
}

/**
 * Output-only terminology & legacy-state rewriter for owner routebook views (§3 & §7).
 * Never mutates the input object or persisted storage rows; keeps owner free-text states intact.
 * @param {any} routebook
 */
export function modernOwnerRoutebookCopy(routebook) {
  if (!routebook || typeof routebook !== 'object') return routebook;
  return {
    ...routebook,
    ...(Array.isArray(routebook.validations)
      ? {
          validations: routebook.validations.map((item) =>
            item && typeof item === 'object'
              ? {
                  ...item,
                  ...(typeof item.label === 'string' ? { label: modernTermCopy(item.label) } : {}),
                  ...(typeof item.state === 'string' ? { state: modernValidationState(String(item.id ?? ''), item.state) } : {}),
                  ...(typeof item.detail === 'string' ? { detail: modernTermCopy(item.detail) } : {})
                }
              : item
          )
        }
      : {}),
    ...(Array.isArray(routebook.metrics)
      ? {
          metrics: routebook.metrics.map((metric) =>
            metric && typeof metric === 'object'
              ? {
                  ...metric,
                  ...(typeof metric.label === 'string' ? { label: modernTermCopy(metric.label) } : {}),
                  ...(typeof metric.value === 'string' ? { value: modernTermCopy(metric.value) } : {})
                }
              : metric
          )
        }
      : {}),
    ...(Array.isArray(routebook.stops) ? { stops: routebook.stops.map(modernOwnerStopCopy) } : {}),
    ...(Array.isArray(routebook.variants)
      ? {
          variants: routebook.variants.map((variant) => (variant && typeof variant === 'object' ? modernOwnerRoutebookCopy(variant) : variant))
        }
      : {}),
    ...(routebook.routingWarning && typeof routebook.routingWarning === 'object' && typeof routebook.routingWarning.message === 'string'
      ? { routingWarning: { ...routebook.routingWarning, message: modernTermCopy(routebook.routingWarning.message) } }
      : {})
  };
}

const GENERIC_CONSTRAINT_WORDS = new Set(['无', '没有', '暂无', '不限', '不设预算', '待确认', '随便', '均可']);
const PUBLIC_PREFERENCE_ECHO_RE =
  /预算|(?:\b|\D)控制在\s*\d+\s*元|(?:全程|每日|每天|日均|人均)\s*\d+\s*元\s*(?:以内|内|左右|上下)|避开项|\d+\s*个避开|(?:按|根据)(?:你|用户)?(?:的)?(?:要求|偏好|必去)|(?:已为你|已按要求)[^。！？!?；;\n]*(?:避开|排除|不去)|必去(?:未找到|清单|项|地点|要求|点位)|必去\s*[:：]/;

function splitConstraintTerms(raw, prefixPattern) {
  return String(raw ?? '')
    .split(/[,，、;；\n/｜|]+/)
    .map((item) => item.replace(prefixPattern, '').trim())
    .filter((item) => item.length >= 2 && !GENERIC_CONSTRAINT_WORDS.has(item));
}

function buildProseRedactionMatchers(context) {
  const constraints = context?.constraints && typeof context.constraints === 'object' ? context.constraints : null;
  const stopNames = Array.isArray(context?.stopNames) ? context.stopNames.map((name) => String(name ?? '').trim()).filter((name) => name.length >= 2) : [];
  const literals = new Set();

  if (constraints) {
    const budget = String(constraints.budget ?? '').trim();
    if (budget.length >= 2 && !GENERIC_CONSTRAINT_WORDS.has(budget)) {
      literals.add(budget);
      for (const match of budget.matchAll(/\d{3,6}/g)) {
        literals.add(`${match[0]} 元`);
        literals.add(`${match[0]}元`);
      }
    }
    for (const term of splitConstraintTerms(constraints.avoid, /^(?:避开|不去|不要|排除|绕开)\s*[:：]?\s*/)) {
      literals.add(term);
    }
    for (const term of splitConstraintTerms(constraints.mustGo, /^(?:必去|想去|指定)\s*[:：]?\s*/)) {
      const onRoute = stopNames.some((stopName) => stopName === term || stopName.includes(term) || term.includes(stopName));
      if (!onRoute) literals.add(term);
    }
  }

  return [...literals];
}

/**
 * Strips sentences/clauses from public-facing prose (`summary`, `stop.verify`, `stop.risk`)
 * that echo private user budget amounts, `必去` constraints or `避开` preferences, while
 * leaving normal scenic descriptions, ticket prices and crowd/peak-hour tips intact.
 * @param {string} value
 * @param {{ constraints?: Record<string, any> | null, stopNames?: string[] }} [context]
 */
export function redactPrivatePreferenceProse(value, context) {
  if (typeof value !== 'string' || !value) return value;
  const literals = buildProseRedactionMatchers(context);
  const kept = [];
  const sentenceRe = /([^。！？!?；;\n]+)([。！？!?；;\n]*)/g;
  for (const match of value.matchAll(sentenceRe)) {
    const body = match[1] ?? '';
    const punct = match[2] ?? '';
    const trimmed = body.trim();
    if (!trimmed) continue;
    const leaked = PUBLIC_PREFERENCE_ECHO_RE.test(trimmed) || literals.some((term) => trimmed.includes(term));
    if (!leaked) kept.push(`${body}${punct}`);
  }
  return kept
    .join('')
    .trim()
    .replace(/[；;]+$/, '。');
}

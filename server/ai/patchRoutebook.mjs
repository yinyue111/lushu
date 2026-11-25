/**
 * L2: regenerate stops for one day, a stop window, or the entire multi-day book (`scope.type === 'all'`).
 * Preserves verified coordinates/provenance of retained stops and applies factGuard on new claims.
 */
import { createHttpError, truncateString, isValidCoordinate, mapWithConcurrency } from '../lib/util.mjs';
import { compactDays } from '../../src/lib/dayRepair.js';
import { shiftSubsequentDayTimes } from '../../src/lib/stopTiming.js';
import { buildApprovedPoiPromptCandidates, loadCodexRuntime, openAiEndpoint, extractTextFromResponse, parseJsonFromText } from './generate.mjs';
import { guardRoutebookFacts } from './factGuard.mjs';
import { appendJsonLine } from '../storage/jsonl.mjs';
import { AI_LOG_PATH, AMAP_GEOCODE_KEY } from '../config/index.mjs';
import { generationModeConfig, runtimeForMode } from '../config/runtimeViews.mjs';
import { geocodePoiWithAmap } from '../geo/amap.mjs';
import { coordinateForName } from '../geo/normalize-coordinate.mjs';
import { fallbackCoordinate } from '../geo/coordinates.mjs';
import { attachServerRouteLegs } from '../routing/service.mjs';

function makeStopId() {
  return `patch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDayTag(rawDay, fallbackDay = 'Day 1') {
  const text = String(rawDay ?? '').trim();
  if (!text) return fallbackDay;
  const numMatch = text.match(/(?:Day\s*|第\s*)(\d+)/i);
  if (numMatch) return `Day ${Math.max(1, Math.min(14, Number(numMatch[1]) || 1))}`;
  const cnMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };
  const cnMatch = text.match(/第\s*([一二三四五六七])\s*天/);
  if (cnMatch && cnMap[cnMatch[1]]) return `Day ${cnMap[cnMatch[1]]}`;
  return fallbackDay;
}

function normalizeStopNameKey(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * @param {Record<string, any>} [constraints]
 * @param {{ isAllScope?: boolean, day?: string, allDays?: string[] }} [opts]
 */
function buildConstraintPromptLines(constraints = {}, { isAllScope = false, day = 'Day 1', allDays = [] } = {}) {
  if (!constraints || typeof constraints !== 'object') return [];
  const lines = [];
  const firstDay = allDays[0] || 'Day 1';
  const lastDay = allDays.at(-1) || firstDay;
  if ((isAllScope || day === firstDay) && (constraints.arrivalTime || constraints.arrivalHub)) {
    lines.push(
      `首日到达约束：${constraints.arrivalTime ? `${constraints.arrivalTime} 到达` : '首日到达'}${constraints.arrivalHub ? `「${constraints.arrivalHub}」` : ''}，首日首站须预留至少 45 分钟出站与交通缓冲，并优先就近起逛。`
    );
  }
  if ((isAllScope || day === lastDay) && (constraints.departureTime || constraints.departureHub)) {
    lines.push(
      `末日返程约束：${constraints.departureTime ? `${constraints.departureTime} 返程` : '末日返程'}${constraints.departureHub ? `（${constraints.departureHub}）` : ''}，末日最后一站须提前至少 75 分钟结束并向返程站顺路靠拢。`
    );
  }
  if (constraints.mealPlan && constraints.mealPlan !== '不排餐饮') {
    lines.push(`餐饮偏好：${constraints.mealPlan}（正餐请安排在 11:30-13:30 或 17:30-19:30，切勿把正餐排到清早或深夜）。`);
  } else if (constraints.mealPlan === '不排餐饮') {
    lines.push('餐饮偏好：不专门排餐饮站（除非用户在本次要求中明确要求加餐厅）。');
  }
  if (constraints.accommodationArea) lines.push(`住宿落脚区域：${truncateString(constraints.accommodationArea, 60)}（每天首末站尽量顺路衔接）。`);
  if (constraints.mustGo) lines.push(`必去保留点：${truncateString(constraints.mustGo, 120)}（除非本次用户明确要求删换，否则不可丢弃）。`);
  if (constraints.avoid) lines.push(`明确避开：${truncateString(constraints.avoid, 120)}（切勿塞回行程）。`);
  if (constraints.crowd) lines.push(`同行人群：${truncateString(constraints.crowd, 40)}。`);
  if (constraints.budget) lines.push(`预算范围：${truncateString(constraints.budget, 60)}。`);
  if (constraints.transport) lines.push(`交通偏好：${truncateString(constraints.transport, 60)}。`);
  return lines;
}

function parseClockMin(clock) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(clock ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? h * 60 + min : null;
}

/**
 * @param {Record<string, any>} routebook
 * @param {{ type: string, day?: string, stopIds?: string[], instruction?: string, mode?: string }} scope
 * @param {{ profileId?: string, signal?: AbortSignal, requestId?: string, modelCaller?: (args: any) => Promise<any> }} [opts]
 */
export async function proposeDayPatch(routebook, scope, opts = {}) {
  const isAllScope = scope.type === 'all';
  const day = scope.day || routebook.days?.[0] || 'Day 1';
  const allStops = Array.isArray(routebook.stops) ? routebook.stops : [];
  const scoped = isAllScope
    ? allStops
    : scope.type === 'window' && Array.isArray(scope.stopIds) && scope.stopIds.length
      ? allStops.filter((stop) => scope.stopIds.map(String).includes(String(stop.id)))
      : allStops.filter((stop) => (stop.day || 'Day 1') === day);
  if (scoped.length < 1) throw createHttpError('没有可调整的站点', 400, 'PATCH_SCOPE_EMPTY');

  const keep = isAllScope ? [] : allStops.filter((stop) => !scoped.some((s) => String(s.id) === String(stop.id)));
  const instruction = truncateString(
    scope.instruction ||
      (isAllScope ? '在保留城市与核心打卡点的前提下，按顺路与舒适节奏优化整本路线' : '在保留城市与行程风格的前提下，优化这一天的顺路程度与节奏'),
    400
  );

  let poiCandidates = [];
  try {
    poiCandidates = buildApprovedPoiPromptCandidates(routebook.city);
  } catch {
    poiCandidates = [];
  }

  const allDaysList = Array.isArray(routebook.days) && routebook.days.length ? routebook.days : ['Day 1'];
  const constraintLines = buildConstraintPromptLines(routebook.constraints, { isAllScope, day, allDays: allDaysList });

  const prompt = isAllScope
    ? [
        '你是可信路书的整本行程微调助手。只输出 JSON，不要 markdown。',
        `城市：${routebook.city}`,
        `范围：整本路书（共 ${routebook.days?.length || 1} 天、${allStops.length} 站）`,
        `用户要求：${instruction}`,
        ...(constraintLines.length ? ['既有硬约束（必须继续遵守）：', ...constraintLines.map((l) => `- ${l}`)] : []),
        '输出格式：{"summary":"一句话说明本次改了什么","stops":[{"day":"Day 1","name":"","time":"HH:MM","stay":"60 分钟","cost":"","area":"","verify":"","risk":""}]}',
        '约束：保留用户未要求删改的站点，允许按要求跨天挪站、增删站点或重排时间；不要编造未给出的票价/电话/精确地址，不确定写「待确认」。总站点数 2–16。',
        '当前全部站点：',
        JSON.stringify(allStops.map((s) => ({ day: s.day || 'Day 1', name: s.name, time: s.time, stay: s.stay, cost: s.cost, area: s.area }))),
        ...(poiCandidates.length ? [`可选已核对地点参考：${poiCandidates.slice(0, 20).join('；')}`] : [])
      ].join('\n')
    : [
        '你是可信路书的局部调整助手。只输出 JSON，不要 markdown。',
        `城市：${routebook.city}`,
        `范围：${day}（共 ${scoped.length} 站）`,
        `要求：${instruction}`,
        ...(constraintLines.length ? ['既有硬约束（必须继续遵守）：', ...constraintLines.map((l) => `- ${l}`)] : []),
        '输出格式：{"summary":"一句话说明改了什么","stops":[{"name":"","time":"HH:MM","stay":"60 分钟","cost":"","area":"","verify":"","risk":""}]}',
        '约束：不要编造未给出的票价/电话/精确地址；不确定写「待确认」。站点数建议 2–6。',
        '当前这一天的站：',
        JSON.stringify(scoped.map((s) => ({ name: s.name, time: s.time, stay: s.stay, cost: s.cost, area: s.area }))),
        '路书里其他天保留不动：',
        JSON.stringify(keep.map((s) => ({ day: s.day, name: s.name }))),
        ...(poiCandidates.length ? [`可选已核对地点参考：${poiCandidates.slice(0, 16).join('；')}`] : [])
      ].join('\n');

  const startedAt = Date.now();
  let parsed;
  if (typeof opts.modelCaller === 'function') {
    parsed = await opts.modelCaller({ prompt, isAllScope, routebook, scope });
  } else {
    const runtime = runtimeForMode(await loadCodexRuntime(), 'fast');
    if (!runtime.ready) throw createHttpError(runtime.readyReason || '模型未就绪', 503, 'MODEL_NOT_READY');
    const modeCfg = generationModeConfig('fast');
    const model = modeCfg.model || runtime.model;
    const endpoint = openAiEndpoint(runtime.baseUrl, runtime.wireApi);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(modeCfg.timeoutMs || 120000, 120000));
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    let raw;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${runtime.apiKey}`
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            {
              role: 'system',
              content: isAllScope
                ? 'You adjust a multi-day Chinese city itinerary according to the user instruction. Reply with JSON only.'
                : 'You adjust one day of a Chinese city itinerary. Reply with JSON only.'
            },
            { role: 'user', content: `${isAllScope ? '整本微调' : '局部调整'}\n${prompt}` }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        // 正文只进服务端日志（截断），不回给客户端。
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        console.warn('[patch] model HTTP', response.status, detail);
        throw createHttpError(`模型调用失败：${response.status}`, 502, 'MODEL_HTTP_ERROR');
      }
      raw = await response.json();
    } finally {
      clearTimeout(timeout);
    }

    try {
      const text = extractTextFromResponse(raw);
      parsed = parseJsonFromText(text);
    } catch {
      throw createHttpError('调整结果无法解析，请重试', 502, 'MODEL_BAD_OUTPUT');
    }
  }

  const modelStops = Array.isArray(parsed?.stops) ? parsed.stops : Array.isArray(parsed) ? parsed : [];
  if (modelStops.length < 1) throw createHttpError('模型没有返回站点', 502, 'MODEL_BAD_OUTPUT');

  const maxStops = isAllScope ? 16 : 8;
  const usedIds = new Set(keep.map((s) => String(s.id)));
  const existingPool = [...scoped, ...allStops];

  let draftStops = modelStops.slice(0, maxStops).map((stop, index) => {
    const cleanName = truncateString(stop.name, 80) || `站点${index + 1}`;
    const nameKey = normalizeStopNameKey(cleanName);
    const matchedExisting = existingPool.find((candidate) => !usedIds.has(String(candidate.id)) && normalizeStopNameKey(candidate.name) === nameKey);
    if (matchedExisting) {
      usedIds.add(String(matchedExisting.id));
    }
    const targetDay = isAllScope ? normalizeDayTag(stop.day, matchedExisting?.day || day) : day;

    if (matchedExisting) {
      const nextCost = truncateString(stop.cost, 40);
      const keepExistingCost = !nextCost || (nextCost === '待确认' && matchedExisting.cost && matchedExisting.cost !== '待确认');
      return {
        ...matchedExisting,
        day: targetDay,
        time: truncateString(stop.time, 16) || matchedExisting.time || `${9 + (index % 8)}:00`,
        name: cleanName,
        stay: truncateString(stop.stay, 40) || matchedExisting.stay || '60 分钟',
        cost: keepExistingCost ? matchedExisting.cost : nextCost,
        area: truncateString(stop.area, 40) || matchedExisting.area || routebook.city,
        verify: truncateString(stop.verify, 200) || matchedExisting.verify || '',
        risk: truncateString(stop.risk, 200) || matchedExisting.risk || ''
      };
    }

    const catalogCoord = coordinateForName(cleanName, routebook.city);
    const approx = fallbackCoordinate(routebook.city, index);
    return {
      id: makeStopId(),
      day: targetDay,
      time: truncateString(stop.time, 16) || `${9 + (index % 8)}:00`,
      name: cleanName,
      stay: truncateString(stop.stay, 40) || '60 分钟',
      cost: truncateString(stop.cost, 40) || '待确认',
      area: truncateString(stop.area, 40) || routebook.city,
      verify: truncateString(stop.verify, 200) || '',
      risk: truncateString(stop.risk, 200) || '',
      provenance: { origin: 'model', name: cleanName, patch: true },
      lat: catalogCoord ? catalogCoord.lat : approx.lat,
      lng: catalogCoord ? catalogCoord.lng : approx.lng,
      geoConfidence: catalogCoord ? catalogCoord.confidence : 40,
      coordinateSystem: 'WGS84',
      coordinateSource: catalogCoord ? catalogCoord.source : 'user-edit',
      coordinatePrecision: catalogCoord ? catalogCoord.precision : 'approximate',
      coordinateRadiusMeters: catalogCoord ? 0 : 1500,
      navigationDisabled: !catalogCoord
    };
  });

  const existingEvidenceText = [routebook.summary || '', ...allStops.map((s) => [s.name, s.cost, s.verify, s.risk].filter(Boolean).join(' '))]
    .filter(Boolean)
    .join('\n');

  const guarded = guardRoutebookFacts(
    { ...routebook, stops: draftStops },
    { guide: existingEvidenceText, importedSources: [], constraints: routebook.constraints || {}, poiCandidates, city: routebook.city }
  );
  draftStops = guarded.routebook.stops;

  if (AMAP_GEOCODE_KEY) {
    draftStops = await mapWithConcurrency(draftStops, 4, async (stop) => {
      if (stop.coordinateSource === 'known-poi' || (!stop.navigationDisabled && isValidCoordinate(Number(stop.lat), Number(stop.lng)))) {
        return stop;
      }
      const hit = await geocodePoiWithAmap(routebook.city, stop.name, opts.signal).catch(() => null);
      if (!hit || !isValidCoordinate(Number(hit.lat), Number(hit.lng))) return stop;
      const { geocodeChoice: _c, ...fields } = hit;
      return { ...stop, ...fields };
    });
  }

  const mergedStops = [...keep, ...draftStops];
  const byDay = new Map();
  for (const stop of mergedStops) {
    const d = stop.day || 'Day 1';
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(stop);
  }
  const baseDayOrder = isAllScope
    ? [...byDay.keys()].sort((a, b) => (Number(a.replace(/\D/g, '')) || 99) - (Number(b.replace(/\D/g, '')) || 99))
    : (routebook.days?.length ? routebook.days : [...byDay.keys()]).filter((d) => byDay.has(d));
  for (const d of byDay.keys()) if (!baseDayOrder.includes(d)) baseDayOrder.push(d);

  // 与前端同一规则：去掉空的天并顺延编号，不补站。
  const compacted = compactDays(
    baseDayOrder.flatMap((d) => byDay.get(d) || []),
    baseDayOrder
  );
  let finalStops = compacted.stops;
  const orderedDays = [...compacted.days];

  // 首日若有到达时间约束且模型生成时间早于到达后 30 分钟，自动顺延首日时间，防止微调后再次撞车次。
  const arrMin = parseClockMin(routebook.constraints?.arrivalTime);
  const firstOrderedDay = orderedDays[0] || 'Day 1';
  if (arrMin != null && (isAllScope || day === firstOrderedDay)) {
    const firstDayStop = finalStops.find((s) => (s.day || 'Day 1') === firstOrderedDay);
    const firstStart = parseClockMin(firstDayStop?.time);
    if (firstDayStop && firstStart != null && firstStart < arrMin + 30) {
      finalStops = shiftSubsequentDayTimes(finalStops, firstOrderedDay, firstDayStop.id, arrMin + 45);
    }
  }

  let routed = { ...routebook, stops: finalStops, days: orderedDays };
  try {
    routed = await attachServerRouteLegs(routed, opts.signal, undefined, { reuseVerifiedLegs: true });
  } catch {
    /* offline routing ok */
  }

  const modelSummary = truncateString(parsed?.summary, 120);
  const defaultSummary = isAllScope
    ? `已调整整本路线（${orderedDays.length} 天 ${finalStops.length} 站）`
    : `已重排 ${day}：${draftStops.map((s) => s.name).join('、')}`;

  const proposal = {
    id: `proposal-${Date.now().toString(36)}`,
    scope: { type: isAllScope ? 'all' : scope.type || 'day', ...(isAllScope ? {} : { day }), stopIds: scoped.map((s) => s.id) },
    instruction,
    createdAt: new Date().toISOString(),
    mode: 'fast',
    stops: finalStops,
    days: orderedDays,
    routeLegs: /** @type {any} */ (routed).routeLegs ?? routebook.routeLegs,
    guard: { events: guarded.events?.length || 0 },
    summary: modelSummary || defaultSummary
  };

  await appendJsonLine(AI_LOG_PATH, {
    kind: 'patch-routebook',
    status: 'ok',
    profileId: opts.profileId || routebook.profileId || '',
    requestId: opts.requestId || '',
    day: isAllScope ? 'all' : day,
    stopCount: draftStops.length,
    durationMs: Date.now() - startedAt,
    createdAt: new Date().toISOString()
  }).catch(() => {});

  return { proposal, routebookPreview: routed };
}

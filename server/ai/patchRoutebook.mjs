/**
 * L2: regenerate stops for one day (or a stop window), preserve the rest.
 * Uses the same OpenAI-compatible endpoint as full generation but a narrow prompt.
 */
import { createHttpError, truncateString } from '../lib/util.mjs';
import { compactDays } from '../../src/lib/dayRepair.js';
import { loadCodexRuntime, openAiEndpoint, extractTextFromResponse, parseJsonFromText } from './generate.mjs';
import { guardRoutebookFacts } from './factGuard.mjs';
import { appendJsonLine } from '../storage/jsonl.mjs';
import { AI_LOG_PATH, GENERATION_MODES } from '../config/index.mjs';
import { geocodePoiWithAmap } from '../geo/amap.mjs';
import { AMAP_GEOCODE_KEY } from '../config/index.mjs';
import { isValidCoordinate, mapWithConcurrency } from '../lib/util.mjs';
import { attachServerRouteLegs } from '../routing/service.mjs';

function makeStopId() {
  return `patch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {Record<string, any>} routebook
 * @param {{ type: 'day'|'window', day?: string, stopIds?: string[], instruction?: string, mode?: string }} scope
 * @param {{ profileId?: string, signal?: AbortSignal, requestId?: string }} [opts]
 */
export async function proposeDayPatch(routebook, scope, opts = {}) {
  const runtime = await loadCodexRuntime();
  if (!runtime.ready) throw createHttpError(runtime.readyReason || '模型未就绪', 503, 'MODEL_NOT_READY');

  const day = scope.day || routebook.days?.[0] || 'Day 1';
  const allStops = Array.isArray(routebook.stops) ? routebook.stops : [];
  const scoped =
    scope.type === 'window' && Array.isArray(scope.stopIds) && scope.stopIds.length
      ? allStops.filter((stop) => scope.stopIds.map(String).includes(String(stop.id)))
      : allStops.filter((stop) => (stop.day || 'Day 1') === day);
  if (scoped.length < 1) throw createHttpError('没有可调整的站点', 400, 'PATCH_SCOPE_EMPTY');

  const keep = allStops.filter((stop) => !scoped.some((s) => String(s.id) === String(stop.id)));
  const instruction = truncateString(scope.instruction || '在保留城市与行程风格的前提下，优化这一天的顺路程度与节奏', 400);
  const prompt = [
    '你是可信路书的局部调整助手。只输出 JSON，不要 markdown。',
    `城市：${routebook.city}`,
    `范围：${day}（共 ${scoped.length} 站）`,
    `要求：${instruction}`,
    '输出格式：{"stops":[{"name":"","time":"HH:MM","stay":"60 分钟","cost":"","area":"","verify":"","risk":""}]}',
    '约束：不要编造未给出的票价/电话/精确地址；不确定写「待确认」。站点数建议 2–6。',
    '当前这一天的站：',
    JSON.stringify(scoped.map((s) => ({ name: s.name, time: s.time, stay: s.stay, cost: s.cost, area: s.area }))),
    '路书里其他天保留不动：',
    JSON.stringify(keep.map((s) => ({ day: s.day, name: s.name })))
  ].join('\n');

  const startedAt = Date.now();
  const modeCfg = GENERATION_MODES.fast;
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
          { role: 'system', content: 'You adjust one day of a Chinese city itinerary. Reply with JSON only.' },
          { role: 'user', content: `局部调整\n${prompt}` }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw createHttpError(`模型调用失败：${response.status}`, 502, 'MODEL_HTTP_ERROR');
    }
    raw = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  let parsed;
  try {
    const text = extractTextFromResponse(raw);
    parsed = parseJsonFromText(text);
  } catch (error) {
    throw createHttpError('局部调整输出无法解析，请重试', 502, 'MODEL_BAD_OUTPUT');
  }

  const modelStops = Array.isArray(parsed?.stops) ? parsed.stops : Array.isArray(parsed) ? parsed : [];
  if (modelStops.length < 1) throw createHttpError('模型没有返回站点', 502, 'MODEL_BAD_OUTPUT');

  let draftStops = modelStops.slice(0, 8).map((stop, index) => ({
    id: scoped[index]?.id || makeStopId(),
    day,
    time: stop.time || `${10 + index}:00`,
    name: truncateString(stop.name, 80) || `站点${index + 1}`,
    stay: truncateString(stop.stay, 40) || '60 分钟',
    cost: truncateString(stop.cost, 40) || '待确认',
    area: truncateString(stop.area, 40) || routebook.city,
    verify: truncateString(stop.verify, 200) || '待确认',
    risk: truncateString(stop.risk, 200) || '待确认',
    provenance: { origin: 'model', name: truncateString(stop.name, 80), patch: true },
    lat: Number(scoped[index]?.lat) || 0,
    lng: Number(scoped[index]?.lng) || 0,
    geoConfidence: 40,
    coordinateSystem: 'WGS84',
    coordinateSource: 'user-edit',
    navigationDisabled: true
  }));

  const guarded = guardRoutebookFacts(
    { ...routebook, stops: draftStops },
    { guide: routebook.summary || '', importedSources: [], constraints: {}, poiCandidates: [], city: routebook.city }
  );
  draftStops = guarded.routebook.stops;

  if (AMAP_GEOCODE_KEY) {
    draftStops = await mapWithConcurrency(draftStops, 4, async (stop) => {
      const hit = await geocodePoiWithAmap(routebook.city, stop.name, opts.signal).catch(() => null);
      if (!hit || !isValidCoordinate(Number(hit.lat), Number(hit.lng))) return stop;
      const { geocodeChoice: _c, ...fields } = hit;
      return { ...stop, ...fields };
    });
  }

  const mergedStops = [...keep, ...draftStops];
  // Preserve original relative order: keep stops in original positions by day order
  const byDay = new Map();
  for (const stop of mergedStops) {
    const d = stop.day || 'Day 1';
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(stop);
  }
  const orderedDays = (routebook.days?.length ? routebook.days : [...byDay.keys()]).filter((d) => byDay.has(d));
  for (const d of byDay.keys()) if (!orderedDays.includes(d)) orderedDays.push(d);
  // 与前端同一规则：去掉空的天并顺延编号，不补站。
  const compacted = compactDays(orderedDays.flatMap((d) => byDay.get(d) || []), orderedDays);
  const finalStops = compacted.stops;
  orderedDays.splice(0, orderedDays.length, ...compacted.days);

  let routed = { ...routebook, stops: finalStops, days: orderedDays };
  try {
    routed = await attachServerRouteLegs(routed, opts.signal, undefined, { reuseVerifiedLegs: true });
  } catch {
    /* offline routing ok */
  }

  const proposal = {
    id: `proposal-${Date.now().toString(36)}`,
    scope: { type: scope.type || 'day', day, stopIds: scoped.map((s) => s.id) },
    instruction,
    createdAt: new Date().toISOString(),
    mode: 'fast',
    stops: finalStops,
    days: orderedDays,
    routeLegs: routed.routeLegs ?? routebook.routeLegs,
    guard: { events: guarded.events?.length || 0 },
    summary: `已重排 ${day}：${draftStops.map((s) => s.name).join('、')}`
  };

  await appendJsonLine(AI_LOG_PATH, {
    kind: 'patch-routebook',
    status: 'ok',
    profileId: opts.profileId || routebook.profileId || '',
    requestId: opts.requestId || '',
    day,
    stopCount: draftStops.length,
    durationMs: Date.now() - startedAt,
    createdAt: new Date().toISOString()
  }).catch(() => {});

  return { proposal, routebookPreview: routed };
}

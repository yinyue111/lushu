// Model calls: routebook generation, OCR and prompt construction.
import { normalizeGuideOrigins, routebookGuideOrigins } from '../../src/lib/importOrigins.js';
import { isCityOpen, generationModeConfig, pickRuntime } from '../config/runtimeViews.mjs';
import { modelPricingFor } from '../admin/cost.mjs';
import { repairEmptyDays } from '../../src/lib/dayRepair.js';
import { createModelRuntimeLoader, redactBaseUrl } from './runtime.mjs';
import {
  AI_RUNTIME_FROM_CODEX,
  CODEX_AUTH_PATH,
  CODEX_CONFIG_PATH,
  MAX_OCR_IMAGE_BYTES,
  MAX_GUIDE_CHARS,
  AMAP_GEOCODE_KEY,
  AI_MAX_OUTPUT_TOKENS,
  AI_TIMEOUT_MS,
  AI_CALL_TIMEOUT_MS,
  AI_STREAM,
  GENERATION_DEFAULT_MODE,
  resolveGenerationMode,
  OCR_MAX_OUTPUT_TOKENS,
  AI_MAX_OUTPUT_TOKENS_RETRY
} from '../config/index.mjs';
import { createHttpError, truncateString, clampNumber, isValidCoordinate, normalizeCityName, mapWithConcurrency } from '../lib/util.mjs';
import { hasImageMagicBytes } from '../photos/image-metadata.mjs';
import { currentPoiFactValue, refreshMergedPoiCatalog } from '../poi/catalog.mjs';
import { normalizeProfileId, sanitizeEditToken, cryptoRandomId } from '../auth/tokens.mjs';
import {
  normalizeImportedSources,
  buildRoutebookMetrics,
  buildRoutebookValidations,
  buildSourceSummary,
  calculateRouteTrustScore,
  normalizeAiNotes,
  normalizeCreator,
  normalizeRouteConstraints,
  normalizeTravelDate,
  serverProcessLogs
} from '../routebooks/normalize.mjs';
import { deriveStopProvenance } from '../trust/provenance.mjs';
import { routeEvidenceScore } from '../../src/lib/trustSignals.js';
import { formatCostInfo, normalizeCostInfo, parseCostText } from '../../src/lib/cost.js';
import { normalizeCoordinate } from '../geo/normalize-coordinate.mjs';
import { geocodePoiWithAmap } from '../geo/amap.mjs';
import { attachServerRouteLegs } from '../routing/service.mjs';
import { estimateModelCost, normalizeModelUsage, summarizeModelUsage } from '../analytics/aiObservability.mjs';
import { createUntrustedFence, fenceImportedSources } from './untrusted.mjs';
import { scheduleShadowJudgment } from '../shadow/index.mjs';
import { GENERATION_DEADLINE_REASON } from './generationJobs.mjs';
import { readModelStream } from './modelStream.mjs';
import { guardRoutebookFacts, summarizeGuardEvents } from './factGuard.mjs';

export const loadCodexRuntime = createModelRuntimeLoader({
  readCodex: AI_RUNTIME_FROM_CODEX,
  configPath: CODEX_CONFIG_PATH,
  authPath: CODEX_AUTH_PATH
});

export function normalizeOcrImage(image, index) {
  const name = truncateString(image?.name, 120) || `截图 ${index + 1}`;
  const mimeType = truncateString(image?.mimeType || image?.type, 80) || 'image/png';
  const data = String(image?.data ?? image?.base64 ?? '').trim();
  const base64 = data.includes(',') ? data.split(',').pop() : data;
  if (!/^image\/(png|jpe?g|webp)$/i.test(mimeType)) {
    throw createHttpError(`${name} 不是支持的图片格式`, 415, 'OCR_UNSUPPORTED_IMAGE');
  }
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw createHttpError(`${name} 图片内容为空或不是 base64`, 400, 'OCR_BAD_IMAGE');
  }
  const bytes = Buffer.byteLength(base64, 'base64');
  if (bytes > MAX_OCR_IMAGE_BYTES) {
    throw createHttpError(`${name} 超过 OCR 图片大小限制`, 413, 'OCR_IMAGE_TOO_LARGE');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!hasImageMagicBytes(buffer, mimeType)) {
    throw createHttpError(`${name} 图片文件头与格式不匹配`, 415, 'OCR_BAD_IMAGE_SIGNATURE');
  }
  return {
    name,
    mimeType,
    dataUrl: `data:${mimeType};base64,${base64}`,
    bytes
  };
}

function normalizeOcrResult(result, images, runtime) {
  const places = Array.isArray(result?.places) ? result.places : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  return {
    ok: true,
    imageCount: images.length,
    places: places.slice(0, 24).map((place, index) => ({
      name: truncateString(place?.name, 48) || `候选地点 ${index + 1}`,
      time: truncateString(place?.time, 40),
      price: truncateString(place?.price, 40),
      note: truncateString(place?.note, 120),
      confidence: clampNumber(place?.confidence, 0, 99, 58)
    })),
    guideText: truncateString(result?.guideText, 4000),
    warnings: warnings.map((item) => truncateString(item, 120)).slice(0, 12),
    provider: {
      name: runtime.providerName,
      model: runtime.model,
      baseUrl: redactBaseUrl(runtime.baseUrl),
      generatedAt: new Date().toISOString()
    }
  };
}

const NULLABLE_NUMBER = { type: ['number', 'null'] };

// The model returns content only. Trust scores, process logs, metrics and
// pass/fail checks are computed by server code; the model's risk hints are kept
// as `riskNotes` and shown as unverified "AI 提示".
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'days', 'stops', 'assets', 'riskNotes'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    days: { type: 'array', items: { type: 'string' } },
    stops: {
      type: 'array',
      minItems: 3,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'time', 'name', 'area', 'stay', 'cost', 'costInfo', 'verify', 'risk', 'lat', 'lng', 'geoConfidence', 'coordinateSystem'],
        properties: {
          day: { type: 'string' },
          time: { type: 'string' },
          name: { type: 'string' },
          area: { type: 'string' },
          stay: { type: 'string' },
          cost: { type: 'string' },
          costInfo: {
            type: 'object',
            additionalProperties: false,
            required: ['amount', 'min', 'max', 'unit', 'per', 'free', 'reservationRequired', 'note'],
            properties: {
              amount: NULLABLE_NUMBER,
              min: NULLABLE_NUMBER,
              max: NULLABLE_NUMBER,
              unit: { type: ['string', 'null'], enum: ['ticket', 'meal', 'transport', 'experience', 'other', null] },
              per: { type: ['string', 'null'], enum: ['person', 'group', 'item', null] },
              free: { type: 'boolean' },
              reservationRequired: { type: 'boolean' },
              note: { type: 'string' }
            }
          },
          verify: { type: 'string' },
          risk: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' },
          geoConfidence: { type: 'number' },
          coordinateSystem: { type: 'string' }
        }
      }
    },
    assets: {
      type: 'array',
      minItems: 3,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'type', 'confidence'],
        properties: {
          label: { type: 'string' },
          type: { type: 'string' },
          confidence: { type: 'number' }
        }
      }
    },
    riskNotes: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'detail'],
        properties: {
          label: { type: 'string' },
          detail: { type: 'string' }
        }
      }
    }
  }
};

// A base URL that already ends in a version segment (/v1, /api/v3, /api/paas/v4 …) is used
// as is; otherwise /v1 is appended. Domestic OpenAI-compatible providers use /v3 and /v4.
export function openAiEndpoint(baseUrl, wireApi) {
  let trimmed = '';
  try {
    trimmed = new URL(baseUrl).toString().replace(/\/+$/, '');
  } catch {
    throw createHttpError('OPENAI_BASE_URL 不是合法 URL', 503, 'BAD_BASE_URL');
  }
  const path = wireApi === 'chat_completions' ? 'chat/completions' : 'responses';
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/${path}` : `${trimmed}/v1/${path}`;
}

function systemPrompt() {
  return [
    '你是 AI 可信路书平台的路线编排引擎。',
    '目标不是写泛攻略，而是把用户输入的分散攻略/需求变成可执行、可编辑、可验证的地图路书。',
    '只返回 JSON，不返回 Markdown。',
    '路线必须服务 MVP 闭环：攻略导入、POI 提取、分日路书、可执行校验、行中打卡反哺可信分、商业点击验证。',
    '不要搬运第三方攻略原文；只提取 POI、约束、风险、执行顺序和验证理由。',
    '如果用户提供小红书、抖音、X 或普通网页链接，只能基于公开可访问信息和用户粘贴内容分析；不能假设已绕过登录墙或反爬。',
    '必须显式降低低可信来源、商业推广、过时信息、仅元数据页面的权重，并把需要复核的事实写入 riskNotes 或 stop.risk。',
    '支持中国大陆和港澳台常见旅行目的地；热门城市可直接使用城市中心，非热门城市必须基于用户攻略和地点线索生成，并显式提示需要复核定位。',
    '不要给路线或站点打可信分，也不要声称任何检查已经通过；可信度由平台根据来源、坐标和真实打卡计算。',
    '每个 stop 必须包含真实地图可用的 lat/lng。',
    'stop.costInfo 用结构化字段表示费用：amount 为确定金额（元），有区间时填 min/max，per 表示按人/组/份计价，free 表示免费，reservationRequired 表示需预约；不知道时金额填 null，不要编造价格。stop.cost 是给用户看的简短文字。',
    'lat/lng 使用 WGS84，经纬度必须落在对应城市附近；无法精确定位时返回街区级近似坐标并降低 geoConfidence。',
    '每个 stop 的 coordinateSystem 固定返回 WGS84，geoConfidence 为 0-100。',
    '不许编造具体信息：门店/分店名（如“总店”“XX店”）、街道门牌号、门票或票价、人均价格、营业或开放时间、电话、活动日期，只有在用户攻略、导入来源或 approvedPoiCandidates 里出现过才能写；没有就写“待确认”或不写。站点名用攻略里的叫法，不要自己加门店后缀。行程站点只使用用户攻略（含导入来源）里明确出现的地点；不要为凑天数、好看或补路线而自行添加攻略未写的景点。若点位偏少，宁可少站或写清留白，也不要发明新站。平台会自动检查，攻略里没有的具体信息会被改成“待确认”。',
    'riskNotes 只写需要用户出发前注意的提示（如可能需预约、可能拥挤），不写“通过”之类的结论。',
    '如果输入携带 approvedPoiCandidates（运营已审核 POI 候选），优先从候选中选点并直接使用候选给出的坐标与营业时间；不在候选中的自创点位必须显式降低 geoConfidence（<60）并在 stop.risk 标注需实地复核。'
  ].join('\n');
}

// rank12③：按目标城市注入 top-N 已审核运营 POI 候选（紧凑单行格式），
// 让生成结果优先复用运营核验过的坐标/营业时间/停留建议。
const MAX_PROMPT_POI_CANDIDATES = 40;

function approvedFactValue(poi, fieldPattern, nowMs) {
  // F02: only facts with approved evidence that have not expired reach the prompt.
  return truncateString(currentPoiFactValue(poi, fieldPattern, nowMs), 60);
}

export function buildApprovedPoiPromptCandidates(city, pois = refreshMergedPoiCatalog().pois, nowMs = Date.now()) {
  const normalizedCity = normalizeCityName(city);
  const candidates = [];
  for (const poi of pois) {
    if (candidates.length >= MAX_PROMPT_POI_CANDIDATES) break;
    if (poi?.sourceKind === 'seed' || poi?.reviewStatus !== 'approved' || poi?.city !== normalizedCity) continue;
    const lat = Number(poi?.location?.lat);
    const lng = Number(poi?.location?.lng);
    const parts = [
      truncateString(poi?.name, 48),
      isValidCoordinate(lat, lng) ? `坐标:${lat.toFixed(6)},${lng.toFixed(6)}` : '坐标:未核验',
      `开放:${approvedFactValue(poi, /开放时间|营业时间/, nowMs) || '未核验'}`,
      `建议停留:${approvedFactValue(poi, /建议停留|停留时长|停留/, nowMs) || '未知'}`,
      `适合:${approvedFactValue(poi, /适合人群|人群/, nowMs) || '未核验'}`
    ];
    if (!parts[0]) continue;
    candidates.push(parts.join('|'));
  }
  return candidates;
}

export function sanitizePayload(payload) {
  const constraints = payload?.constraints ?? {};
  const rawCity = String(payload?.city ?? '').trim();
  const city = rawCity ? normalizeCityName(rawCity) : '';
  if (!city) {
    throw createHttpError('请先选目的地城市', 400, 'CITY_REQUIRED');
  }
  if (!isCityOpen(city)) {
    throw createHttpError(`内测期间先开放江浙沪的城市，${city}暂时还不能生成。`, 400, 'CITY_NOT_OPEN');
  }
  const guide = truncateString(payload?.guide, MAX_GUIDE_CHARS);
  if (!guide) {
    throw createHttpError('请先输入攻略、链接或旅行需求', 400, 'GUIDE_REQUIRED');
  }
  if (String(payload?.guide ?? '').length > MAX_GUIDE_CHARS) {
    throw createHttpError(`攻略内容不能超过 ${MAX_GUIDE_CHARS} 字`, 413, 'GUIDE_TOO_LONG');
  }

  return {
    city,
    mode: resolveGenerationMode(payload?.mode),
    profileId: normalizeProfileId(payload?.profileId),
    editToken: sanitizeEditToken(payload?.editToken),
    guide,
    importedSources: normalizeImportedSources(payload?.importedSources),
    guideOrigins: normalizeGuideOrigins(payload?.guideOrigins),
    constraints: {
      duration: truncateString(constraints.duration, 30) || '2 天 1 晚',
      // No silent default: an unset budget means "no budget constraint".
      budget: truncateString(constraints.budget, 30),
      tempo: truncateString(constraints.tempo, 30) || '松弛但不空',
      companion: truncateString(constraints.companion, 30) || '朋友',
      date: truncateString(constraints.date, 30),
      base: truncateString(constraints.base, 80),
      transport: truncateString(constraints.transport, 60),
      theme: truncateString(constraints.theme, 120),
      mustGo: truncateString(constraints.mustGo, 120),
      avoid: truncateString(constraints.avoid, 120)
    }
  };
}

/** Builds the user message; untrusted text is fenced (see ./untrusted.mjs). */
export function buildUserPrompt(payload, fence = createUntrustedFence()) {
  const constraints = payload.constraints ?? {};
  const guide = fence.wrap('GUIDE', payload.guide);
  const sources = fenceImportedSources(payload.importedSources ?? [], fence);
  const prompt = JSON.stringify(
    {
      untrustedContentPolicy: fence.instruction,
      city: payload.city,
      guide: guide.text,
      constraints: {
        duration: constraints.duration ?? '2 天 1 晚',
        budget: constraints.budget || '未设置（无预算约束，不要按预算筛选）',
        tempo: constraints.tempo ?? '松弛但不空',
        companion: constraints.companion ?? '朋友',
        date: constraints.date ?? '',
        base: constraints.base ?? '',
        transport: constraints.transport ?? '',
        theme: constraints.theme ?? '',
        mustGo: constraints.mustGo ?? '',
        avoid: constraints.avoid ?? ''
      },
      importedSources: sources.sources,
      // rank12③：运营已审核 POI 候选（名称|坐标|开放|建议停留|适合），无候选时省略。
      ...(Array.isArray(payload.poiCandidates) && payload.poiCandidates.length ? { approvedPoiCandidates: payload.poiCandidates } : {}),
      sourcePolicy: [
        'importedSources 是公开链接导入与可信度分析结果，不代表平台已验证全部事实。',
        '优先使用 trustScore 高、status=fetched、signals 多的来源；对 warnings 中的商业推广、页面不可抓取、正文过短等信号降权。',
        '不要复制原攻略文字；只提炼地点、时间、预算、风险、适合人群和验证理由。',
        '如果链接只能拿到元数据，必须在 stop.verify 或 riskNotes 里提示“需用户补充原文/出发前复核”。',
        '个人攻略必须服从用户 constraints，而不是照搬任一平台作者路线。'
      ],
      dayPlan: dayPlanInstruction(constraints.duration),
      requiredOutputShape: RESPONSE_SCHEMA
    },
    null,
    2
  );
  return { prompt, injectionMarkersRemoved: guide.removed + sources.removed, fence };
}

export function extractTextFromResponse(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') chunks.push(content.text);
    }
  }
  const chatContent = data.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string') chunks.push(chatContent);
  if (Array.isArray(chatContent)) {
    for (const content of chatContent) {
      if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

export function parseJsonFromText(text) {
  if (!text) throw new Error('模型没有返回文本');
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('模型返回中没有可解析 JSON');
    return JSON.parse(match[0]);
  }
}

function normalizeRoutebook(routebook, payload, runtime) {
  const now = new Date();
  const rawDays = Array.isArray(routebook.days) && routebook.days.length ? routebook.days : [];
  const inferredDayCount = inferDayCount(routebook, payload, rawDays);
  const requestedDayCount = inferDayCount(routebook, payload, rawDays, Number.POSITIVE_INFINITY);
  let days = Array.from({ length: inferredDayCount }, (_, index) => `Day ${index + 1}`);
  let stops = (Array.isArray(routebook.stops) ? routebook.stops : []).map((stop, index) => {
    const name = String(stop.name ?? `站点 ${index + 1}`).slice(0, 32);
    const coordinate = normalizeCoordinate({ ...stop, name, coordinateSource: stop.coordinateSource || 'model' }, payload.city, index);
    const costText = String(stop.cost ?? '').slice(0, 20);
    const structuredCost = normalizeCostInfo(stop.costInfo, 'model');
    const costInfo = structuredCost?.known || structuredCost?.reservationRequired ? structuredCost : parseCostText(costText);
    const displayCost = costText || formatCostInfo(costInfo);
    return {
      id: index + 1,
      day: normalizeDayLabel(stop.day, index, days),
      time: String(stop.time ?? '10:00'),
      name,
      area: String(stop.area ?? '待确认').slice(0, 24),
      stay: String(stop.stay ?? '60 分钟').slice(0, 18),
      cost: displayCost,
      costInfo: { ...costInfo, text: displayCost },
      verify: String(stop.verify ?? '需通过真实打卡继续验证').slice(0, 60),
      risk: String(stop.risk ?? '需出发前复核').slice(0, 60),
      lat: coordinate.lat,
      lng: coordinate.lng,
      geoConfidence:
        coordinate.fallback || coordinate.navigationDisabled === true
          ? clampNumber(coordinate.confidence, 20, 59, 45)
          : clampNumber(stop.geoConfidence, 60, 99, coordinate.confidence ?? 86),
      coordinateSystem: 'WGS84',
      coordinateSource: coordinate.source,
      coordinatePrecision: coordinate.precision,
      coordinateRadiusMeters:
        coordinate.fallback || coordinate.navigationDisabled === true ? (coordinate.radiusMeters ?? 1500) : (coordinate.radiusMeters ?? 0),
      navigationDisabled: coordinate.navigationDisabled === true,
      provenance: deriveStopProvenance(
        { name },
        { city: payload.city, guideText: payload.guide, mustGo: payload.constraints?.mustGo, importedSources: payload.importedSources }
      )
    };
  });

  if (stops.length < 3) {
    throw new Error('模型返回的站点数量不足');
  }
  const dayRepair = repairEmptyDays(stops, days);
  stops = dayRepair.stops;
  days = dayRepair.days;

  const id = cryptoRandomId();
  const sourceSummary = buildSourceSummary(payload.importedSources);
  const baseValidations = buildRoutebookValidations(stops, [], 'AI 生成', {
    city: payload.city,
    constraints: payload.constraints,
    travelDate: normalizeTravelDate(payload.constraints?.date)
  });
  const routebookValidations =
    requestedDayCount > inferredDayCount
      ? [
          {
            id: 'day-count-compressed',
            label: '行程天数',
            state: '已压缩',
            detail: `识别到约 ${requestedDayCount} 天行程，超出单次生成 ${MAX_GENERATED_ROUTE_DAYS} 天上限，已压缩为 ${inferredDayCount} 天，建议按段拆分生成。`
          },
          ...baseValidations
        ].slice(0, 8)
      : baseValidations;
  if (dayRepair.validation) {
    routebookValidations.unshift(dayRepair.validation);
    routebookValidations.splice(8);
  }
  const routebookMetrics = buildRoutebookMetrics(stops);
  return {
    id,
    publicId: id,
    profileId: normalizeProfileId(payload.profileId),
    creator: normalizeCreator({ id: payload.profileId, sourceAuthorization: 'user-generated' }),
    publishStatus: 'draft',
    sourceAuthorization: 'user-generated',
    copyCount: 0,
    city: payload.city,
    title: String(routebook.title ?? `${payload.city ?? '杭州'} 可信路书`).slice(0, 42),
    summary: String(routebook.summary ?? '已生成可执行路线，并标记需要真实打卡校准的风险。').slice(0, 140),
    trustScore: calculateRouteTrustScore(stops),
    days,
    stops,
    assets: normalizeArray(routebook.assets),
    validations: routebookValidations,
    metrics: routebookMetrics,
    // Model-written hints, shown as unverified "AI 提示"; legacy outputs used `validations`.
    aiNotes: normalizeAiNotes(Array.isArray(routebook.riskNotes) ? routebook.riskNotes : routebook.validations),
    importedSources: payload.importedSources ?? [],
    guideOrigins: routebookGuideOrigins(payload),
    sourceSummary,
    constraints: normalizeRouteConstraints(payload.constraints),
    travelDate: normalizeTravelDate(payload.constraints?.date),
    provider: {
      name: runtime.providerName,
      model: runtime.model,
      baseUrl: redactBaseUrl(runtime.baseUrl),
      generatedAt: now.toISOString(),
      travelDate: normalizeTravelDate(payload.constraints?.date)
    },
    updatedAt: now.toISOString()
  };
}

/** Shadow mode: Jev picks among the same AMap candidates; coordinates are never sent. */
function shadowGeocodeChoice({ city, name, candidates, choice }) {
  if (!candidates?.length) return;
  scheduleShadowJudgment('geocode-choice', {
    stopName: name,
    city,
    candidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, address: candidate.address, typecode: candidate.typecode })),
    ruleChosenId: choice?.chosen?.id ?? null
  });
}

/**
 * @param {any} routebook
 * @param {AbortSignal | undefined} signal
 * @param {(progress: { done: number, total: number }) => void} [onProgress]
 */
async function geocodeGeneratedRoutebook(routebook, signal, onProgress = () => {}) {
  if (!AMAP_GEOCODE_KEY || !routebook?.stops?.length) return routebook;
  let done = 0;
  const total = routebook.stops.length;
  const stops = await mapWithConcurrency(routebook.stops, 4, async (stop) => {
    const finish = (value) => {
      done += 1;
      onProgress({ done, total });
      return value;
    };
    if (stop.coordinateSource === 'known-poi') return finish(stop);
    const geocoded = await geocodePoiWithAmap(routebook.city, stop.name, signal, { onCandidates: shadowGeocodeChoice }).catch(() => null);
    if (!geocoded) return finish(stop);
    // The candidate choice is audit detail for the server, not a stop field clients may echo back.
    const { geocodeChoice: _choice, ...fields } = geocoded;
    return finish({ ...stop, ...fields });
  });
  return {
    ...routebook,
    stops,
    trustScore: calculateRouteTrustScore(stops),
    validations: buildRoutebookValidations(stops, routebook.validations, '真实地理编码校准', {
      city: routebook.city,
      constraints: routebook.constraints,
      travelDate: routebook.provider?.travelDate || routebook.travelDate
    }),
    metrics: buildRoutebookMetrics(stops)
  };
}

/**
 * Process log written by the server from what actually ran. Stages that did
 * not run are reported as 未执行, never as passed.
 */
function buildServerProcessLog(routebook, stages, { geocodingConfigured, modeLabel = '', model = '' }) {
  const stops = routebook.stops ?? [];
  const evidence = routeEvidenceScore(stops).breakdown;
  const legs = routebook.routeLegs ?? [];
  const verifiedLegs = legs.filter((leg) => leg.status === 'verified').length;
  const at = new Date().toISOString();
  const duration = (name) => (stages[name]?.durationMs != null ? `${Math.round(stages[name].durationMs / 100) / 10}s` : '');
  return serverProcessLogs([
    {
      stage: '模型生成',
      input: modeLabel ? `你的攻略与约束（${modeLabel} · ${model}）` : '你的攻略与约束',
      result: `返回 ${stops.length} 个站点 ${duration('model')}`.trim(),
      status: '完成',
      time: at
    },
    {
      stage: '站点来源比对',
      input: '攻略原文、导入来源、已审核 POI',
      result: `攻略 ${evidence.origins['user-guide']} · 导入来源 ${evidence.origins['imported-source']} · AI 补充 ${evidence.origins.model} · 命中已审核 POI ${evidence.reviewedPoiCount}`,
      status: '完成',
      time: at
    },
    geocodingConfigured
      ? {
          stage: '地图定位',
          input: '站点名称',
          result: `${evidence.verifiedCoordinateCount}/${stops.length} 个站点精确定位 ${duration('geocoding')}`.trim(),
          status: evidence.verifiedCoordinateCount === stops.length ? '完成' : '需复核',
          time: at
        }
      : { stage: '地图定位', input: '站点名称', result: '未配置地图服务密钥，未执行；非已审核 POI 的坐标为近似值', status: '未执行', time: at },
    legs.length
      ? {
          stage: '查路线',
          input: '同日相邻站点',
          result: `${verifiedLegs}/${legs.length} 段路线已查过`,
          status: verifiedLegs === legs.length ? '完成' : '需复核',
          time: at
        }
      : { stage: '查路线', input: '同日相邻站点', result: '未执行（未配置道路服务或无同日转场）', status: '未执行', time: at },
    { stage: '系统检查', input: '路线与约束', result: `${(routebook.validations ?? []).length} 项由系统重新计算`, status: '完成', time: at }
  ]);
}

const MAX_GENERATED_ROUTE_DAYS = 10;

function inferDayCount(routebook, payload, rawDays, maxDays = MAX_GENERATED_ROUTE_DAYS) {
  const duration = String(payload?.constraints?.duration ?? '');
  const durationMatch = duration.match(/(\d+)\s*天|(\d+)\s*日/);
  const durationCount = Number(durationMatch?.[1] ?? durationMatch?.[2]);
  const stopDayNumbers = (Array.isArray(routebook?.stops) ? routebook.stops : [])
    .map((stop) => extractDayNumber(stop.day))
    .filter((number) => Number.isFinite(number));
  const maxStopDay = stopDayNumbers.length ? Math.max(...stopDayNumbers) : 0;
  return Math.min(maxDays, Math.max(1, durationCount || rawDays.length || maxStopDay || 2));
}

function extractDayNumber(value) {
  const text = String(value ?? '');
  const match = text.match(/Day\s*(\d+)|第\s*(\d+)\s*天|D\s*(\d+)/i);
  const number = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isFinite(number) ? number : null;
}

export { repairEmptyDays };

export function dayPlanInstruction(duration) {
  const match = String(duration ?? '').match(/(\d+)\s*天|(\d+)\s*日/);
  const count = Math.min(MAX_GENERATED_ROUTE_DAYS, Math.max(1, Number(match?.[1] ?? match?.[2]) || 2));
  const labels = Array.from({ length: count }, (_, index) => `Day ${index + 1}`).join('、');
  return `用户选了 ${count} 天：days 必须恰好是 [${labels}]，每个 stop.day 必须是其中之一，并把站点按顺路分到每一天，每天至少 1 站。攻略点位不够分满 ${count} 天时，不要编造新站，在 riskNotes 写明“攻略里的地点只够排 X 天”。`;
}

function normalizeDayLabel(value, index, days) {
  const dayNumber = extractDayNumber(value);
  if (dayNumber && days[dayNumber - 1]) return days[dayNumber - 1];
  const stopCountPerDay = Math.max(3, Math.ceil(9 / days.length));
  return days[Math.min(Math.floor(index / stopCountPerDay), days.length - 1)] ?? 'Day 1';
}

function normalizeArray(items) {
  const source = Array.isArray(items) ? items : [];
  const fallback = [
    { label: '核心 POI', type: '地点', confidence: 78 },
    { label: '时间约束', type: '约束', confidence: 74 },
    { label: '预算约束', type: '约束', confidence: 72 }
  ];
  const normalized = source.slice(0, 12).map((item, index) => ({
    label: String(item.label ?? `资产 ${index + 1}`).slice(0, 18),
    type: String(item.type ?? 'POI').slice(0, 18),
    confidence: clampNumber(item.confidence, 50, 99, 78)
  }));
  return [...normalized, ...fallback].slice(0, Math.max(3, normalized.length));
}

/** Timeout for one model request: AI_CALL_TIMEOUT_MS, cut to what is left of the generation budget. */
export function modelCallTimeoutMs(deadline = 0, now = Date.now(), callTimeoutMs = AI_CALL_TIMEOUT_MS) {
  if (!deadline) return callTimeoutMs;
  return Math.max(1, Math.min(callTimeoutMs, deadline - now));
}

/** The generation job aborts its signal with this reason when the overall budget (AI_TIMEOUT_MS) runs out. */
function isDeadlineAbort(signal) {
  return Boolean(signal?.aborted && signal.reason?.code === GENERATION_DEADLINE_REASON);
}
function modelTimeoutError() {
  return createHttpError(`模型服务响应超时（生成总时长上限 ${Math.round(AI_TIMEOUT_MS / 1000)} 秒），请稍后重试`, 504, 'MODEL_TIMEOUT');
}

// Relays that reject json_schema with a 400 are remembered, so later generations skip straight to the
// format that worked instead of paying for the failed request every time.
const structuredFormatByRuntime = new Map();
function runtimeFormatKey(runtime) {
  return `${runtime.baseUrl}|${runtime.wireApi}|${runtime.model}`;
}
export function resetStructuredFormatCache() {
  structuredFormatByRuntime.clear();
}

function isStructuredOutputUnsupported(error) {
  const detail = `${error.upstreamCode ?? ''} ${error.upstreamDetail ?? ''}`;
  return error.statusCode === 400 && /json_schema|schema|structured|response_format|text\.format/i.test(detail);
}

/**
 * @param {any} payload
 * @param {any} runtime
 * @param {{ responseFormat?: string, signal?: AbortSignal, maxOutputTokens?: number, deadline?: number, callTimeoutMs?: number, stream?: boolean, idleTimeoutMs?: number, reasoningEffort?: string, onActivity?: (info: { chars: number, first: boolean }) => void }} [options]
 */
async function callOpenAiApi(
  payload,
  runtime,
  {
    responseFormat = 'json_schema',
    signal,
    maxOutputTokens = AI_MAX_OUTPUT_TOKENS,
    deadline = 0,
    callTimeoutMs = AI_CALL_TIMEOUT_MS,
    stream = false,
    idleTimeoutMs = 0,
    reasoningEffort = '',
    onActivity = () => {}
  } = {}
) {
  const { prompt: userMessage, fence } = buildUserPrompt(payload);
  const system = `${systemPrompt()}\n${fence.instruction}`;
  /** @type {any} */
  const requestBody =
    runtime.wireApi === 'chat_completions'
      ? {
          model: runtime.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userMessage }
          ],
          max_tokens: maxOutputTokens,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
        }
      : {
          model: runtime.model,
          input: [
            { role: 'system', content: [{ type: 'input_text', text: system }] },
            { role: 'user', content: [{ type: 'input_text', text: userMessage }] }
          ],
          store: false,
          max_output_tokens: maxOutputTokens,
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
          ...(stream ? { stream: true } : {})
        };

  if (responseFormat === 'json_schema') {
    const format = {
      type: 'json_schema',
      name: 'trusted_routebook',
      schema: RESPONSE_SCHEMA,
      strict: true
    };
    if (runtime.wireApi === 'chat_completions') {
      requestBody.response_format = {
        type: 'json_schema',
        json_schema: {
          name: format.name,
          schema: format.schema,
          strict: format.strict
        }
      };
    } else {
      requestBody.text = { format };
    }
  } else if (responseFormat === 'json_object') {
    if (runtime.wireApi === 'chat_completions') {
      requestBody.response_format = { type: 'json_object' };
    } else {
      requestBody.text = { format: { type: 'json_object' } };
    }
  }

  // endpoint 在 try 外求值：BAD_BASE_URL 等配置错误应原样上抛（503），
  // 而不是被 catch 吞成 MODEL_FETCH_FAILED。
  const endpoint = openAiEndpoint(runtime.baseUrl, runtime.wireApi);
  const controller = new AbortController();
  let timedOut = false;
  let idleTimedOut = false;
  const timeoutId = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    modelCallTimeoutMs(deadline, Date.now(), callTimeoutMs)
  );
  // Streaming: no bytes for idleTimeoutMs (before the first token or between tokens) aborts the call,
  // instead of waiting out the whole budget on a stuck upstream.
  let idleId = null;
  const armIdle = () => {
    if (!stream || !idleTimeoutMs) return;
    if (idleId) clearTimeout(idleId);
    idleId = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  armIdle();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  let response;
  let text = '';
  let streamed = null;
  // The timeout and the caller's abort cover the whole exchange, body included: relays
  // often send headers early and stream the body, so stopping at headers is not enough.
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    armIdle();
    if (stream && response.ok && /text\/event-stream/i.test(response.headers.get('content-type') ?? '') && response.body) {
      streamed = await readModelStream(response.body, {
        wireApi: runtime.wireApi,
        onActivity: (info) => {
          armIdle();
          onActivity(info);
        }
      });
    } else {
      text = await response.text();
    }
  } catch (error) {
    if (idleTimedOut) {
      throw createHttpError(`模型 ${Math.round(idleTimeoutMs / 1000)} 秒没有输出，已停止，请稍后重试`, 504, 'MODEL_STALLED');
    }
    if (timedOut || isDeadlineAbort(signal)) throw modelTimeoutError();
    if (signal?.aborted) {
      throw createHttpError('已取消生成', 499, 'CLIENT_ABORTED');
    }
    if (error?.statusCode) throw error;
    throw createHttpError('模型服务暂时不可用', 502, 'MODEL_FETCH_FAILED');
  } finally {
    clearTimeout(timeoutId);
    if (idleId) clearTimeout(idleId);
    signal?.removeEventListener('abort', abortFromCaller);
  }

  let data = {};
  if (streamed) {
    data = streamed;
    if (streamed.error) {
      const error = createHttpError('模型服务调用失败', 502, 'MODEL_ERROR');
      error.upstreamDetail = streamed.error?.message ?? 'stream error';
      error.upstreamCode = streamed.error?.code;
      throw error;
    }
  } else {
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const detail = data.error?.message ?? data.message ?? `HTTP ${response.status}`;
    const error = createHttpError('模型服务调用失败', response.status >= 500 ? 502 : response.status, 'MODEL_ERROR');
    error.upstreamStatus = response.status;
    error.upstreamDetail = detail;
    error.upstreamCode = data.error?.code ?? data.code;
    error.modelUsage = normalizeModelUsage(data, runtime.wireApi);
    throw error;
  }

  // A response that ran out of output budget still returns HTTP 200 with a
  // half-written JSON body, so it has to be caught here instead of at parse time.
  // chat_completions reports truncation as finish_reason "length" on an otherwise normal 200.
  if (data.choices?.[0]?.finish_reason === 'length') {
    data = { ...data, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  }
  if (data.status === 'incomplete') {
    const reason = data.incomplete_details?.reason ?? 'unknown';
    const error = createHttpError('AI 输出被截断，请重试', 502, reason === 'max_output_tokens' ? 'MODEL_OUTPUT_TRUNCATED' : 'MODEL_OUTPUT_INCOMPLETE');
    error.upstreamDetail = `status=incomplete reason=${reason} max_output_tokens=${maxOutputTokens}`;
    error.truncatedByTokenLimit = reason === 'max_output_tokens';
    error.attemptedMaxOutputTokens = maxOutputTokens;
    error.modelUsage = normalizeModelUsage(data, runtime.wireApi);
    throw error;
  }

  return data;
}

export async function analyzeGuideImages(images, signal) {
  const runtime = await loadCodexRuntime();
  if (!runtime.ready) {
    throw createHttpError(runtime.readyReason || 'yinyue provider 或 OPENAI_API_KEY 未配置', 503, 'MODEL_NOT_READY');
  }
  const systemText = [
    '你是可信路书 AI 的截图攻略 OCR/结构化助手。',
    '只识别用户上传截图中的旅行地点、时间、价格、排队、风险、路线顺序线索。',
    '不要复写长篇原文，不要生成营销文案，只返回 JSON。'
  ].join('\n');
  const userText = JSON.stringify(
    {
      task: '从截图中提取旅行攻略线索',
      outputShape: {
        places: [{ name: '地点', time: '时间线索', price: '价格/门票/人均', note: '风险或上下文', confidence: 0 }],
        guideText: '可追加到攻略输入框的摘要',
        warnings: ['需要用户复核的事项']
      },
      policy: '只输出 JSON，不要 Markdown；无法识别时返回空 places 和 warnings。'
    },
    null,
    2
  );
  const responseSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['places', 'guideText', 'warnings'],
    properties: {
      places: {
        type: 'array',
        maxItems: 24,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'time', 'price', 'note', 'confidence'],
          properties: {
            name: { type: 'string' },
            time: { type: 'string' },
            price: { type: 'string' },
            note: { type: 'string' },
            confidence: { type: 'number' }
          }
        }
      },
      guideText: { type: 'string' },
      warnings: { type: 'array', maxItems: 12, items: { type: 'string' } }
    }
  };
  const buildRequestBody = (responseFormat) => {
    const requestBody =
      runtime.wireApi === 'chat_completions'
        ? {
            model: runtime.model,
            messages: [
              { role: 'system', content: systemText },
              {
                role: 'user',
                content: [{ type: 'text', text: userText }, ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } }))]
              }
            ],
            max_tokens: OCR_MAX_OUTPUT_TOKENS
          }
        : {
            model: runtime.model,
            input: [
              { role: 'system', content: [{ type: 'input_text', text: systemText }] },
              {
                role: 'user',
                content: [{ type: 'input_text', text: userText }, ...images.map((image) => ({ type: 'input_image', image_url: image.dataUrl }))]
              }
            ],
            store: false,
            max_output_tokens: OCR_MAX_OUTPUT_TOKENS
          };
    if (responseFormat === 'json_schema') {
      if (runtime.wireApi === 'chat_completions') {
        requestBody.response_format = {
          type: 'json_schema',
          json_schema: { name: 'guide_image_ocr', schema: responseSchema, strict: true }
        };
      } else {
        requestBody.text = {
          format: { type: 'json_schema', name: 'guide_image_ocr', schema: responseSchema, strict: true }
        };
      }
    } else if (responseFormat === 'json_object') {
      if (runtime.wireApi === 'chat_completions') {
        requestBody.response_format = { type: 'json_object' };
      } else {
        requestBody.text = { format: { type: 'json_object' } };
      }
    }
    return requestBody;
  };
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AI_CALL_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const requestModel = async (responseFormat) => {
    const response = await fetch(openAiEndpoint(runtime.baseUrl, runtime.wireApi), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildRequestBody(responseFormat)),
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // 上游返回非 JSON（网关错误页等）时保留上游 status 与截断原文，便于排障。
      const parseError = createHttpError('截图识别上游返回无法解析', 502, 'OCR_UPSTREAM_INVALID_JSON');
      parseError.upstreamStatus = response.status;
      parseError.upstreamDetail = truncateString(`HTTP ${response.status} ${text}`, 400);
      throw parseError;
    }
    if (!response.ok) {
      const detail = data.error?.message ?? data.message ?? `HTTP ${response.status}`;
      const error = createHttpError('截图识别调用失败', response.status >= 500 ? 502 : response.status, 'OCR_MODEL_ERROR');
      error.upstreamStatus = response.status;
      error.upstreamDetail = detail;
      error.upstreamCode = data.error?.code ?? data.code;
      throw error;
    }
    if (data.status === 'incomplete') {
      const error = createHttpError('截图内容过多导致识别结果被截断，请减少图片后重试', 502, 'OCR_OUTPUT_TRUNCATED');
      error.upstreamDetail = `status=incomplete reason=${data.incomplete_details?.reason ?? 'unknown'}`;
      throw error;
    }
    return data;
  };
  try {
    let data;
    try {
      data = await requestModel('json_schema');
    } catch (error) {
      if (!isStructuredOutputUnsupported(error)) throw error;
      try {
        data = await requestModel('json_object');
      } catch (fallbackError) {
        if (!isStructuredOutputUnsupported(fallbackError)) throw fallbackError;
        data = await requestModel('none');
      }
    }
    return normalizeOcrResult(parseJsonFromText(extractTextFromResponse(data)), images, runtime);
  } catch (error) {
    if (timedOut) throw createHttpError('截图识别超时，请减少图片后重试', 504, 'OCR_TIMEOUT');
    if (error.statusCode) throw error;
    throw createHttpError('截图识别暂不可用，请先粘贴正文摘要', 502, 'OCR_UNAVAILABLE');
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

// Ops needs to tell a truncated output apart from a hallucinated one when reading
// the AI log; the HTTP code alone collapses both into MODEL_ERROR.
/** A truncation retry is only worth starting if it can finish: it needs ~1.5x the time the first call took. */
export function retryFitsBudget({ deadline = 0, spentMs = 0, now = Date.now() }) {
  if (!deadline) return true;
  return deadline - now >= Math.min(AI_CALL_TIMEOUT_MS, spentMs * 1.5);
}

export function generationFailureReason(error) {
  switch (error?.code) {
    case 'MODEL_OUTPUT_TRUNCATED':
      return 'truncated';
    case 'MODEL_OUTPUT_INCOMPLETE':
      return 'incomplete';
    case 'MODEL_BAD_OUTPUT':
      return 'bad-output';
    case 'MODEL_TIMEOUT':
      return 'timeout';
    case 'MODEL_NOT_READY':
      return 'not-ready';
    case 'CLIENT_ABORTED':
      return 'client-aborted';
    case 'MODEL_FETCH_FAILED':
      return 'upstream-unreachable';
    default:
      return error?.upstreamStatus ? 'upstream-error' : 'unknown';
  }
}

/**
 * Progress events for async jobs (see ./generationJobs.mjs). Each fires when the
 * backend actually starts or finishes that step; nothing here runs on a timer.
 * @typedef {(event: { stage: 'match' | 'model' | 'geocode' | 'route', state: 'started' | 'completed', detail?: string, progress?: { done: number, total: number } }) => void} GenerationStageListener
 */

/**
 * @param {any} payload
 * @param {AbortSignal} [signal]
 * @param {{ onStage?: GenerationStageListener, deadline?: number, mode?: string }} [options]
 */
export async function generateRoutebook(payload, signal, { onStage = () => {}, deadline = 0, mode = GENERATION_DEFAULT_MODE } = {}) {
  // Runtime config (admin console): per-mode model / base URL / key / timeouts, and the fallback order
  // when the requested mode is not configured. Read per call, so a saved change applies to the next generation.
  const picked = pickRuntime(await loadCodexRuntime(), resolveGenerationMode(mode));
  const modeConfig = generationModeConfig(picked.mode);
  const runtime = picked.runtime;
  if (!runtime.ready) {
    throw createHttpError(runtime.readyReason || 'yinyue provider 或 OPENAI_API_KEY 未配置', 503, 'MODEL_NOT_READY');
  }

  // rank12③：把目标城市的已审核运营 POI 候选注入 prompt（≤40 条，构建失败静默降级）。
  onStage({ stage: 'match', state: 'started' });
  let promptPayload = payload;
  let poiCandidateCount = 0;
  try {
    const poiCandidates = buildApprovedPoiPromptCandidates(payload.city);
    poiCandidateCount = poiCandidates.length;
    if (poiCandidates.length) promptPayload = { ...payload, poiCandidates };
  } catch {
    promptPayload = payload;
  }
  onStage({
    stage: 'match',
    state: 'completed',
    detail: poiCandidateCount ? `匹配到 ${poiCandidateCount} 个已审核地点` : `${payload.city || '该城市'}暂无已审核地点库，按攻略原文定位`
  });

  const attempts = [];
  const recordUsage = (usage) =>
    attempts.push({ usage: usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens } : null });
  const stages = {};
  let activeStage = 'model';
  const observability = () => {
    const modelUsage = summarizeModelUsage(attempts);
    return {
      modelUsage,
      costEstimate: estimateModelCost({ modelUsage, model: runtime.model, config: modelPricingFor(runtime.model) }),
      stages,
      modelCalls,
      factGuard: { ...summarizeGuardEvents(factGuardEvents), events: factGuardEvents.slice(0, 50) }
    };
  };
  const runStage = async (name, operation) => {
    activeStage = name;
    const startedAt = Date.now();
    try {
      const value = await operation();
      stages[name] = { durationMs: Date.now() - startedAt, status: 'completed', timedOut: false };
      return value;
    } catch (error) {
      stages[name] = { durationMs: Date.now() - startedAt, status: 'failed', timedOut: /TIMEOUT/.test(String(error.code)) };
      throw error;
    }
  };
  const modelCalls = [];
  let lastReportedChars = 0;
  /** @type {any[]} */
  let factGuardEvents = [];
  const trackedModelCall = async (options) => {
    const startedAt = Date.now();
    try {
      const data = await callOpenAiApi(promptPayload, runtime, {
        deadline,
        callTimeoutMs: Math.min(AI_CALL_TIMEOUT_MS, modeConfig.timeoutMs),
        maxOutputTokens: modeConfig.maxOutputTokens,
        stream: AI_STREAM,
        idleTimeoutMs: modeConfig.idleTimeoutMs,
        reasoningEffort: modeConfig.reasoningEffort,
        onActivity: ({ chars, first }) => {
          if (first) onStage({ stage: 'model', state: 'started', detail: `${modeConfig.label} · 开始输出` });
          else if (chars - lastReportedChars >= 400) {
            lastReportedChars = chars;
            onStage({ stage: 'model', state: 'started', detail: `${modeConfig.label} · 已写 ${chars} 字` });
          }
        },
        ...options
      });
      const usage = normalizeModelUsage(data, runtime.wireApi);
      recordUsage(usage);
      modelCalls.push({
        ...(usage?.reasoningTokens != null ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(modeConfig.reasoningEffort ? { reasoningEffort: modeConfig.reasoningEffort } : {}),
        format: options.responseFormat,
        maxOutputTokens: options.maxOutputTokens ?? modeConfig.maxOutputTokens,
        stream: AI_STREAM,
        durationMs: Date.now() - startedAt,
        ok: true
      });
      return data;
    } catch (error) {
      recordUsage(error.modelUsage ?? null);
      modelCalls.push({
        format: options.responseFormat,
        maxOutputTokens: options.maxOutputTokens ?? modeConfig.maxOutputTokens,
        stream: AI_STREAM,
        durationMs: Date.now() - startedAt,
        ok: false,
        code: error?.code
      });
      throw error;
    }
  };
  const formatKey = runtimeFormatKey(runtime);
  const FORMATS = ['json_schema', 'json_object', 'none'];
  const callModel = async (options = {}) => {
    let index = Math.max(0, FORMATS.indexOf(structuredFormatByRuntime.get(formatKey) ?? 'json_schema'));
    for (;;) {
      try {
        const data = await trackedModelCall({ responseFormat: FORMATS[index], signal, ...options });
        if (index > 0) structuredFormatByRuntime.set(formatKey, FORMATS[index]);
        return data;
      } catch (error) {
        if (!isStructuredOutputUnsupported(error) || index >= FORMATS.length - 1) throw error;
        index += 1;
      }
    }
  };

  try {
    onStage({ stage: 'model', state: 'started', detail: `${modeConfig.label} · ${runtime.model}` });
    const routebook = await runStage('model', async () => {
      const firstStartedAt = Date.now();
      const raw = await callModel().catch((error) => {
        if (!error?.truncatedByTokenLimit || error.attemptedMaxOutputTokens >= AI_MAX_OUTPUT_TOKENS_RETRY) throw error;
        // A retry with a bigger output budget takes at least as long as the truncated call did. If the
        // generation budget cannot fit that, fail now with a clear reason instead of a timeout later.
        if (!retryFitsBudget({ deadline, spentMs: Date.now() - firstStartedAt })) {
          error.upstreamDetail = `${error.upstreamDetail ?? ''} (retry skipped: not enough time left in AI_TIMEOUT_MS)`.trim();
          throw error;
        }
        return callModel({ maxOutputTokens: AI_MAX_OUTPUT_TOKENS_RETRY });
      });
      try {
        const normalized = normalizeRoutebook({ ...parseJsonFromText(extractTextFromResponse(raw)), profileId: payload.profileId }, payload, runtime);
        // Anti-fabrication: specific facts not found in the user's source or reviewed POI data become 「待确认」.
        const guarded = guardRoutebookFacts(normalized, {
          guide: payload.guide,
          importedSources: payload.importedSources,
          constraints: payload.constraints,
          poiCandidates: promptPayload.poiCandidates ?? [],
          city: payload.city
        });
        factGuardEvents = guarded.events;
        return guarded.routebook;
      } catch (error) {
        if (error?.statusCode) throw error;
        const failure = createHttpError('AI 输出格式异常，请重新生成', 502, 'MODEL_BAD_OUTPUT');
        failure.upstreamDetail = error?.message ?? '未知解析失败';
        throw failure;
      }
    });
    onStage({ stage: 'model', state: 'completed', detail: `返回 ${routebook.stops.length} 个站点` });
    onStage({ stage: 'geocode', state: 'started', progress: { done: 0, total: routebook.stops.length } });
    const geocoded = await runStage('geocoding', () =>
      geocodeGeneratedRoutebook(routebook, signal, (progress) => onStage({ stage: 'geocode', state: 'started', progress }))
    );
    const preciseStops = geocoded.stops.filter((stop) => stop.navigationDisabled !== true && Number(stop.geoConfidence) >= 60).length;
    onStage({
      stage: 'geocode',
      state: 'completed',
      detail: AMAP_GEOCODE_KEY ? `${preciseStops}/${geocoded.stops.length} 个站点已定位` : '未配置地图服务，坐标为近似值'
    });
    onStage({ stage: 'route', state: 'started' });
    const routed = await runStage('routing', () => attachServerRouteLegs(geocoded, signal));
    const legs = routed.routeLegs ?? [];
    onStage({
      stage: 'route',
      state: 'completed',
      detail: legs.length ? `${legs.filter((leg) => leg.status === 'verified').length}/${legs.length} 段道路已核验` : '无需核验的同日转场'
    });
    if ((routed.routeLegs ?? []).some((leg) => leg.status !== 'verified')) stages.routing.status = 'degraded';
    if ((routed.routeLegs ?? []).some((leg) => /timeout/i.test(String(leg.error?.code || '')))) stages.routing.timedOut = true;
    return {
      ...routed,
      provider: { ...routed.provider, mode: modeConfig.key },
      ...buildServerProcessLog(routed, stages, { geocodingConfigured: Boolean(AMAP_GEOCODE_KEY), modeLabel: modeConfig.label, model: runtime.model }),
      observability: { ...observability(), mode: modeConfig.key, model: runtime.model }
    };
  } catch (error) {
    error.observability = { ...observability(), failureStage: activeStage };
    throw error;
  }
}

// Model calls: routebook generation, OCR and prompt construction.
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

function openAiEndpoint(baseUrl, wireApi) {
  let trimmed = '';
  try {
    trimmed = new URL(baseUrl).toString().replace(/\/+$/, '');
  } catch {
    throw createHttpError('OPENAI_BASE_URL 不是合法 URL', 503, 'BAD_BASE_URL');
  }
  const path = wireApi === 'chat_completions' ? 'chat/completions' : 'responses';
  return trimmed.endsWith('/v1') ? `${trimmed}/${path}` : `${trimmed}/v1/${path}`;
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
  const city = normalizeCityName(payload?.city);
  const guide = truncateString(payload?.guide, MAX_GUIDE_CHARS);
  if (!guide) {
    throw createHttpError('请先输入攻略、链接或旅行需求', 400, 'GUIDE_REQUIRED');
  }
  if (String(payload?.guide ?? '').length > MAX_GUIDE_CHARS) {
    throw createHttpError(`攻略内容不能超过 ${MAX_GUIDE_CHARS} 字`, 413, 'GUIDE_TOO_LONG');
  }

  return {
    city,
    profileId: normalizeProfileId(payload?.profileId),
    editToken: sanitizeEditToken(payload?.editToken),
    guide,
    importedSources: normalizeImportedSources(payload?.importedSources),
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
      requiredOutputShape: RESPONSE_SCHEMA
    },
    null,
    2
  );
  return { prompt, injectionMarkersRemoved: guide.removed + sources.removed, fence };
}

function extractTextFromResponse(data) {
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

function parseJsonFromText(text) {
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
  const days = Array.from({ length: inferredDayCount }, (_, index) => `Day ${index + 1}`);
  const stops = (Array.isArray(routebook.stops) ? routebook.stops : []).map((stop, index) => {
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

async function geocodeGeneratedRoutebook(routebook, signal) {
  if (!AMAP_GEOCODE_KEY || !routebook?.stops?.length) return routebook;
  const stops = await mapWithConcurrency(routebook.stops, 4, async (stop) => {
    if (stop.coordinateSource === 'known-poi') return stop;
    const geocoded = await geocodePoiWithAmap(routebook.city, stop.name, signal).catch(() => null);
    return geocoded ? { ...stop, ...geocoded } : stop;
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
function buildServerProcessLog(routebook, stages, { geocodingConfigured }) {
  const stops = routebook.stops ?? [];
  const evidence = routeEvidenceScore(stops).breakdown;
  const legs = routebook.routeLegs ?? [];
  const verifiedLegs = legs.filter((leg) => leg.status === 'verified').length;
  const at = new Date().toISOString();
  const duration = (name) => (stages[name]?.durationMs != null ? `${Math.round(stages[name].durationMs / 100) / 10}s` : '');
  return serverProcessLogs([
    { stage: '模型生成', input: '你的攻略与约束', result: `返回 ${stops.length} 个站点 ${duration('model')}`.trim(), status: '完成', time: at },
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
          stage: '道路核验',
          input: '同日相邻站点',
          result: `${verifiedLegs}/${legs.length} 段已核验`,
          status: verifiedLegs === legs.length ? '完成' : '需复核',
          time: at
        }
      : { stage: '道路核验', input: '同日相邻站点', result: '未执行（未配置道路服务或无同日转场）', status: '未执行', time: at },
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

function isStructuredOutputUnsupported(error) {
  const detail = `${error.upstreamCode ?? ''} ${error.upstreamDetail ?? ''}`;
  return error.statusCode === 400 && /json_schema|schema|structured|response_format|text\.format/i.test(detail);
}

/**
 * @param {any} payload
 * @param {any} runtime
 * @param {{ responseFormat?: string, signal?: AbortSignal, maxOutputTokens?: number }} [options]
 */
async function callOpenAiApi(payload, runtime, { responseFormat = 'json_schema', signal, maxOutputTokens = AI_MAX_OUTPUT_TOKENS } = {}) {
  const { prompt: userMessage, fence } = buildUserPrompt(payload);
  const system = `${systemPrompt()}\n${fence.instruction}`;
  const requestBody =
    runtime.wireApi === 'chat_completions'
      ? {
          model: runtime.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userMessage }
          ],
          max_tokens: maxOutputTokens
        }
      : {
          model: runtime.model,
          input: [
            { role: 'system', content: [{ type: 'input_text', text: system }] },
            { role: 'user', content: [{ type: 'input_text', text: userMessage }] }
          ],
          store: false,
          max_output_tokens: maxOutputTokens
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
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AI_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  let response;
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
  } catch (error) {
    if (timedOut) {
      throw createHttpError('模型服务响应超时，请稍后重试', 504, 'MODEL_TIMEOUT');
    }
    if (signal?.aborted) {
      throw createHttpError('客户端已取消请求', 499, 'CLIENT_ABORTED');
    }
    if (error?.statusCode) throw error;
    throw createHttpError('模型服务暂时不可用', 502, 'MODEL_FETCH_FAILED');
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
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
  }, AI_TIMEOUT_MS);
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

export async function generateRoutebook(payload, signal) {
  const runtime = await loadCodexRuntime();
  if (!runtime.ready) {
    throw createHttpError(runtime.readyReason || 'yinyue provider 或 OPENAI_API_KEY 未配置', 503, 'MODEL_NOT_READY');
  }

  // rank12③：把目标城市的已审核运营 POI 候选注入 prompt（≤40 条，构建失败静默降级）。
  let promptPayload = payload;
  try {
    const poiCandidates = buildApprovedPoiPromptCandidates(payload.city);
    if (poiCandidates.length) promptPayload = { ...payload, poiCandidates };
  } catch {
    promptPayload = payload;
  }

  const attempts = [];
  const recordUsage = (usage) =>
    attempts.push({ usage: usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens } : null });
  const stages = {};
  let activeStage = 'model';
  const observability = () => {
    const modelUsage = summarizeModelUsage(attempts);
    return { modelUsage, costEstimate: estimateModelCost({ modelUsage, model: runtime.model }), stages };
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
  const trackedModelCall = async (options) => {
    try {
      const data = await callOpenAiApi(promptPayload, runtime, options);
      recordUsage(normalizeModelUsage(data, runtime.wireApi));
      return data;
    } catch (error) {
      recordUsage(error.modelUsage ?? null);
      throw error;
    }
  };
  const callModel = (options = {}) =>
    trackedModelCall({
      responseFormat: 'json_schema',
      signal,
      ...options
    }).catch(async (error) => {
      if (!isStructuredOutputUnsupported(error)) throw error;
      return trackedModelCall({
        responseFormat: 'json_object',
        signal,
        ...options
      }).catch((fallbackError) => {
        if (!isStructuredOutputUnsupported(fallbackError)) throw fallbackError;
        return trackedModelCall({
          responseFormat: 'none',
          signal,
          ...options
        });
      });
    });

  try {
    const routebook = await runStage('model', async () => {
      const raw = await callModel().catch((error) => {
        if (!error?.truncatedByTokenLimit || error.attemptedMaxOutputTokens >= AI_MAX_OUTPUT_TOKENS_RETRY) throw error;
        return callModel({ maxOutputTokens: AI_MAX_OUTPUT_TOKENS_RETRY });
      });
      try {
        return normalizeRoutebook({ ...parseJsonFromText(extractTextFromResponse(raw)), profileId: payload.profileId }, payload, runtime);
      } catch (error) {
        if (error?.statusCode) throw error;
        const failure = createHttpError('AI 输出格式异常，请重新生成', 502, 'MODEL_BAD_OUTPUT');
        failure.upstreamDetail = error?.message ?? '未知解析失败';
        throw failure;
      }
    });
    const geocoded = await runStage('geocoding', () => geocodeGeneratedRoutebook(routebook, signal));
    const routed = await runStage('routing', () => attachServerRouteLegs(geocoded, signal));
    if ((routed.routeLegs ?? []).some((leg) => leg.status !== 'verified')) stages.routing.status = 'degraded';
    if ((routed.routeLegs ?? []).some((leg) => /timeout/i.test(String(leg.error?.code || '')))) stages.routing.timedOut = true;
    return { ...routed, ...buildServerProcessLog(routed, stages, { geocodingConfigured: Boolean(AMAP_GEOCODE_KEY) }), observability: observability() };
  } catch (error) {
    error.observability = { ...observability(), failureStage: activeStage };
    throw error;
  }
}

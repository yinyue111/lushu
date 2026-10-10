// POI API routes.
import { safeDecodePathSegment, sanitizePublicId, clampNumber, createHttpError, normalizeCityName, truncateString } from '../lib/util.mjs';
import { verifyAdminAccess, verifySensitiveReadAccess, requireLoginForWrites } from '../auth/request-access.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { updatePoiCorrectionStatus, listPoiCorrections, listPoiKnowledge, normalizePoiCorrection } from '../poi/knowledge.mjs';
import { POI_CORRECTION_LOG_PATH } from '../config/index.mjs';
import { appendJsonLine } from '../storage/jsonl.mjs';
import { route } from '../http/router.mjs';
import {
  OPERATIONAL_POI_CITY_SET,
  POI_REVIEW_STATUSES,
  buildPoiCoverageSnapshot,
  commitPoiBatch,
  findTrustedPoi,
  listMergedPois,
  publicOperationalPoiView,
  validatePoiBatch
} from '../poi/catalog.mjs';
import { coordinateForName } from '../geo/normalize-coordinate.mjs';

async function updatePoiCorrectionRoute({ req, res, params }) {
  enforceRateLimit(req);
  verifyAdminAccess(req);
  const id = sanitizePublicId(safeDecodePathSegment(params.id));
  const correction = await updatePoiCorrectionStatus(id, await readJsonBody(req));
  return sendJson(res, 200, { ok: true, correction });
}

export const poiRoutes = [
  route('POST', '/api/pois/validate', async ({ req, res }) => {
    enforceRateLimit(req);
    verifyAdminAccess(req);
    const validation = await validatePoiBatch(await readJsonBody(req));
    return sendJson(res, 200, { ok: true, ...validation });
  }),
  route('POST', '/api/pois/upsert', async ({ req, res }) => {
    enforceRateLimit(req);
    verifyAdminAccess(req);
    const result = await commitPoiBatch(await readJsonBody(req));
    const { statusCode, ...payload } = result;
    return sendJson(res, statusCode, payload);
  }),
  // 跨区契约：站点改名重校验的服务端解析端点。与 hardenDraftStops 同一
  // 合并目录（seed TRUSTED_POI_CATALOG + 运营 approved POI，normalizeCityName/
  // normalizePoiName 精确匹配）；public-read 限流、无需鉴权。
  route('GET', '/api/pois/resolve', async ({ req, res, url }) => {
    enforceRateLimit(req, 'public-read');
    const city = url.searchParams.get('city') ? normalizeCityName(url.searchParams.get('city')) : '';
    const name = truncateString(url.searchParams.get('name'), 80);
    const canonical = name ? coordinateForName(name, city) : null;
    if (!canonical) {
      return sendJson(res, 200, { ok: true, poi: { matched: false } });
    }
    const trusted = findTrustedPoi({ name }, city);
    return sendJson(res, 200, {
      ok: true,
      poi: {
        matched: true,
        name: truncateString(trusted?.name, 80) || name,
        poiId: trusted?.poiId ?? '',
        lat: canonical.lat,
        lng: canonical.lng,
        geoConfidence: canonical.confidence,
        coordinateSource: canonical.source
      }
    });
  }),
  route('GET', '/api/pois', async ({ req, res, url }) => {
    verifyAdminAccess(req);
    const city = truncateString(url.searchParams.get('city'), 40).replace(/市$/u, '');
    const reviewStatus = truncateString(url.searchParams.get('reviewStatus'), 24);
    const freshnessState = truncateString(url.searchParams.get('freshnessState'), 24);
    if (city && !OPERATIONAL_POI_CITY_SET.has(city)) {
      throw createHttpError('运营 POI 当前只支持杭州、上海、苏州', 400, 'UNSUPPORTED_OPERATIONAL_CITY');
    }
    if (reviewStatus && !POI_REVIEW_STATUSES.has(reviewStatus)) {
      throw createHttpError('reviewStatus 只能是 pending/approved/rejected', 400, 'INVALID_POI_STATUS_FILTER');
    }
    if (freshnessState && !['fresh', 'expiringSoon', 'stale', 'pending'].includes(freshnessState)) {
      throw createHttpError('freshnessState 只能是 fresh/expiringSoon/stale/pending', 400, 'INVALID_FRESHNESS_FILTER');
    }
    const snapshotAt = new Date().toISOString();
    const nowMs = Date.parse(snapshotAt);
    const pois = (await listMergedPois())
      .map((poi) => publicOperationalPoiView(poi, nowMs))
      .filter(
        (poi) =>
          (!city || poi.city === city) && (!reviewStatus || poi.reviewStatus === reviewStatus) && (!freshnessState || poi.freshnessState === freshnessState)
      )
      .sort((left, right) => left.city.localeCompare(right.city, 'zh-CN') || left.name.localeCompare(right.name, 'zh-CN'));
    return sendJson(res, 200, {
      ok: true,
      snapshotAt,
      filters: { city, reviewStatus, freshnessState },
      total: pois.length,
      pois
    });
  }),
  route('GET', '/api/poi-coverage', async ({ req, res }) => {
    verifyAdminAccess(req);
    return sendJson(res, 200, { ok: true, ...(await buildPoiCoverageSnapshot()) });
  }),
  route('POST', '/api/poi-corrections', async ({ req, res }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req);
    const correction = normalizePoiCorrection(await readJsonBody(req));
    await appendJsonLine(POI_CORRECTION_LOG_PATH, correction);
    return sendJson(res, 200, { ok: true, correction });
  }),
  route('GET', '/api/poi-corrections', async ({ req, res, url }) => {
    verifySensitiveReadAccess(req);
    return sendJson(res, 200, {
      ok: true,
      corrections: await listPoiCorrections(clampNumber(url.searchParams.get('limit') || undefined, 1, 200, 50), {
        status: truncateString(url.searchParams.get('status'), 24)
      })
    });
  }),
  route('GET', '/api/poi-knowledge', async ({ req, res, url }) => {
    enforceRateLimit(req, 'public-read');
    const city = url.searchParams.get('city') ? normalizeCityName(url.searchParams.get('city')) : '';
    const stopName = truncateString(url.searchParams.get('stopName'), 80);
    return sendJson(res, 200, {
      ok: true,
      knowledge: await listPoiKnowledge({
        city,
        stopName,
        limit: clampNumber(url.searchParams.get('limit') || undefined, 1, 200, 80)
      })
    });
  }),
  route('POST', '/api/poi-corrections/:id/status', updatePoiCorrectionRoute),
  // 兼容旧客户端：不带 /status 后缀的同一操作。
  route('POST', '/api/poi-corrections/:id', updatePoiCorrectionRoute)
];

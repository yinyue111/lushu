// Check-in, photo, click and exposure API routes.
import {
  clampNumber,
  createHttpError,
  distanceMeters,
  isValidCoordinate,
  normalizeCityName,
  safeDecodePathSegment,
  sanitizePublicId,
  truncateString
} from '../lib/util.mjs';
import {
  CHECKIN_LOG_PATH,
  CHECKIN_PHOTO_GPS_MATCH_METERS,
  CHECKIN_PHOTO_ID_PATTERN,
  CHECKIN_PHOTO_LOG_PATH,
  CLICK_LOG_PATH,
  EXPOSURE_LOG_PATH,
  MAX_CHECKIN_PHOTO_REQUEST_BYTES
} from '../config/index.mjs';
import { appendJsonLine, findLatestJsonLine, readJsonLines, readMatchingJsonLines } from '../storage/jsonl.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { cryptoRandomId, normalizeProfileId } from '../auth/tokens.mjs';
import { resolveWriteProfile, verifySensitiveOrProfileReadAccess } from '../auth/request-access.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { route } from '../http/router.mjs';
import { consumeRateLimit, enforceRateLimit, sendTelemetryThrottled } from '../http/rate-limit.mjs';
import { resolvePoiId } from '../poi/catalog.mjs';
import { normalizeCheckinPhotoId, sendCheckinPhotoFile, storeCheckinPhoto } from '../photos/checkin-photos.mjs';
import { applyTravelPlausibility, normalizeCheckinCoordinateSystem } from '../trust/checkins.mjs';
import { buildArrivalEvidence, findStopForCheckin } from '../trust/arrival.mjs';
import {
  INTERNAL_EXPOSURE_ITEM_TYPES,
  PUBLIC_EXPOSURE_ITEM_TYPES,
  normalizeExposure,
  sanitizeExposureSurface,
  normalizeProductTelemetryId,
  persistProductClick,
  persistProductExposure
} from '../analytics/exposures.mjs';
import { buildProductAnalytics } from '../analytics/dashboard.mjs';
import { resolveProductAttribution } from '../content/cms.mjs';

export const checkinRoutes = [
  // rank13①：照片打卡上传，鉴权与 POST /api/checkins 同级（rate limit + owner headers）。
  route('POST', '/api/checkin-photos', async ({ req, res }) => {
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req, MAX_CHECKIN_PHOTO_REQUEST_BYTES);
    // 照片必须归属已注册身份：resolveWriteProfile 对缺失/anonymous profileId
    // 有早退（不会触发 requireRegistered），这里显式拦截，堵住匿名整体绕过。
    const requestedPhotoProfileId = normalizeProfileId(body?.profileId);
    if (!requestedPhotoProfileId || requestedPhotoProfileId === 'anonymous') {
      throw createHttpError('上传打卡照片需要已注册的个人资料，请先同步身份后重试', 403, 'PROFILE_NOT_REGISTERED');
    }
    const actor = await resolveWriteProfile(req, body?.profileId, { requireRegistered: true });
    if (!actor.verified || actor.profileId === 'anonymous') {
      throw createHttpError('上传打卡照片需要已注册的个人资料，请先同步身份后重试', 403, 'PROFILE_NOT_REGISTERED');
    }
    // 幂等键与打卡同款进程内互斥，避免并发双传各自反扫不到而重复落盘。
    const result = await withStorageEntityLock(
      'checkin',
      JSON.stringify(['photo', actor.profileId, sanitizePublicId(body?.routeId || body?.publicId), truncateString(body?.clientLocalId, 120)]),
      () => storeCheckinPhoto(body, actor)
    );
    return sendJson(res, 200, { ok: true, ...result });
  }),
  // rank13②：照片读取，强缓存（内容不可变）。
  route('GET', '/api/checkin-photos/:id', async ({ req, res, params }) => {
    enforceRateLimit(req, 'public-read');
    const photoId = safeDecodePathSegment(params.id);
    if (!CHECKIN_PHOTO_ID_PATTERN.test(photoId)) {
      throw createHttpError('照片不存在或已清理', 404, 'PHOTO_NOT_FOUND');
    }
    if (await sendCheckinPhotoFile(req, res, photoId)) return;
    throw createHttpError('照片不存在或已清理', 404, 'PHOTO_NOT_FOUND');
  }),
  route('POST', '/api/checkins', async ({ req, res }) => {
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId, { requireRegistered: true });
    const routeId = sanitizePublicId(body?.routeId || body?.publicId);
    const clientLocalId = truncateString(body?.clientLocalId, 120);
    const persistCheckin = async () => {
      if (clientLocalId) {
        const existing = await findLatestJsonLine(
          CHECKIN_LOG_PATH,
          (item) =>
            normalizeProfileId(item?.profileId) === actor.profileId && sanitizePublicId(item?.routeId) === routeId && item?.clientLocalId === clientLocalId
        );
        if (existing) return { checkin: existing, deduplicated: true };
      }
      const targetStop = await findStopForCheckin(body);
      const previousCheckin =
        actor.profileId !== 'anonymous'
          ? await findLatestJsonLine(CHECKIN_LOG_PATH, (item) => normalizeProfileId(item?.profileId) === actor.profileId && item?.gps)
          : null;
      const arrival = applyTravelPlausibility(
        buildArrivalEvidence(body, targetStop),
        body?.gps && typeof body.gps === 'object' ? body.gps : null,
        previousCheckin
      );
      const resolvedCity = body?.city ? normalizeCityName(body.city) : targetStop?.city ? normalizeCityName(targetStop.city) : '';
      // rank13③：持久化照片证据 ID；落库前校验照片行存在且归属当前 profile，
      // 不符则置空 photoId（photoEvidence 记 ownership-mismatch），防挂他人照片。
      let photoId = normalizeCheckinPhotoId(body?.photoId);
      let photoEvidence = '';
      if (photoId) {
        const photoRow = await findLatestJsonLine(CHECKIN_PHOTO_LOG_PATH, (item) => String(item?.id ?? '') === photoId).catch(() => null);
        if (!photoRow || normalizeProfileId(photoRow?.profileId) !== actor.profileId) {
          photoId = '';
          photoEvidence = 'ownership-mismatch';
        } else {
          const exifGps =
            photoRow?.exif && isValidCoordinate(Number(photoRow.exif.lat), Number(photoRow.exif.lng))
              ? { lat: Number(photoRow.exif.lat), lng: Number(photoRow.exif.lng) }
              : null;
          const photoDistance =
            exifGps && targetStop && isValidCoordinate(Number(targetStop.lat), Number(targetStop.lng)) ? distanceMeters(exifGps, targetStop) : null;
          photoEvidence = Number.isFinite(photoDistance) ? (photoDistance <= CHECKIN_PHOTO_GPS_MATCH_METERS ? 'gps-match' : 'gps-mismatch') : 'no-exif';
        }
      }
      const row = {
        id: cryptoRandomId(),
        trustState: actor.identityBound ? 'profile-attested' : actor.verified ? 'profile-owned' : 'untrusted',
        profileId: actor.profileId,
        routeId,
        clientLocalId,
        routeTitle: truncateString(body?.routeTitle, 80),
        city: resolvedCity,
        localStopKey: truncateString(targetStop?.localStopKey || targetStop?.id || body?.localStopKey, 120),
        stopId: truncateString(targetStop?.id || body?.stopId, 80),
        poiId: resolvePoiId(targetStop ?? { name: body?.stopName }, resolvedCity),
        stopName: truncateString(targetStop?.name || body?.stopName, 60),
        serverResolvedStop: targetStop?.serverResolved === true,
        status: ['visited', 'skipped', 'replaced'].includes(body?.status) ? body.status : 'visited',
        replacementStopId: truncateString(body?.replacementStopId, 80),
        worth: truncateString(body?.worth, 20),
        queue: truncateString(body?.queue, 40),
        cost: truncateString(body?.cost, 40),
        crowd: truncateString(body?.crowd, 20),
        comment: truncateString(body?.comment, 300),
        pitfall: truncateString(body?.pitfall, 200),
        audience: truncateString(body?.audience, 80),
        photoName: truncateString(body?.photoName, 160),
        photoId,
        ...(photoEvidence ? { photoEvidence } : {}),
        observedAt: truncateString(body?.time || body?.observedAt, 60),
        // rank18①：保留客户端上报的坐标系（白名单）与 userAgent（截 160）。
        gps:
          body?.gps && typeof body.gps === 'object'
            ? {
                lat: clampNumber(body.gps.lat, -90, 90, 0),
                lng: clampNumber(body.gps.lng, -180, 180, 0),
                accuracy: clampNumber(body.gps.accuracy, 0, 10000, 0),
                coordinateSystem: normalizeCheckinCoordinateSystem(body.gps.coordinateSystem)
              }
            : null,
        userAgent: truncateString(body?.gps?.userAgent || body?.userAgent, 160),
        arrival,
        arrivalConfidence: arrival.confidence,
        createdAt: new Date().toISOString()
      };
      await appendJsonLine(CHECKIN_LOG_PATH, row);
      return { checkin: row, deduplicated: false };
    };
    const result = clientLocalId
      ? await withStorageEntityLock('checkin', JSON.stringify([actor.profileId, routeId, clientLocalId]), persistCheckin)
      : await persistCheckin();
    return sendJson(res, 200, { ok: true, ...result });
  }),
  route('GET', '/api/checkins', async ({ req, res, url }) => {
    const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
    await verifySensitiveOrProfileReadAccess(req, profileId);
    const checkinLimit = clampNumber(url.searchParams.get('limit'), 1, 200, 50);
    // 按 profileId 谓词精确反扫，替代「全局尾窗 + filter」：热门时段其他用户的
    // 打卡会把当前用户的历史行挤出窗口，导致个人记录凭空消失。
    const checkins = profileId
      ? await readMatchingJsonLines(CHECKIN_LOG_PATH, (item) => normalizeProfileId(item?.profileId) === profileId, checkinLimit, 100000)
      : await readJsonLines(CHECKIN_LOG_PATH, checkinLimit);
    return sendJson(res, 200, { ok: true, checkins });
  }),
  route('POST', '/api/clicks', async ({ req, res }) => {
    // rank9：埋点类超限静默 204，不写库也不报错，避免客户端重试风暴。
    if (!consumeRateLimit(req, 'telemetry')) return sendTelemetryThrottled(req, res);
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const { product, derived, seedFallback } = await resolveProductAttribution(body);
    const row = {
      id: cryptoRandomId(),
      profileId: actor.profileId,
      sessionId: normalizeProductTelemetryId(body?.sessionId),
      exposureId: normalizeProductTelemetryId(body?.exposureId),
      surface: sanitizeExposureSurface(body?.surface || body?.sourcePosition || body?.source),
      routeId: sanitizePublicId(derived.routeId),
      routeTitle: truncateString(derived.routeTitle, 80),
      stopId: truncateString(body?.stopId, 40),
      stopName: truncateString(body?.stopName, 80),
      productId: product.id,
      productTitle: product.title,
      type: product.type,
      poi: product.poi,
      provider: product.provider,
      source: truncateString(body?.source, 40) || 'unknown',
      sourcePosition: truncateString(body?.sourcePosition, 40),
      url: product.url,
      creatorId: sanitizePublicId(derived.creatorId),
      // rank-seed：保留 linkType 供运营台识别；seed 兜底行单独归组。
      ...(truncateString(body?.linkType, 40) ? { linkType: truncateString(body.linkType, 40) } : {}),
      ...(seedFallback ? { analyticsSource: 'seed-fallback' } : {}),
      createdAt: new Date().toISOString()
    };
    return sendJson(res, 200, { ok: true, ...(await persistProductClick(row)) });
  }),
  route('POST', '/api/exposures', async ({ req, res }) => {
    // rank9：埋点类超限静默 204，不写库也不报错。
    if (!consumeRateLimit(req, 'telemetry')) return sendTelemetryThrottled(req, res);
    const body = await readJsonBody(req);
    // 曝光埋点防伪：itemType 走白名单；routebook-copy（含 copy-routebook
    // surface 伪装）只允许 /api/routebooks/:id/copy 内部落库。
    const requestedItemType = truncateString(body?.itemType || body?.type, 40) || 'routebook';
    if (INTERNAL_EXPOSURE_ITEM_TYPES.has(requestedItemType) || sanitizeExposureSurface(body?.surface) === 'copy-routebook') {
      throw createHttpError('路书复制事件只能由复制接口记录', 400, 'EXPOSURE_COPY_FORBIDDEN');
    }
    if (!PUBLIC_EXPOSURE_ITEM_TYPES.has(requestedItemType)) {
      throw createHttpError('曝光 itemType 不在白名单内', 400, 'EXPOSURE_ITEM_TYPE_INVALID');
    }
    const actor = await resolveWriteProfile(req, body?.profileId);
    const attributedBody = { ...body, profileId: actor.profileId };
    const row =
      attributedBody?.itemType === 'product' || attributedBody?.productId
        ? normalizeExposure(attributedBody, (await resolveProductAttribution(attributedBody)).derived)
        : normalizeExposure(attributedBody);
    if (row.itemType === 'product' && row.exposureId) return sendJson(res, 200, { ok: true, ...(await persistProductExposure(row)) });
    await appendJsonLine(EXPOSURE_LOG_PATH, row);
    return sendJson(res, 200, { ok: true, exposure: row, deduplicated: false });
  }),
  route('GET', '/api/clicks', async ({ req, res, url }) => {
    const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
    await verifySensitiveOrProfileReadAccess(req, profileId);
    const clickLimit = clampNumber(url.searchParams.get('limit'), 1, 200, 50);
    const clicks = profileId
      ? await readMatchingJsonLines(CLICK_LOG_PATH, (item) => normalizeProfileId(item?.profileId) === profileId, clickLimit, 100000)
      : await readJsonLines(CLICK_LOG_PATH, clickLimit);
    return sendJson(res, 200, { ok: true, clicks });
  }),
  route('GET', '/api/product-analytics', async ({ req, res, url }) => {
    const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
    await verifySensitiveOrProfileReadAccess(req, profileId);
    return sendJson(res, 200, {
      ok: true,
      analytics: await buildProductAnalytics(clampNumber(url.searchParams.get('limit'), 50, 2000, 500), profileId)
    });
  })
];

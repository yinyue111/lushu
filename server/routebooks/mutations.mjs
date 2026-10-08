// Routebook writes: drafts, publish, copy, status changes and variants.
import { createHttpError, truncateString, sanitizePublicId, normalizeCityName, clampNumber, isValidCoordinate, positiveInteger } from '../lib/util.mjs';
import { ROUTEBOOK_STATUSES, EXPOSURE_LOG_PATH, ROUTEBOOK_LOG_PATH } from '../config/index.mjs';
import { sanitizeEditToken, createRouteEditToken, normalizeProfileId, safeTokenEqual } from '../auth/tokens.mjs';
import { getSavedRoutebook } from '../storage/records.mjs';
import {
  normalizeCreator,
  normalizeRoutebookForStorage,
  getResolvableRoutebook,
  isCuratedRouteId,
  normalizeRouteVariant,
  normalizeRouteVariants,
  routebookValidationContext
} from './normalize.mjs';
import { appendVersionedRoutebook, routebookMutationMetadata, currentRoutebookVersion, assertExpectedRoutebookVersion } from './versions.mjs';
import { appendJsonLine, readJsonLines, withSingleProcessKeyLock } from '../storage/jsonl.mjs';
import { copyActorKey, isRoutebookCopyExposure } from './copies.mjs';
import { isPublicRoutebook } from './views.mjs';
import { normalizeExposure } from '../analytics/exposures.mjs';
import { normalizePoiName } from '../poi/catalog.mjs';
import { coordinateForName } from '../geo/normalize-coordinate.mjs';

export const routebookMutationLocks = new Map();

export async function updateRoutebookStatus(publicId, input) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  const publishStatus = truncateString(input?.publishStatus || input?.status, 40);
  if (publishStatus && !ROUTEBOOK_STATUSES.has(publishStatus)) {
    throw createHttpError('发布状态只能是 draft/published/featured/archived', 400, 'BAD_ROUTEBOOK_STATUS');
  }
  const nextStatus = publishStatus || routebook.publishStatus || 'draft';
  const versionMetadata = await routebookMutationMetadata(routebook, input, {
    changeReason: `运营状态变更：${routebook.publishStatus || 'draft'} -> ${nextStatus}`,
    actorType: 'admin'
  });
  const creator = input?.creator ? normalizeCreator(input.creator) : normalizeCreator(routebook.creator);
  const updated = normalizeRoutebookForStorage(
    {
      ...routebook,
      ...versionMetadata,
      editToken: sanitizeEditToken(routebook.editToken),
      publishStatus: nextStatus,
      sourceAuthorization: truncateString(input?.sourceAuthorization || creator.sourceAuthorization || routebook.sourceAuthorization, 40),
      creator,
      opsNote: truncateString(input?.opsNote, 400),
      provider: {
        ...(routebook.provider ?? {}),
        statusUpdatedAt: new Date().toISOString()
      }
    },
    routebook.publicId || routebook.id
  );
  const opsNote = truncateString(input?.opsNote, 400);
  await appendVersionedRoutebook(updated, 'status-changed', {
    previousStatus: routebook.publishStatus || 'draft',
    // normalizeRoutebookForStorage 不保留 opsNote 字段，运营备注写入审计明细。
    ...(opsNote ? { opsNote } : {})
  });
  return updated;
}

export async function copyRoutebook(publicId, input = {}) {
  const routebook = await getResolvableRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if (!isPublicRoutebook(routebook)) {
    throw createHttpError('路书尚未公开发布或已失效', 404, 'ROUTEBOOK_NOT_FOUND');
  }
  const routeId = sanitizePublicId(routebook.publicId || routebook.id);
  const actorKey = copyActorKey(input);
  const copyEvents = (await readJsonLines(EXPOSURE_LOG_PATH, 50000)).filter((event) => isRoutebookCopyExposure(event, routeId));
  const countedActors = new Set(copyEvents.map(copyActorKey).filter(Boolean));
  if (actorKey && !countedActors.has(actorKey)) {
    await appendJsonLine(EXPOSURE_LOG_PATH, {
      ...normalizeExposure({
        ...input,
        surface: input?.surface || 'copy-routebook',
        itemType: 'routebook-copy',
        itemId: routeId,
        routeId,
        routeTitle: routebook.title,
        city: routebook.city,
        creatorId: routebook.creator?.id
      }),
      // 标记服务端复制接口落库的合法来源；/api/exposures 已拒绝客户端直写此类型。
      copyAttribution: 'server-copy-endpoint'
    });
    countedActors.add(actorKey);
  }
  return { ...routebook, copyCount: countedActors.size };
}

function normalizeRoutebookDraftForStorage(input, existingRoutebook = null) {
  const profileId = normalizeProfileId(input?.profileId || existingRoutebook?.profileId);
  const hardenedInput = hardenDraftCoordinateProvenance(input, existingRoutebook);
  return normalizeRoutebookForStorage(
    {
      ...hardenedInput,
      profileId,
      creator: normalizeUserRouteCreator(hardenedInput, profileId),
      sourceAuthorization: 'user-generated',
      editToken: sanitizeEditToken(hardenedInput?.editToken) || sanitizeEditToken(existingRoutebook?.editToken) || createRouteEditToken(),
      publishStatus: 'draft',
      copyCount: existingRoutebook ? (existingRoutebook.copyCount ?? hardenedInput?.copyCount ?? 0) : 0
    },
    existingRoutebook ? existingRoutebook.publicId || existingRoutebook.id : ''
  );
}

/**
 * @param {Record<string, any>} [input]
 * @param {Record<string, any> | null} [existingRoutebook]
 * @returns {Record<string, any>}
 */
function hardenDraftCoordinateProvenance(input = {}, existingRoutebook = null) {
  const city = normalizeCityName(input?.city || existingRoutebook?.city);
  const existingStops = Array.isArray(existingRoutebook?.stops) ? existingRoutebook.stops : [];
  const variantsById = new Map((existingRoutebook?.variants ?? []).map((variant) => [String(variant?.id || variant?.mode || ''), variant]));
  return {
    ...input,
    stops: hardenDraftStops(input?.stops, existingStops, city),
    variants: Array.isArray(input?.variants)
      ? input.variants.map((variant) => {
          const existingVariant = variantsById.get(String(variant?.id || variant?.mode || ''));
          return {
            ...variant,
            stops: hardenDraftStops(variant?.stops, existingVariant?.stops ?? existingStops, city)
          };
        })
      : input?.variants
  };
}

function hardenDraftStops(stops, existingStops, city) {
  if (!Array.isArray(stops)) return stops;
  const existingById = new Map((existingStops ?? []).map((stop) => [String(stop?.id ?? ''), stop]).filter(([key]) => key));
  const existingByName = new Map((existingStops ?? []).map((stop) => [String(stop?.name ?? '').trim(), stop]).filter(([key]) => key));
  return stops.map((stop) => {
    const name = truncateString(stop?.name, 48);
    const canonical = coordinateForName(name, city);
    if (canonical) {
      return {
        ...stop,
        lat: canonical.lat,
        lng: canonical.lng,
        geoConfidence: canonical.confidence,
        coordinateSource: canonical.source,
        coordinatePrecision: canonical.precision,
        coordinateRadiusMeters: canonical.radiusMeters,
        navigationDisabled: canonical.navigationDisabled
      };
    }
    const existing = existingById.get(String(stop?.id ?? '')) ?? existingByName.get(name);
    // 站点改名后不回填旧 provenance：按 id+坐标命中但名称已变的站点，旧
    // geoConfidence/coordinateSource 描述的是旧 POI。新名字已在上方走过
    // coordinateForName（可信 POI 匹配），未命中则落入下方低置信降级分支。
    const existingNameMatches = existing ? normalizePoiName(existing?.name) === normalizePoiName(name) && Boolean(normalizePoiName(name)) : false;
    if (existing && existingNameMatches && coordinatesMatch(stop, existing)) {
      return {
        ...stop,
        geoConfidence: existing.geoConfidence,
        coordinateSource: existing.coordinateSource,
        coordinatePrecision: existing.coordinatePrecision,
        coordinateRadiusMeters: existing.coordinateRadiusMeters,
        navigationDisabled: existing.navigationDisabled === true
      };
    }
    if (!isValidCoordinate(Number(stop?.lat), Number(stop?.lng))) return stop;
    return {
      ...stop,
      geoConfidence: 45,
      coordinateSource: 'user-edit',
      coordinatePrecision: 'approximate',
      coordinateRadiusMeters: Math.max(1000, clampNumber(stop?.coordinateRadiusMeters, 1000, 100000, 1500)),
      navigationDisabled: true
    };
  });
}

function coordinatesMatch(left, right) {
  const leftLat = Number(left?.lat);
  const leftLng = Number(left?.lng);
  const rightLat = Number(right?.lat);
  const rightLng = Number(right?.lng);
  return (
    isValidCoordinate(leftLat, leftLng) &&
    isValidCoordinate(rightLat, rightLng) &&
    Math.abs(leftLat - rightLat) < 0.000001 &&
    Math.abs(leftLng - rightLng) < 0.000001
  );
}

export function normalizeUserRouteCreator(input = {}, profileId = '') {
  const creator = normalizeCreator(input?.creator);
  const id = normalizeProfileId(profileId || input?.profileId || creator.id);
  return {
    ...creator,
    id,
    name: creator.name === '可信路书编辑部' ? '匿名旅行者' : creator.name,
    sourceAuthorization: 'user-generated'
  };
}

function canOverwriteRoutebook(existingRoutebook, input) {
  if (!existingRoutebook) return true;
  const existingToken = sanitizeEditToken(existingRoutebook.editToken);
  if (existingToken) return safeTokenEqual(sanitizeEditToken(input?.editToken), existingToken);
  return false;
}

export async function ensureDraftEditToken(routebook) {
  if (!routebook || sanitizeEditToken(routebook.editToken) || (routebook.publishStatus || 'draft') !== 'draft') {
    return routebook;
  }
  const id = sanitizePublicId(routebook.publicId || routebook.id);
  if (!id) return routebook;
  // 并发读同一份无令牌历史草稿会补发多个不同 token：加互斥锁并在锁内重读
  // 最新快照，只有确认仍缺 token 时才补发一次。
  return withSingleProcessKeyLock(routebookMutationLocks, id, async () => {
    const latest = (await getSavedRoutebook(id)) ?? routebook;
    if (sanitizeEditToken(latest.editToken) || (latest.publishStatus || 'draft') !== 'draft') {
      return latest;
    }
    const currentVersion = await currentRoutebookVersion(id);
    const updated = normalizeRoutebookDraftForStorage(
      {
        ...latest,
        schemaVersion: positiveInteger(latest.schemaVersion, currentVersion ? 2 : 1),
        version: currentVersion || 1,
        parentVersion: positiveInteger(latest.parentVersion),
        editToken: createRouteEditToken(),
        editReason: '补发历史草稿编辑令牌',
        provider: {
          ...(latest.provider ?? {}),
          tokenMigratedAt: new Date().toISOString()
        }
      },
      latest
    );
    await appendJsonLine(ROUTEBOOK_LOG_PATH, updated);
    return updated;
  });
}

export async function saveDraftRoutebook(input) {
  const requestedId = sanitizePublicId(input?.id || input?.publicId);
  if (requestedId && isCuratedRouteId(requestedId)) {
    throw createHttpError('精选路书 ID 为只读保留标识，请先复制为新的个人草稿', 403, 'CURATED_ROUTE_ID_RESERVED');
  }
  const existing = requestedId ? await getSavedRoutebook(requestedId) : null;
  if (existing) {
    if ((existing.publishStatus || 'draft') !== 'draft') {
      throw createHttpError('公开、精选或归档路书不能通过普通保存接口覆盖', 403, 'ROUTEBOOK_PUBLISHED_OVERWRITE_FORBIDDEN');
    }
    if (!canOverwriteRoutebook(existing, input)) {
      throw createHttpError('不能覆盖其他用户或公开来源的路书', 403, 'ROUTEBOOK_OVERWRITE_FORBIDDEN');
    }
  }
  const versionMetadata = existing
    ? await routebookMutationMetadata(existing, input, {
        changeReason: truncateString(input?.editReason, 120) || '保存草稿',
        actorType: 'user'
      })
    : {
        schemaVersion: 2,
        version: 1,
        parentVersion: null,
        changeReason: truncateString(input?.changeReason || input?.editReason, 160) || '创建草稿',
        actorType: 'user'
      };
  if (!existing) assertExpectedRoutebookVersion(input, 0);
  return normalizeRoutebookDraftForStorage({ ...input, ...versionMetadata }, existing);
}

export async function publishOwnRoutebook(publicId, input = {}) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if ((routebook.publishStatus || 'draft') === 'archived') {
    throw createHttpError('归档路书不能直接发布，请在运营台恢复状态', 403, 'ROUTEBOOK_ARCHIVED');
  }
  if (!canOverwriteRoutebook(routebook, input)) {
    throw createHttpError('只能发布当前用户保存的路书', 403, 'ROUTEBOOK_OWNER_REQUIRED');
  }
  const versionMetadata = await routebookMutationMetadata(routebook, input, {
    changeReason: '用户发布路书',
    actorType: 'user'
  });
  if (routebook.publishStatus === 'published' || routebook.publishStatus === 'featured') {
    return routebook;
  }
  const profileId = normalizeProfileId(routebook.profileId || input?.profileId);
  const creator = normalizeUserRouteCreator(routebook, profileId);
  const updated = normalizeRoutebookForStorage(
    {
      ...routebook,
      ...versionMetadata,
      profileId,
      editToken: sanitizeEditToken(routebook.editToken),
      publishStatus: 'published',
      sourceAuthorization: 'user-generated',
      creator,
      provider: {
        ...(routebook.provider ?? {}),
        userPublishedAt: new Date().toISOString()
      }
    },
    routebook.publicId || routebook.id
  );
  await appendVersionedRoutebook(updated, 'published', {
    previousStatus: routebook.publishStatus || 'draft'
  });
  return updated;
}

export async function saveRoutebookVariant(publicId, input) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if ((routebook.publishStatus || 'draft') !== 'draft') {
    throw createHttpError('公开、精选或归档路书不能通过变体接口修改，请先定制为个人草稿', 403, 'ROUTEBOOK_VARIANT_FORBIDDEN');
  }
  if (!canOverwriteRoutebook(routebook, input)) {
    throw createHttpError('只能修改当前用户保存的草稿变体', 403, 'ROUTEBOOK_OWNER_REQUIRED');
  }
  const versionMetadata = await routebookMutationMetadata(routebook, input, {
    changeReason: '保存路线变体',
    actorType: 'user'
  });
  // 变体链复用草稿保存同款坐标溯源硬化：客户端声明的 geoConfidence /
  // coordinateSource / navigationDisabled 不再原样落库，按「可信 POI 命中 >
  // 服务端已存快照（同名同坐标）> 低置信降级」重新推导，堵住变体绕过缺口。
  const variantInput = input?.variant ?? input;
  const existingVariantsByKey = new Map((routebook.variants ?? []).map((item) => [String(item?.id || item?.mode || ''), item]));
  const existingVariant = existingVariantsByKey.get(String(variantInput?.id || variantInput?.mode || ''));
  const hardenedVariantInput = Array.isArray(variantInput?.stops)
    ? {
        ...variantInput,
        stops: hardenDraftStops(variantInput.stops, existingVariant?.stops ?? routebook.stops ?? [], normalizeCityName(routebook.city))
      }
    : variantInput;
  const variant = normalizeRouteVariant(hardenedVariantInput, 0, routebook.city, routebook.stops ?? [], routebookValidationContext(routebook));
  if (!variant) throw createHttpError('路线变体至少需要 2 个站点', 400, 'VARIANT_TOO_SHORT');
  const existingVariants = normalizeRouteVariants(routebook.variants, routebook.city, routebook.stops ?? [], routebookValidationContext(routebook)).filter(
    (item) => item.id !== variant.id && item.mode !== variant.mode
  );
  const updatedRoutebook = normalizeRoutebookForStorage(
    {
      ...routebook,
      ...versionMetadata,
      editToken: sanitizeEditToken(routebook.editToken),
      variants: [variant, ...existingVariants].slice(0, 8),
      activeVariantId: variant.id,
      editReason: `${variant.mode}变体`
    },
    routebook.publicId || routebook.id
  );
  await appendVersionedRoutebook(updatedRoutebook, 'variant-saved', {
    variantId: variant.id,
    variantMode: variant.mode
  });
  return { routebook: updatedRoutebook, variant };
}

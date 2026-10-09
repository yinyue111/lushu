// Routebook writes: drafts, publish, copy, status changes and variants.
import { createHttpError, truncateString, sanitizePublicId, normalizeCityName, clampNumber, isValidCoordinate, positiveInteger } from '../lib/util.mjs';
import { ROUTEBOOK_STATUSES, PUBLIC_ROUTE_STATUSES, EXPOSURE_LOG_PATH, ROUTEBOOK_LOG_PATH } from '../config/index.mjs';
import { sanitizeEditToken, createRouteEditToken, normalizeProfileId, safeTokenEqual, hashSecretToken } from '../auth/tokens.mjs';
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
import { appendJsonLine, readJsonLines } from '../storage/jsonl.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { copyActorKey, isRoutebookCopyExposure } from './copies.mjs';
import { hasFriendLinkAccess, isPublicRoutebook } from './views.mjs';
export { hasFriendLinkAccess };
import { randomBytes } from 'node:crypto';
import { normalizeExposure } from '../analytics/exposures.mjs';
import { normalizePoiName } from '../poi/catalog.mjs';
import { coordinateForName } from '../geo/normalize-coordinate.mjs';
import { normalizeStoredRouteLegs } from '../routing/provenance.mjs';
import { summarizeRouteExecution } from '../routing/routeExecution.mjs';
import { buildOpsAuditContext } from '../ops/audit.mjs';
import { sourcesPreventPublicStatus } from '../ops/sources.mjs';
import { routebookGuideOrigins } from '../../src/lib/importOrigins.js';
import { routebookPublicationPolicy } from './importPolicy.mjs';

export function requireVerifiedRoutingForPublicStatus(routebook, input = {}) {
  const routing = summarizeRouteExecution(
    routebook?.stops ?? [],
    normalizeStoredRouteLegs(routebook?.routeLegs, routebook?.stops, routebook?.constraints?.transport)
  );
  if (routing.expectedLegs === 0 || routing.allVerified) return { overridden: false, reason: '', routing };
  const reason = truncateString(input?.routingOverrideReason, 400);
  if (input?.allowUnverifiedRouting !== true || reason.length < 8) {
    throw createHttpError(
      `路书仍有 ${routing.unverifiedLegs}/${routing.expectedLegs} 段道路未核验，不能公开发布；例外发布需要管理员显式确认并填写原因`,
      409,
      'ROUTEBOOK_ROUTING_UNVERIFIED'
    );
  }
  return { overridden: true, reason, routing };
}

/**
 * Imported routebooks (links/OCR) stay unlisted unless the import policy allows public
 * listing. Screenshot (OCR) imports have no signed source ops could authorize, so ops
 * may only list them for an author who claimed authorship, with an audited note.
 * @param {Record<string, any>} routebook
 * @param {any} context
 * @param {Record<string, any>} input
 */
export function requireImportPublicationAllowed(routebook, context, input = {}) {
  const publication = routebookPublicationPolicy(routebook, context);
  if (publication.publicAllowed) return null;
  const note = truncateString(input?.importAuthorizationNote, 400).trim();
  if (publication.canClaimAuthorship && routebook?.authorshipClaim?.claimed === true && note.length >= 8) {
    return { origins: publication.origins, policy: publication.policy, note, authorshipClaim: routebook.authorshipClaim };
  }
  throw Object.assign(createHttpError(publication.reason, 409, 'IMPORTED_ROUTEBOOK_PUBLIC_DISABLED'), {
    details: { policy: publication.policy, origins: publication.origins, claimedAuthorship: routebook?.authorshipClaim?.claimed === true }
  });
}

export async function updateRoutebookStatus(publicId, input) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  const publishStatus = truncateString(input?.publishStatus || input?.status, 40);
  if (publishStatus && !ROUTEBOOK_STATUSES.has(publishStatus)) {
    throw createHttpError('路书状态不在允许范围内', 400, 'BAD_ROUTEBOOK_STATUS');
  }
  const nextStatus = publishStatus || routebook.publishStatus || 'draft';
  const versionMetadata = await routebookMutationMetadata(routebook, input, {
    changeReason: `运营状态变更：${routebook.publishStatus || 'draft'} -> ${nextStatus}`,
    actorType: 'admin'
  });
  const opsContext = PUBLIC_ROUTE_STATUSES.has(nextStatus) ? await buildOpsAuditContext() : null;
  if (opsContext && sourcesPreventPublicStatus(routebook, opsContext)) {
    throw createHttpError('导入来源尚未取得公开展示授权，不能公开发布', 409, 'SOURCE_PUBLIC_AUTHORIZATION_REQUIRED');
  }
  const importAuthorization = opsContext ? requireImportPublicationAllowed(routebook, opsContext, input) : null;
  const routingPublication = PUBLIC_ROUTE_STATUSES.has(nextStatus) ? requireVerifiedRoutingForPublicStatus(routebook, input) : null;
  const opsNote = truncateString(input?.opsNote || input?.changeReason, 400).trim();
  // Taking a public routebook down is only ever a manual ops decision, and it
  // must leave an audit note (re-checks and other automation never unpublish).
  if (PUBLIC_ROUTE_STATUSES.has(routebook.publishStatus) && !PUBLIC_ROUTE_STATUSES.has(nextStatus) && opsNote.length < 4) {
    throw createHttpError('下线已公开的路书需要填写运营备注（至少 4 个字），会写入审计记录', 400, 'UNPUBLISH_NOTE_REQUIRED');
  }
  const creator = input?.creator ? normalizeCreator(input.creator) : normalizeCreator(routebook.creator);
  const updated = normalizeRoutebookForStorage(
    {
      ...routebook,
      ...versionMetadata,
      editToken: sanitizeEditToken(routebook.editToken),
      publishStatus: nextStatus,
      sourceAuthorization: truncateString(input?.sourceAuthorization || creator.sourceAuthorization || routebook.sourceAuthorization, 40),
      creator,
      opsNote,
      provider: {
        ...(routebook.provider ?? {}),
        statusUpdatedAt: new Date().toISOString()
      }
    },
    routebook.publicId || routebook.id
  );
  await appendVersionedRoutebook(updated, 'status-changed', {
    previousStatus: routebook.publishStatus || 'draft',
    ...(routingPublication ? { routingPublication } : {}),
    ...(importAuthorization ? { importAuthorization } : {}),
    // normalizeRoutebookForStorage 不保留 opsNote 字段，运营备注写入审计明细。
    ...(opsNote ? { opsNote } : {})
  });
  return updated;
}

/**
 * Create (or keep) / revoke the owner's unlisted friend link. The key is generated
 * here and never accepted from a client.
 * @param {string} publicId
 * @param {Record<string, any>} input
 * @param {{ verifiedProfileId?: string, revoke?: boolean }} context
 */
export async function setRoutebookFriendLink(publicId, input = {}, context = {}) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if (!canOverwriteRoutebook(routebook, input, context)) {
    throw createHttpError('只能为自己保存的路书生成朋友链接', 403, 'ROUTEBOOK_OWNER_REQUIRED');
  }
  if (!context.revoke && (routebook.publishStatus || 'draft') === 'archived') {
    throw createHttpError('归档路书不能生成朋友链接', 403, 'ROUTEBOOK_ARCHIVED');
  }
  if (context.revoke ? !routebook.friendLink : routebook.friendLink) return { routebook, changed: false };
  const versionMetadata = await routebookMutationMetadata(routebook, input, {
    changeReason: context.revoke ? '停用朋友链接' : '生成朋友链接',
    actorType: 'user'
  });
  const updated = normalizeRoutebookForStorage(
    {
      ...routebook,
      ...versionMetadata,
      editToken: sanitizeEditToken(routebook.editToken),
      friendLink: context.revoke ? null : { key: randomBytes(16).toString('hex'), createdAt: new Date().toISOString() }
    },
    routebook.publicId || routebook.id
  );
  await appendVersionedRoutebook(updated, context.revoke ? 'friend-link-revoked' : 'friend-link-created', {
    previousStatus: routebook.publishStatus || 'draft'
  });
  return { routebook: updated, changed: true };
}

export async function copyRoutebook(publicId, input = {}) {
  const routebook = await getResolvableRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if (!isPublicRoutebook(routebook) && !hasFriendLinkAccess(routebook, input?.friendKey)) {
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
  // An edit token authorizes editing, never transferring a registered owner's
  // route to anonymous. Retaining the owner also preserves the deletion guard.
  const existingProfileId = normalizeProfileId(existingRoutebook?.profileId);
  const profileId = existingRoutebook && existingProfileId !== 'anonymous' ? existingProfileId : normalizeProfileId(input?.profileId);
  const hardenedInput = hardenDraftCoordinateProvenance(input, existingRoutebook);
  return normalizeRoutebookForStorage(
    {
      ...hardenedInput,
      profileId,
      creator: normalizeUserRouteCreator(hardenedInput, profileId),
      sourceAuthorization: 'user-generated',
      editToken:
        sanitizeEditToken(hardenedInput?.editToken) ||
        sanitizeEditToken(existingRoutebook?.editToken) ||
        (existingRoutebook?.editTokenHash ? '' : createRouteEditToken()),
      editTokenHash: existingRoutebook?.editTokenHash || '',
      publishStatus: 'draft',
      copyCount: existingRoutebook ? (existingRoutebook.copyCount ?? hardenedInput?.copyCount ?? 0) : 0,
      // Import provenance is sticky (a client cannot drop it to dodge the import policy);
      // friend links and authorship claims are only ever set by their own endpoints.
      guideOrigins: [...routebookGuideOrigins(existingRoutebook), ...routebookGuideOrigins(hardenedInput)],
      friendLink: existingRoutebook?.friendLink ?? null,
      authorshipClaim: existingRoutebook?.authorshipClaim ?? null
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

export function canOverwriteRoutebook(existingRoutebook, input, context = {}) {
  if (!existingRoutebook) return true;
  const verifiedProfileId = normalizeProfileId(context?.verifiedProfileId);
  if (verifiedProfileId !== 'anonymous' && verifiedProfileId === normalizeProfileId(existingRoutebook.profileId)) return true;
  const provided = sanitizeEditToken(input?.editToken);
  if (existingRoutebook.editTokenHash) return safeTokenEqual(hashSecretToken(provided), existingRoutebook.editTokenHash);
  const existingToken = sanitizeEditToken(existingRoutebook.editToken);
  if (existingToken) return safeTokenEqual(provided, existingToken);
  return false;
}

export async function ensureDraftEditToken(routebook) {
  if (!routebook || routebook.editTokenHash || sanitizeEditToken(routebook.editToken) || (routebook.publishStatus || 'draft') !== 'draft') {
    return routebook;
  }
  const id = sanitizePublicId(routebook.publicId || routebook.id);
  if (!id) return routebook;
  // 并发读同一份无令牌历史草稿会补发多个不同 token：加互斥锁并在锁内重读
  // 最新快照，只有确认仍缺 token 时才补发一次。
  return withStorageEntityLock('routebook', id, async () => {
    const latest = (await getSavedRoutebook(id)) ?? routebook;
    if (latest.editTokenHash || sanitizeEditToken(latest.editToken) || (latest.publishStatus || 'draft') !== 'draft') {
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

export async function saveDraftRoutebook(input, context = {}) {
  const requestedId = sanitizePublicId(input?.id || input?.publicId);
  if (requestedId && isCuratedRouteId(requestedId)) {
    throw createHttpError('精选路书 ID 为只读保留标识，请先复制为新的个人草稿', 403, 'CURATED_ROUTE_ID_RESERVED');
  }
  const existing = requestedId ? await getSavedRoutebook(requestedId) : null;
  if (existing) {
    if ((existing.publishStatus || 'draft') !== 'draft') {
      throw createHttpError('公开、精选或归档路书不能通过普通保存接口覆盖', 403, 'ROUTEBOOK_PUBLISHED_OVERWRITE_FORBIDDEN');
    }
    if (!canOverwriteRoutebook(existing, input, context)) {
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

export async function publishOwnRoutebook(publicId, input = {}, context = {}) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if ((routebook.publishStatus || 'draft') === 'archived') {
    throw createHttpError('归档路书不能直接发布，请在运营台恢复状态', 403, 'ROUTEBOOK_ARCHIVED');
  }
  if (!canOverwriteRoutebook(routebook, input, context)) {
    throw createHttpError('只能发布当前用户保存的路书', 403, 'ROUTEBOOK_OWNER_REQUIRED');
  }
  const versionMetadata = await routebookMutationMetadata(routebook, input, {
    changeReason: '用户提交路书审核',
    actorType: 'user'
  });
  if (['published', 'featured', 'pending_review'].includes(routebook.publishStatus)) {
    return routebook;
  }
  const publication = routebookPublicationPolicy(routebook, await buildOpsAuditContext());
  const claimNote = truncateString(input?.authorshipClaimNote, 200).trim();
  const claimsAuthorship = input?.claimOriginalAuthor === true && publication.canClaimAuthorship;
  if (!publication.publicAllowed && !claimsAuthorship) {
    throw Object.assign(createHttpError(publication.reason, 409, 'IMPORTED_ROUTEBOOK_PUBLIC_DISABLED'), {
      details: { policy: publication.policy, origins: publication.origins, canClaimAuthorship: publication.canClaimAuthorship }
    });
  }
  const profileId = normalizeProfileId(routebook.profileId || input?.profileId);
  const creator = normalizeUserRouteCreator(routebook, profileId);
  const updated = normalizeRoutebookForStorage(
    {
      ...routebook,
      ...versionMetadata,
      profileId,
      editToken: sanitizeEditToken(routebook.editToken),
      publishStatus: 'pending_review',
      sourceAuthorization: 'user-generated',
      creator,
      ...(claimsAuthorship ? { authorshipClaim: { claimed: true, claimedAt: new Date().toISOString(), note: claimNote } } : {}),
      provider: {
        ...(routebook.provider ?? {}),
        userPublishedAt: new Date().toISOString()
      }
    },
    routebook.publicId || routebook.id
  );
  await appendVersionedRoutebook(updated, 'submitted-for-review', {
    previousStatus: routebook.publishStatus || 'draft',
    ...(claimsAuthorship ? { authorshipClaim: updated.authorshipClaim, importOrigins: publication.origins } : {})
  });
  return updated;
}

export async function saveRoutebookVariant(publicId, input, context = {}) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if ((routebook.publishStatus || 'draft') !== 'draft') {
    throw createHttpError('公开、精选或归档路书不能通过变体接口修改，请先定制为个人草稿', 403, 'ROUTEBOOK_VARIANT_FORBIDDEN');
  }
  if (!canOverwriteRoutebook(routebook, input, context)) {
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

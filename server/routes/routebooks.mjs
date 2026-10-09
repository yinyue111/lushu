// Routebook, share, creator and favorite API routes.
import { clampNumber, createHttpError, normalizeCityName, positiveInteger, safeDecodePathSegment, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { compareRowsDesc, decodeCursor, encodeCursor, isAfterCursor } from '../ops/paging.mjs';
import { ALLOW_LOCAL_ADMIN_BYPASS, FAVORITE_LOG_PATH, PUBLIC_ROUTE_STATUSES } from '../config/index.mjs';
import { appendJsonLine, readJsonLines, readMatchingJsonLines } from '../storage/jsonl.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { cryptoRandomId, normalizeProfileId, safeTokenEqual, sanitizeEditToken, hashSecretToken } from '../auth/tokens.mjs';
import {
  hasAdminAccess,
  isLocalRequest,
  resolveWriteProfile,
  verifyAdminAccess,
  verifyProfileReadAccess,
  verifySensitiveOrProfileReadAccess,
  verifySensitiveReadAccess
} from '../auth/request-access.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { route } from '../http/router.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { getCuratedRoutebook, getResolvableRoutebook, isCuratedRouteId } from '../routebooks/normalize.mjs';
import { listSavedRoutebooks } from '../routebooks/list.mjs';
import { buildRouteFeedbackContext, enrichRoutebook } from '../trust/feedback.mjs';
import { appendVersionedRoutebook, listRoutebookAudits, listRoutebookVersionRows } from '../routebooks/versions.mjs';
import { isPublicRoutebook, publicRoutebookView } from '../routebooks/views.mjs';
import { moderateAndQueue } from '../moderation/index.mjs';
import {
  copyRoutebook,
  ensureDraftEditToken,
  publishOwnRoutebook,
  saveDraftRoutebook,
  saveRoutebookVariant,
  updateRoutebookStatus
} from '../routebooks/mutations.mjs';
import { buildCreatorProfile, buildPlatformDashboard } from '../analytics/dashboard.mjs';

export const routebookRoutes = [
  route('GET', '/api/routebooks', async ({ req, res, url }) => {
    enforceRateLimit(req, 'public-read');
    const city = url.searchParams.get('city') ? normalizeCityName(url.searchParams.get('city')) : '';
    const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
    const statuses = String(url.searchParams.get('status') ?? '')
      .split(',')
      .map((item) => truncateString(item.trim(), 40))
      .filter(Boolean);
    const allRequestedStatusesPublic = statuses.length > 0 && statuses.every((status) => PUBLIC_ROUTE_STATUSES.has(status));
    const privilegedRead = (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) || hasAdminAccess(req);
    if (profileId) {
      await verifySensitiveOrProfileReadAccess(req, profileId);
    } else if (!privilegedRead && !allRequestedStatusesPublic) {
      verifyAdminAccess(req);
    }
    // H4: filter while scanning so `limit` counts matching routebooks, not the global window.
    // F17: optional keyset cursor over (updatedAt, id) of each routebook's latest row.
    const pageLimit = clampNumber(url.searchParams.get('limit') || undefined, 1, 200, 100);
    const position = decodeCursor(url.searchParams.get('cursor') || '');
    const scanned = await listSavedRoutebooks(
      pageLimit + 1,
      (routebook) =>
        (!city || routebook.city === city) &&
        (!profileId || normalizeProfileId(routebook.profileId) === profileId) &&
        (!statuses.length || statuses.includes(routebook.publishStatus || 'draft')) &&
        // Anonymous public listings skip routebooks withheld by moderation.
        (privilegedRead || profileId || !allRequestedStatusesPublic || isPublicRoutebook(routebook)) &&
        isAfterCursor({ ...routebook, id: routebook.publicId || routebook.id }, position)
    );
    const ordered = scanned.sort((left, right) => compareRowsDesc({ ...left, id: left.publicId || left.id }, { ...right, id: right.publicId || right.id }));
    const filtered = ordered.slice(0, pageLimit);
    const lastRow = filtered.at(-1);
    const nextCursor = ordered.length > pageLimit && lastRow ? encodeCursor({ ...lastRow, id: lastRow.publicId || lastRow.id }) : '';
    // rank23①：列表路径先一次性读齐 5 份 JSONL，逐路书 enrich 时传引用复用。
    const feedbackContext = filtered.length ? await buildRouteFeedbackContext() : null;
    const enrichedRoutebooks = await Promise.all(filtered.map((routebook) => enrichRoutebook(routebook, feedbackContext)));
    const publicList = !privilegedRead && allRequestedStatusesPublic && !profileId;
    return sendJson(res, 200, {
      ok: true,
      routebooks: publicList
        ? enrichedRoutebooks.map(publicRoutebookView)
        : enrichedRoutebooks.map((routebook) => ({ ...routebook, ownerAccessVerified: Boolean(profileId) })),
      nextCursor,
      hasMore: Boolean(nextCursor)
    });
  }),
  route('GET', '/api/dashboard', async ({ req, res, url }) => {
    verifySensitiveReadAccess(req);
    return sendJson(res, 200, {
      ok: true,
      dashboard: await buildPlatformDashboard(clampNumber(url.searchParams.get('limit') || undefined, 100, 2000, 1000))
    });
  }),
  route('GET', '/api/creators/:id', async ({ req, res, params }) => {
    enforceRateLimit(req, 'public-read');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    if (!id) throw createHttpError('达人 ID 不合法', 400, 'CREATOR_ID_REQUIRED');
    return sendJson(res, 200, {
      ok: true,
      profile: await buildCreatorProfile(id)
    });
  }),
  route('POST', '/api/routebooks/:id/status', async ({ req, res, params }) => {
    enforceRateLimit(req, 'core-write');
    verifyAdminAccess(req);
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const routebook = await withStorageEntityLock('routebook', id, () => updateRoutebookStatus(id, body));
    return sendJson(res, 200, {
      ok: true,
      routebook: await enrichRoutebook(routebook)
    });
  }),
  route('POST', '/api/routebooks/:id/publish', async ({ req, res, params }) => {
    enforceRateLimit(req, 'core-write');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const routebook = await withStorageEntityLock('routebook', id, () =>
      publishOwnRoutebook(id, body, { verifiedProfileId: actor.verified ? actor.profileId : '' })
    );
    // Content safety when submitted for publication: flagged routebooks stay private until
    // ops approve them, even if their publish status later becomes public.
    const moderation =
      routebook?.publishStatus && routebook.publishStatus !== 'draft'
        ? await moderateAndQueue({
            entityType: 'routebook',
            entityId: sanitizePublicId(routebook.publicId || routebook.id),
            profileId: normalizeProfileId(routebook.profileId),
            scene: 'routebook',
            fields: {
              title: String(routebook.title ?? ''),
              summary: String(routebook.summary ?? ''),
              stops: (routebook.stops ?? []).map((stop) => [stop?.name, stop?.note, stop?.tip].filter(Boolean).join(' ')).join('\n')
            }
          })
        : { status: null };
    return sendJson(res, 200, {
      ok: true,
      routebook: await enrichRoutebook(routebook),
      shareUrl: isPublicRoutebook(routebook) ? `/share/${routebook.publicId}` : '',
      ...(moderation.status && moderation.status !== 'passed' ? { moderation: { status: moderation.status } } : {})
    });
  }),
  route('POST', '/api/routebooks/:id/copy', async ({ req, res, params }) => {
    enforceRateLimit(req, 'core-write');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const routebook = await withStorageEntityLock('routebook', id, () => copyRoutebook(id, { ...body, profileId: actor.profileId }));
    const enriched = await enrichRoutebook(routebook);
    return sendJson(res, 200, {
      ok: true,
      routebook: publicRoutebookView(enriched),
      copyCount: enriched.copyCount ?? 0
    });
  }),
  route('GET', '/api/routebooks/:id/versions', async ({ req, res, params }) => {
    verifyAdminAccess(req);
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    let versions = await listRoutebookVersionRows(id);
    if (!versions.length) {
      const curated = getCuratedRoutebook(id);
      if (!curated) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
      versions = [
        {
          schemaVersion: positiveInteger(curated.schemaVersion, 2),
          version: positiveInteger(curated.version, 1),
          parentVersion: positiveInteger(curated.parentVersion),
          derived: false,
          snapshotOrdinal: 1,
          routebookId: id,
          title: curated.title,
          city: curated.city,
          publishStatus: curated.publishStatus,
          changeReason: curated.changeReason,
          actorType: curated.actorType,
          createdAt: curated.createdAt,
          updatedAt: curated.updatedAt,
          publishedAt: curated.publishedAt,
          archivedAt: curated.archivedAt
        }
      ];
    }
    const audits = await listRoutebookAudits(id);
    return sendJson(res, 200, {
      ok: true,
      routebookId: id,
      currentVersion: versions.at(-1)?.version ?? null,
      versions,
      audits
    });
  }),
  route('GET', '/api/routebooks/:id', async ({ req, res, params }) => {
    // 单路书详情要做全文件反扫 + enrich，读放大明显，挂公共读桶防刷。
    enforceRateLimit(req, 'public-read');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const savedRoutebook = await getResolvableRoutebook(id);
    if (!savedRoutebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
    const privilegedRead = (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) || hasAdminAccess(req);
    const ownerRead =
      !privilegedRead && normalizeProfileId(savedRoutebook.profileId) !== 'anonymous' ? await verifyProfileReadAccess(req, savedRoutebook.profileId) : false;
    // 匿名持有编辑令牌的用户刷新页面后仍可恢复自己的草稿：
    // x-routebook-edit-token 与存储 editToken 匹配时按 owner 读处理。
    const requestedEditToken = sanitizeEditToken(req.headers['x-routebook-edit-token']);
    const storedEditToken = sanitizeEditToken(savedRoutebook.editToken);
    const editTokenRead = Boolean(
      !privilegedRead &&
      !ownerRead &&
      requestedEditToken &&
      (savedRoutebook.editTokenHash
        ? safeTokenEqual(hashSecretToken(requestedEditToken), savedRoutebook.editTokenHash)
        : storedEditToken && safeTokenEqual(requestedEditToken, storedEditToken))
    );
    if (!privilegedRead && !ownerRead && !editTokenRead && !isPublicRoutebook(savedRoutebook)) {
      throw createHttpError('路书不存在或尚未公开发布', 404, 'ROUTEBOOK_NOT_FOUND');
    }
    const privateRead = !isCuratedRouteId(id) && (privilegedRead || ownerRead || editTokenRead);
    const routebook = await enrichRoutebook(privateRead ? await ensureDraftEditToken(savedRoutebook) : savedRoutebook);
    return sendJson(res, 200, { ok: true, routebook: privateRead ? { ...routebook, ownerAccessVerified: true } : publicRoutebookView(routebook) });
  }),
  route('POST', '/api/routebooks/:id/variants', async ({ req, res, params }) => {
    enforceRateLimit(req, 'core-write');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const result = await withStorageEntityLock('routebook', id, () =>
      saveRoutebookVariant(id, body, { verifiedProfileId: actor.verified ? actor.profileId : '' })
    );
    return sendJson(res, 200, {
      ok: true,
      routebook: await enrichRoutebook(result.routebook),
      variant: result.variant
    });
  }),
  route('POST', '/api/routebooks', async ({ req, res }) => {
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const lockKey = sanitizePublicId(body?.id || body?.publicId) || `new:${/** @type {any} */ (req).requestId}`;
    const { routebook, enriched } = await withStorageEntityLock('routebook', lockKey, async () => {
      const savedRoutebook = await saveDraftRoutebook({ ...body, profileId: actor.profileId }, { verifiedProfileId: actor.verified ? actor.profileId : '' });
      await appendVersionedRoutebook(savedRoutebook, savedRoutebook.parentVersion ? 'draft-saved' : 'created');
      return { routebook: savedRoutebook, enriched: await enrichRoutebook(savedRoutebook) };
    });
    return sendJson(res, 200, {
      ok: true,
      routebook: { ...enriched, ownerAccessVerified: actor.verified },
      shareUrl: isPublicRoutebook(routebook) ? `/share/${routebook.publicId}` : ''
    });
  }),
  route('GET', '/api/share/:id', async ({ req, res, params }) => {
    enforceRateLimit(req, 'public-read');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const routebook = await enrichRoutebook(await getResolvableRoutebook(id));
    if (!routebook || !isPublicRoutebook(routebook)) {
      throw createHttpError('分享路书不存在或已失效', 404, 'SHARE_NOT_FOUND');
    }
    const publicRoutebook = publicRoutebookView(routebook);
    return sendJson(res, 200, {
      ok: true,
      routebook: publicRoutebook,
      share: {
        publicId: publicRoutebook.publicId,
        title: publicRoutebook.title,
        city: publicRoutebook.city,
        trustScore: publicRoutebook.trustScore,
        updatedAt: publicRoutebook.updatedAt
      }
    });
  }),
  route('POST', '/api/favorites', async ({ req, res }) => {
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const row = {
      id: cryptoRandomId(),
      profileId: actor.profileId,
      routeId: sanitizePublicId(body?.routeId || body?.publicId),
      routeTitle: truncateString(body?.routeTitle || body?.title, 100),
      city: body?.city ? normalizeCityName(body.city) : '',
      source: truncateString(body?.source, 40) || 'user',
      creatorId: sanitizePublicId(body?.creatorId),
      createdAt: new Date().toISOString()
    };
    await appendJsonLine(FAVORITE_LOG_PATH, row);
    return sendJson(res, 200, { ok: true, favorite: row });
  }),
  // F14: un-favorite appends a tombstone (the log stays append-only and auditable).
  route('DELETE', '/api/favorites', async ({ req, res }) => {
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const routeId = sanitizePublicId(body?.routeId || body?.publicId);
    if (!routeId) throw createHttpError('缺少要取消收藏的路线', 400, 'FAVORITE_ROUTE_REQUIRED');
    const row = { id: cryptoRandomId(), type: 'favorite-removed', profileId: actor.profileId, routeId, createdAt: new Date().toISOString() };
    await appendJsonLine(FAVORITE_LOG_PATH, row);
    return sendJson(res, 200, { ok: true, removed: { routeId, removedAt: row.createdAt } });
  }),
  route('GET', '/api/favorites', async ({ req, res, url }) => {
    const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
    await verifySensitiveOrProfileReadAccess(req, profileId);
    const favoriteLimit = clampNumber(url.searchParams.get('limit') || undefined, 1, 200, 80);
    const rows = profileId
      ? await readMatchingJsonLines(FAVORITE_LOG_PATH, (item) => normalizeProfileId(item?.profileId) === profileId, 100000, 100000)
      : await readJsonLines(FAVORITE_LOG_PATH, 100000);
    return sendJson(res, 200, { ok: true, favorites: activeFavorites(rows).slice(0, favoriteLimit) });
  })
];

/**
 * Newest-first favorites with removed routes dropped: a tombstone hides every
 * earlier favorite row for the same profile + route; a later re-favorite shows again.
 * Repeated favorites of one route collapse to the newest.
 * @param {any[]} rows newest first
 */
export function activeFavorites(rows) {
  const decided = new Set();
  const active = [];
  for (const row of rows ?? []) {
    const key = `${normalizeProfileId(row?.profileId)}|${sanitizePublicId(row?.routeId)}`;
    if (row?.type === 'favorite-removed') {
      decided.add(key);
      continue;
    }
    if (sanitizePublicId(row?.routeId)) {
      if (decided.has(key)) continue;
      decided.add(key);
    }
    active.push(row);
  }
  return active;
}

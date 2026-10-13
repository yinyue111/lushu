// Routebook, share, creator and favorite API routes.
import { clampNumber, createHttpError, normalizeCityName, positiveInteger, safeDecodePathSegment, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { recordFunnelEvent } from '../analytics/funnelEvents.mjs';
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
  verifySensitiveReadAccess,
  requireLoginForWrites,
  requestAccount
} from '../auth/request-access.mjs';
import { accountProfileIds } from '../accounts/service.mjs';
import { enqueueEnrichment, enrichmentView, reportEnrichment } from '../enrich/service.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { route } from '../http/router.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { getCuratedRoutebook, getResolvableRoutebook, isCuratedRouteId } from '../routebooks/normalize.mjs';
import { listSavedRoutebooks } from '../routebooks/list.mjs';
import { getSavedRoutebook } from '../storage/records.mjs';
import { deletedRoutebookIds, isDeletedRoutebook, routebookDeletedError } from '../routebooks/tombstones.mjs';
import { appendJsonLine as appendRoutebookRow } from '../storage/jsonl.mjs';
import { ROUTEBOOK_AUDIT_LOG_PATH, ROUTEBOOK_LOG_PATH } from '../config/index.mjs';
import { buildRouteFeedbackContext, enrichRoutebook } from '../trust/feedback.mjs';
import { appendVersionedRoutebook, listRoutebookAudits, listRoutebookVersionRows } from '../routebooks/versions.mjs';
import { isPublicRoutebook, publicRoutebookView } from '../routebooks/views.mjs';
import { moderateAndQueue } from '../moderation/index.mjs';
import { routebookPublicationPolicy } from '../routebooks/importPolicy.mjs';
import { buildOpsAuditContext } from '../ops/audit.mjs';
import {
  copyRoutebook,
  hasFriendLinkAccess,
  setRoutebookFriendLink,
  ensureDraftEditToken,
  publishOwnRoutebook,
  saveDraftRoutebook,
  saveRoutebookVariant,
  updateRoutebookStatus
} from '../routebooks/mutations.mjs';
import { buildCreatorProfile, buildPlatformDashboard } from '../analytics/dashboard.mjs';
import { proposeDayPatch } from '../ai/patchRoutebook.mjs';
import { enforcePatchQuota, peekPatchQuota } from '../ai/generationGuard.mjs';

/**
 * Owner-only fields: what the import publishing policy allows for this routebook and
 * the friend-link URL (the key itself is only ever handed back to the owner).
 * @param {Record<string, any>} routebook
 */
async function ownerPublicationFields(routebook) {
  const id = routebook?.publicId || routebook?.id;
  return {
    publication: routebookPublicationPolicy(routebook, await buildOpsAuditContext()),
    friendShareUrl: routebook?.friendLink?.key && id ? `/share/${encodeURIComponent(id)}?k=${routebook.friendLink.key}` : ''
  };
}

/**
 * @param {string} method
 */
function friendLinkRoute(method) {
  return route(method, '/api/routebooks/:id/friend-link', async ({ req, res, params }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'core-write');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const revoke = method === 'DELETE';
    const { routebook, changed } = await withStorageEntityLock('routebook', id, () =>
      setRoutebookFriendLink(id, body, { verifiedProfileId: actor.verified ? actor.profileId : '', revoke })
    );
    // Friend links still go through content safety: flagged routebooks stay closed.
    if (!revoke && changed) {
      await moderateAndQueue({
        entityType: 'routebook',
        entityId: sanitizePublicId(routebook.publicId || routebook.id),
        profileId: normalizeProfileId(routebook.profileId),
        scene: 'routebook',
        fields: {
          title: String(routebook.title ?? ''),
          summary: String(routebook.summary ?? ''),
          stops: (routebook.stops ?? []).map((stop) => [stop?.name, stop?.note, stop?.tip].filter(Boolean).join(' ')).join('\n')
        }
      });
    }
    const enriched = await enrichRoutebook(routebook);
    const owner = await ownerPublicationFields(routebook);
    return sendJson(res, 200, {
      ok: true,
      routebook: { ...enriched, ...owner, ownerAccessVerified: actor.verified },
      friendShareUrl: hasFriendLinkAccess(routebook, routebook.friendLink?.key) ? owner.friendShareUrl : ''
    });
  });
}

async function readableRoutebook(req, rawId) {
  const id = sanitizePublicId(safeDecodePathSegment(rawId));
  const savedRoutebook = await getResolvableRoutebook(id);
  if (!savedRoutebook) {
    const latest = isCuratedRouteId(id) ? null : await getSavedRoutebook(id);
    if (isDeletedRoutebook(latest)) throw routebookDeletedError(id, latest);
    throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  }
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
  return { id, savedRoutebook, privateRead };
}

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
    // Signed in and asking for the account's own profile: list every profile the account owns
    // (claimed device profiles too), so "我的路书" is the same on every device.
    let ownedProfiles = profileId ? new Set([profileId]) : null;
    if (profileId) {
      await verifySensitiveOrProfileReadAccess(req, profileId);
      const account = await requestAccount(req);
      if (account && account.user.primaryProfileId === profileId) ownedProfiles = new Set(await accountProfileIds(account.user));
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
        (!ownedProfiles || ownedProfiles.has(normalizeProfileId(routebook.profileId))) &&
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
    await requireLoginForWrites(req);
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
      routebook: { ...(await enrichRoutebook(routebook)), ...(await ownerPublicationFields(routebook)) },
      shareUrl: isPublicRoutebook(routebook) ? `/share/${routebook.publicId}` : '',
      ...(moderation.status && moderation.status !== 'passed' ? { moderation: { status: moderation.status } } : {})
    });
  }),
  route('POST', '/api/routebooks/:id/copy', async ({ req, res, params }) => {
    await requireLoginForWrites(req);
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
  // Clients send the ids of their local copies; deleted ones come back so the device drops them.
  // Ids are random UUIDs; the answer only says "deleted", never who owned it or what it contained.
  route('POST', '/api/routebooks/deleted', async ({ req, res }) => {
    enforceRateLimit(req, 'public-read');
    const body = await readJsonBody(req);
    const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 300) : [];
    return sendJson(res, 200, { ok: true, deleted: await deletedRoutebookIds(ids) });
  }),
  // Owner deletes a saved routebook (cloud copy). Append-only: a new version carrying deletedAt;
  // listings, reads and exports skip it. Public share links stop working.
  route('DELETE', '/api/routebooks/:id', async ({ req, res, params }) => {
    enforceRateLimit(req, 'core-write');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    if (!id || isCuratedRouteId(id)) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
    const result = await withStorageEntityLock('routebook', id, async () => {
      const current = await getSavedRoutebook(id);
      if (!current || current.tombstone || current.deletedAt) return { deleted: false, alreadyGone: true };
      const owner = normalizeProfileId(current.profileId);
      const ownerOk = owner !== 'anonymous' && (await verifyProfileReadAccess(req, owner));
      const editToken = sanitizeEditToken(req.headers['x-routebook-edit-token']);
      const tokenOk = owner === 'anonymous' && editToken && current.editTokenHash && safeTokenEqual(hashSecretToken(editToken), current.editTokenHash);
      if (!ownerOk && !tokenOk) throw createHttpError('只能删除自己的路书', 403, 'ROUTEBOOK_DELETE_FORBIDDEN');
      const version = Math.max(1, Number(current.version) || 1);
      const now = new Date().toISOString();
      // Content-free tombstone: owner profile + id. The routebook body is not kept in the new row.
      const tombstone = {
        id,
        publicId: id,
        tombstone: true,
        deletedAt: now,
        updatedAt: now,
        profileId: owner,
        deletedBy: 'owner',
        version: version + 1,
        parentVersion: version,
        actorType: 'user',
        changeReason: '用户删除'
      };
      await appendRoutebookRow(ROUTEBOOK_LOG_PATH, tombstone, { expectedVersion: version });
      await appendRoutebookRow(ROUTEBOOK_AUDIT_LOG_PATH, { ...tombstone, routebookId: id, event: 'deleted-by-owner', createdAt: now });
      return { deleted: true };
    });
    return sendJson(res, 200, { ok: true, id, ...result });
  }),
  route('GET', '/api/routebooks/:id', async ({ req, res, params }) => {
    // 单路书详情要做全文件反扫 + enrich，读放大明显，挂公共读桶防刷。
    enforceRateLimit(req, 'public-read');
    const { savedRoutebook, privateRead } = await readableRoutebook(req, params.id);
    const routebook = await enrichRoutebook(privateRead ? await ensureDraftEditToken(savedRoutebook) : savedRoutebook);
    return sendJson(res, 200, {
      ok: true,
      routebook: privateRead ? { ...routebook, ...(await ownerPublicationFields(routebook)), ownerAccessVerified: true } : publicRoutebookView(routebook)
    });
  }),
  route('GET', '/api/routebooks/:id/enrichment', async ({ req, res, params }) => {
    // 联网补全（门票/开放时间）的结果：和路书详情同样的读权限。
    enforceRateLimit(req, 'public-read');
    const { savedRoutebook } = await readableRoutebook(req, params.id);
    return sendJson(res, 200, { ok: true, enrichment: await enrichmentView(savedRoutebook) });
  }),
  route('POST', '/api/routebooks/:id/enrichment/report', async ({ req, res, params }) => {
    enforceRateLimit(req, 'core-write');
    const { id } = await readableRoutebook(req, params.id);
    const body = await readJsonBody(req);
    const field = String(body?.field ?? '');
    if (!['price', 'hours'].includes(field)) throw createHttpError('反馈的内容不支持', 400, 'BAD_ENRICHMENT_FIELD');
    const account = await requestAccount(req).catch(() => null);
    const result = await reportEnrichment({
      routebookId: id,
      stopKey: truncateString(body?.stopKey, 80),
      field,
      note: truncateString(body?.note, 300),
      userId: account?.user?.id ?? null
    });
    if (!result.ok) throw createHttpError('这条信息已经不在了', 404, 'ENRICHMENT_NOT_FOUND');
    return sendJson(res, 200, { ok: true });
  }),

  route('POST', '/api/routebooks/:id/patch/propose', async ({ req, res, params }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'ai');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    await enforcePatchQuota(actor.profileId);
    const current = await getResolvableRoutebook(id);
    if (isCuratedRouteId(id)) throw createHttpError('精选路书请先复制定制再调整', 400, 'CURATED_READONLY');
    if (!current) throw createHttpError('路书不存在', 404, 'ROUTEBOOK_NOT_FOUND');
    const owned = current.profileId === actor.profileId || current.creator?.id === actor.profileId;
    if (!owned && !actor.verified) throw createHttpError('只能调整自己的草稿路书', 403, 'FORBIDDEN');
    if ((current.publishStatus || 'draft') !== 'draft') throw createHttpError('已发布路书请先另存草稿再局部调整', 400, 'NOT_DRAFT');
    const scope = {
      type: body?.scope?.type === 'window' ? 'window' : 'day',
      day: truncateString(body?.scope?.day || body?.day, 24),
      stopIds: Array.isArray(body?.scope?.stopIds) ? body.scope.stopIds.map(String).slice(0, 8) : undefined,
      instruction: truncateString(body?.instruction, 400),
      mode: body?.mode === 'deep' ? 'deep' : 'fast'
    };
    const { proposal, routebookPreview } = await proposeDayPatch(current, scope, {
      profileId: actor.profileId,
      signal: req.signal,
      requestId: /** @type {any} */ (req).requestId
    });
    const peek = await peekPatchQuota(actor.profileId);
    return sendJson(res, 200, {
      ok: true,
      proposal,
      preview: { stops: routebookPreview.stops, days: routebookPreview.days, routeLegs: routebookPreview.routeLegs },
      patchQuota: peek
    });
  }),
  route('POST', '/api/routebooks/:id/patch/apply', async ({ req, res, params }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'core-write');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const proposal = body?.proposal;
    if (!proposal?.stops?.length) throw createHttpError('缺少已确认的调整方案', 400, 'PATCH_REQUIRED');
    const { routebook, enriched } = await withStorageEntityLock('routebook', id, async () => {
      const saved = await saveDraftRoutebook(
        {
          ...proposal,
          id,
          publicId: id,
          profileId: actor.profileId,
          editToken: body?.editToken,
          title: body?.title,
          summary: body?.summary,
          city: body?.city,
          publishStatus: 'draft',
          provider: { ...(body?.provider || {}), editedAt: new Date().toISOString(), patchId: proposal.id }
        },
        { verifiedProfileId: actor.verified ? actor.profileId : '' }
      );
      // Prefer client-merged fields from proposal
      const merged = {
        ...saved,
        stops: proposal.stops,
        days: proposal.days || saved.days,
        routeLegs: proposal.routeLegs || saved.routeLegs,
        validations: [
          {
            id: `patch-${proposal.id}`,
            label: '局部调整',
            state: '已应用',
            detail: proposal.summary || '已应用 AI 局部重排，请出发前再核对。'
          },
          ...(saved.validations || []).slice(0, 5)
        ]
      };
      const again = await saveDraftRoutebook(merged, { verifiedProfileId: actor.verified ? actor.profileId : '' });
      await appendVersionedRoutebook(again, 'patch-applied', proposal.summary || '');
      return { routebook: again, enriched: await enrichRoutebook(again) };
    });
    return sendJson(res, 200, {
      ok: true,
      routebook: { ...enriched, ...(await ownerPublicationFields(routebook)), ownerAccessVerified: actor.verified }
    });
  }),
  route('POST', '/api/routebooks/:id/variants', async ({ req, res, params }) => {
    await requireLoginForWrites(req);
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
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'core-write');
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const lockKey = sanitizePublicId(body?.id || body?.publicId) || `new:${/** @type {any} */ (req).requestId}`;
    const { routebook, enriched, renamedStops } = await withStorageEntityLock('routebook', lockKey, async () => {
      const previous = body?.id || body?.publicId ? await getSavedRoutebook(sanitizePublicId(body.id || body.publicId)).catch(() => null) : null;
      const savedRoutebook = await saveDraftRoutebook({ ...body, profileId: actor.profileId }, { verifiedProfileId: actor.verified ? actor.profileId : '' });
      await appendVersionedRoutebook(savedRoutebook, savedRoutebook.parentVersion ? 'draft-saved' : 'created');
      const previousNames = new Set((previous?.stops ?? []).map((stop) => String(stop.name ?? '').trim()));
      const renamed = Boolean(previous) && (savedRoutebook.stops ?? []).some((stop) => !previousNames.has(String(stop.name ?? '').trim()));
      return { routebook: savedRoutebook, enriched: await enrichRoutebook(savedRoutebook), renamedStops: renamed };
    });
    // 换店、改名后重新排队补全（只对登录用户；新站点的门票/开放时间重新查，不沿用旧店）。
    if (renamedStops) {
      const account = await requestAccount(req).catch(() => null);
      if (account?.user?.id) void enqueueEnrichment({ routebookId: routebook.publicId || routebook.id, userId: account.user.id, refresh: true });
    }
    return sendJson(res, 200, {
      ok: true,
      routebook: { ...enriched, ...(await ownerPublicationFields(routebook)), ownerAccessVerified: actor.verified },
      shareUrl: isPublicRoutebook(routebook) ? `/share/${routebook.publicId}` : ''
    });
  }),
  friendLinkRoute('POST'),
  friendLinkRoute('DELETE'),
  route('GET', '/api/share/:id', async ({ req, res, params, url }) => {
    enforceRateLimit(req, 'public-read');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const routebook = await enrichRoutebook(await getResolvableRoutebook(id));
    const listed = Boolean(routebook) && isPublicRoutebook(routebook);
    // Unlisted friend link: same redacted view, never listed and never indexed.
    const unlisted = !listed && hasFriendLinkAccess(routebook, url.searchParams.get('k'));
    if (!routebook || (!listed && !unlisted)) {
      throw createHttpError('分享路书不存在或已失效', 404, 'SHARE_NOT_FOUND');
    }
    if (unlisted) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    void recordFunnelEvent('share_open', { ref: id });
    const publicRoutebook = { ...publicRoutebookView(routebook), visibility: unlisted ? 'unlisted' : 'public' };
    return sendJson(res, 200, {
      ok: true,
      routebook: publicRoutebook,
      share: {
        visibility: publicRoutebook.visibility,
        publicId: publicRoutebook.publicId,
        title: publicRoutebook.title,
        city: publicRoutebook.city,
        trustScore: publicRoutebook.trustScore,
        updatedAt: publicRoutebook.updatedAt
      }
    });
  }),
  route('POST', '/api/favorites', async ({ req, res }) => {
    await requireLoginForWrites(req);
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
    await requireLoginForWrites(req);
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

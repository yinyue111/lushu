// Routebook, share, creator and favorite API routes.
import { clampNumber, createHttpError, normalizeCityName, positiveInteger, safeDecodePathSegment, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { recordFunnelEvent } from '../analytics/funnelEvents.mjs';
import { compareRowsDesc, decodeCursor, encodeCursor, isAfterCursor } from '../ops/paging.mjs';
import { ALLOW_LOCAL_ADMIN_BYPASS, FAVORITE_LOG_PATH, PUBLIC_ROUTE_STATUSES, TRIP_SESSION_LOG_PATH } from '../config/index.mjs';
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
import { accountEmail, accountProfileIds } from '../accounts/service.mjs';
import { sendMail } from '../mail/transport.mjs';
import { enqueueEnrichment, enrichmentView, reportEnrichment } from '../enrich/service.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { route } from '../http/router.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { getCuratedRoutebook, getResolvableRoutebook, isCuratedRouteId, normalizeConfirmAcks, normalizeExpenseLedger } from '../routebooks/normalize.mjs';
import { listSavedRoutebooks } from '../routebooks/list.mjs';
import { getSavedRoutebook } from '../storage/records.mjs';
import { deletedRoutebookIds, isDeletedRoutebook, routebookDeletedError } from '../routebooks/tombstones.mjs';
import { appendJsonLine as appendRoutebookRow } from '../storage/jsonl.mjs';
import { ROUTEBOOK_AUDIT_LOG_PATH, ROUTEBOOK_LOG_PATH } from '../config/index.mjs';
import { buildRouteFeedbackContext, enrichRoutebook } from '../trust/feedback.mjs';
import { appendVersionedRoutebook, listRoutebookAudits, listRoutebookVersionRows } from '../routebooks/versions.mjs';
import { isPublicRoutebook, publicRoutebookView } from '../routebooks/views.mjs';
import { modernOwnerRoutebookCopy } from '../lib/termCopy.mjs';
import { isModerationWithheld, moderateAndQueue } from '../moderation/index.mjs';
import { routebookPublicationPolicy } from '../routebooks/importPolicy.mjs';
import { buildOpsAuditContext } from '../ops/audit.mjs';
import {
  copyRoutebook,
  hasFriendLinkAccess,
  setRoutebookConfirmAcks,
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

const COMPANION_VOTE_VALUES = new Set(['want', 'ok', 'skip']);
const MAX_COMPANIONS_PER_LINK = 16;

function companionLinkGeneration(friendKey) {
  const key = String(friendKey ?? '').trim();
  if (!/^[a-f0-9]{32}$/.test(key)) return '';
  return hashSecretToken(`companion-link:${key}`).slice(0, 16);
}

function companionModerationEntityId(routeId, linkGen, companionId) {
  return sanitizePublicId(`comp-${routeId}-${linkGen}-${companionId}`);
}

function normalizeCompanionExpenses(rawExpenses, defaultPayer) {
  if (!Array.isArray(rawExpenses)) return [];
  const list = [];
  for (const item of rawExpenses.slice(0, 40)) {
    const amount = Math.round(Number(item?.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) continue;
    const id =
      String(item?.id ?? '')
        .trim()
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, 40) || `cexp_${cryptoRandomId().slice(0, 12)}`;
    const title = truncateString(String(item?.title ?? '').trim(), 40) || '同行共同开销';
    const paidBy = truncateString(String(item?.paidBy ?? '').trim(), 20) || defaultPayer;
    const splitWith = Array.isArray(item?.splitWith)
      ? [...new Set(item.splitWith.map((x) => truncateString(String(x ?? '').trim(), 20)).filter(Boolean))].slice(0, 12)
      : [];
    const createdAt = Number.isFinite(Date.parse(String(item?.createdAt ?? ''))) ? new Date(item.createdAt).toISOString() : new Date().toISOString();
    list.push({ id, title, amount, paidBy, splitWith, createdAt });
  }
  return list;
}

function normalizeCompanionSubmission(body = {}) {
  const rawId = String(body?.companionId ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 48);
  const companionId = rawId.length >= 6 ? rawId : `comp_${cryptoRandomId().slice(0, 16)}`;
  const nickname = truncateString(String(body?.nickname ?? '').trim(), 20) || '同行伙伴';
  const votes = {};
  if (body?.votes && typeof body.votes === 'object') {
    for (const [k, v] of Object.entries(body.votes).slice(0, 50)) {
      const stopKey = truncateString(String(k ?? '').trim(), 48);
      if (stopKey && COMPANION_VOTE_VALUES.has(v)) votes[stopKey] = v;
    }
  }
  const claims = Array.isArray(body?.claims)
    ? [...new Set(body.claims.map((x) => truncateString(String(x ?? '').trim(), 64)).filter(Boolean))].slice(0, 60)
    : [];
  const expenses = normalizeCompanionExpenses(body?.expenses, nickname);
  const visitedStopIds = Array.isArray(body?.visitedStopIds)
    ? [...new Set(body.visitedStopIds.map((x) => truncateString(String(x ?? '').trim(), 64)).filter(Boolean))].slice(0, 50)
    : [];
  return { companionId, nickname, votes, claims, expenses, visitedStopIds };
}

async function readCompanionFeedback(routeId, activeFriendKey = '') {
  const cleanId = sanitizePublicId(routeId);
  const linkGen = companionLinkGeneration(activeFriendKey);
  if (!cleanId || !linkGen) return [];
  const rows = await readMatchingJsonLines(
    TRIP_SESSION_LOG_PATH,
    (item) => item?.kind === 'companion-feedback' && sanitizePublicId(item?.routeId) === cleanId && item?.linkGen === linkGen,
    500,
    50000
  );
  const seen = new Set();
  const active = [];
  for (const row of rows) {
    const cid = String(row?.companionId ?? '').trim();
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    const modId = companionModerationEntityId(cleanId, linkGen, cid);
    const withheld = isModerationWithheld('companion', modId);
    const safeNickname = withheld ? '同行伙伴' : truncateString(row.nickname, 20) || '同行伙伴';
    const rawExpenses = Array.isArray(row.expenses) ? row.expenses.slice(0, 40) : [];
    const safeExpenses = withheld ? rawExpenses.map((exp) => ({ ...exp, title: '同行分摊项', paidBy: safeNickname })) : rawExpenses;
    active.push({
      companionId: cid,
      nickname: safeNickname,
      moderationWithheld: withheld,
      votes: row.votes && typeof row.votes === 'object' ? row.votes : {},
      claims: Array.isArray(row.claims) ? row.claims.slice(0, 60) : [],
      expenses: safeExpenses,
      visitedStopIds: Array.isArray(row.visitedStopIds) ? row.visitedStopIds.slice(0, 50) : [],
      updatedAt: truncateString(row.updatedAt, 60)
    });
    if (active.length >= MAX_COMPANIONS_PER_LINK) break;
  }
  return active;
}

async function readOwnerExpenseLedger(routeId) {
  const cleanId = sanitizePublicId(routeId);
  if (!cleanId) return { travelers: [], extraExpenses: [] };
  const rows = await readMatchingJsonLines(
    TRIP_SESSION_LOG_PATH,
    (item) => item?.kind === 'expense-ledger' && sanitizePublicId(item?.routeId) === cleanId,
    1,
    50000
  );
  return rows[0] ? normalizeExpenseLedger(rows[0].expenseLedger) : { travelers: [], extraExpenses: [] };
}

/**
 * Owner-only fields: what the import publishing policy allows for this routebook and
 * the friend-link URL (the key itself is only ever handed back to the owner).
 * @param {Record<string, any>} routebook
 */
async function ownerPublicationFields(routebook) {
  const id = routebook?.publicId || routebook?.id;
  const activeKey = routebook?.friendLink?.key || '';
  return {
    publication: routebookPublicationPolicy(routebook, await buildOpsAuditContext()),
    friendShareUrl: activeKey && id ? `/share/${encodeURIComponent(id)}?k=${activeKey}` : '',
    expenseLedger: id ? await readOwnerExpenseLedger(id) : normalizeExpenseLedger(routebook?.expenseLedger),
    companions: id && activeKey ? await readCompanionFeedback(id, activeKey) : []
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
      routebook: modernOwnerRoutebookCopy({ ...enriched, ...owner, ownerAccessVerified: actor.verified }),
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
        : enrichedRoutebooks.map((routebook) => modernOwnerRoutebookCopy({ ...routebook, ownerAccessVerified: Boolean(profileId) })),
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
      routebook: modernOwnerRoutebookCopy(await enrichRoutebook(routebook))
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
      routebook: modernOwnerRoutebookCopy({ ...(await enrichRoutebook(routebook)), ...(await ownerPublicationFields(routebook)) }),
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
      routebook: privateRead
        ? modernOwnerRoutebookCopy({ ...routebook, ...(await ownerPublicationFields(routebook)), ownerAccessVerified: true })
        : publicRoutebookView(routebook)
    });
  }),
  route('GET', '/api/routebooks/:id/enrichment', async ({ req, res, params }) => {
    // 联网核对（门票/开放时间）的结果：和路书详情同样的读权限。
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
    return sendJson(res, 200, { ok: true, receiptId: result.receiptId, already: Boolean(result.already) });
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
      type: body?.scope?.type === 'all' ? 'all' : body?.scope?.type === 'window' ? 'window' : 'day',
      day: truncateString(body?.scope?.day || body?.day, 24),
      stopIds: Array.isArray(body?.scope?.stopIds) ? body.scope.stopIds.map(String).slice(0, 8) : undefined,
      instruction: truncateString(body?.instruction, 400),
      mode: body?.mode === 'deep' ? 'deep' : 'fast'
    };
    const { proposal, routebookPreview } = await proposeDayPatch(current, scope, {
      profileId: actor.profileId,
      signal: /** @type {any} */ (req).signal,
      requestId: /** @type {any} */ (req).requestId
    });
    const peek = await peekPatchQuota(actor.profileId);
    return sendJson(res, 200, {
      ok: true,
      proposal,
      preview: { stops: routebookPreview.stops, days: routebookPreview.days, routeLegs: /** @type {any} */ (routebookPreview).routeLegs },
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
          // 乐观锁：客户端带上它看到的版本，别人在中间改过就 409，而不是悄悄覆盖。
          expectedVersion: body?.expectedVersion,
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
      const again = await saveDraftRoutebook(
        { ...merged, editToken: body?.editToken, expectedVersion: body?.expectedVersion },
        { verifiedProfileId: actor.verified ? actor.profileId : '' }
      );
      await appendVersionedRoutebook(again, 'patch-applied', proposal.summary || '');
      return { routebook: again, enriched: await enrichRoutebook(again) };
    });
    return sendJson(res, 200, {
      ok: true,
      routebook: modernOwnerRoutebookCopy({ ...enriched, ...(await ownerPublicationFields(routebook)), ownerAccessVerified: actor.verified })
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
      routebook: modernOwnerRoutebookCopy(await enrichRoutebook(result.routebook)),
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
    // 换店、改名后重新排队核对（只对登录用户；新站点的门票/开放时间重新查，不沿用旧店）。
    if (renamedStops) {
      const account = await requestAccount(req).catch(() => null);
      if (account?.user?.id) void enqueueEnrichment({ routebookId: routebook.publicId || routebook.id, userId: account.user.id, refresh: true });
    }
    return sendJson(res, 200, {
      ok: true,
      routebook: modernOwnerRoutebookCopy({ ...enriched, ...(await ownerPublicationFields(routebook)), ownerAccessVerified: actor.verified }),
      shareUrl: isPublicRoutebook(routebook) ? `/share/${routebook.publicId}` : ''
    });
  }),
  friendLinkRoute('POST'),
  friendLinkRoute('DELETE'),
  route('POST', '/api/routebooks/:id/confirm-acks', async ({ req, res, params }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'core-write');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const { routebook } = await withStorageEntityLock('routebook', id, () =>
      setRoutebookConfirmAcks(id, body, { verifiedProfileId: actor.verified ? actor.profileId : '' })
    );
    return sendJson(res, 200, {
      ok: true,
      confirmAcks: normalizeConfirmAcks(routebook.confirmAcks),
      version: routebook.version
    });
  }),
  route('POST', '/api/routebooks/:id/expenses', async ({ req, res, params }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'core-write');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const actor = await resolveWriteProfile(req, body?.profileId);
    const saved = await getSavedRoutebook(id);
    if (!saved || isDeletedRoutebook(saved)) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
    const ownerProfileId = normalizeProfileId(saved.profileId);
    if (!actor.verified || ownerProfileId !== actor.profileId) {
      throw createHttpError('只能更新自己路书的同行账本', 403, 'ROUTEBOOK_OWNER_REQUIRED');
    }
    const expenseLedger = normalizeExpenseLedger(body?.expenseLedger ?? body);
    await withStorageEntityLock('expense-ledger', id, () =>
      appendJsonLine(TRIP_SESSION_LOG_PATH, {
        id: cryptoRandomId(),
        kind: 'expense-ledger',
        sessionKey: `expense-ledger:${id}`,
        routeId: id,
        profileId: ownerProfileId,
        expenseLedger,
        updatedAt: new Date().toISOString()
      })
    );
    return sendJson(res, 200, {
      ok: true,
      expenseLedger
    });
  }),
  route('POST', '/api/routebooks/:id/reminder-email', async ({ req, res, params }) => {
    await requireLoginForWrites(req);
    enforceRateLimit(req, 'core-write');
    const account = await requestAccount(req);
    if (!account?.user) throw createHttpError('请先登录账号', 401, 'LOGIN_REQUIRED');
    const to = accountEmail(account.user);
    if (!to) throw createHttpError('当前账号尚未绑定邮箱，请先在「我的 → 账号」绑定邮箱，或使用日历文件提醒', 409, 'REMINDER_EMAIL_MISSING');
    const { savedRoutebook } = await readableRoutebook(req, params.id);
    const travelDate = savedRoutebook.travelDate || savedRoutebook.constraints?.date || '待定日期';
    const stops = Array.isArray(savedRoutebook.stops) ? savedRoutebook.stops : [];
    const bookingNames = stops
      .filter((s) => /预约|博物院|博物馆|拙政园|中山陵|总统府/.test(`${s?.name ?? ''}${s?.verify ?? ''}${s?.risk ?? ''}`))
      .map((s) => s.name);
    const lines = [
      `你的路书「${savedRoutebook.title || savedRoutebook.city}」出发前备忘清单：`,
      '',
      `• 目的地：${savedRoutebook.city || '—'}`,
      `• 计划出发日期：${travelDate}`,
      ...(savedRoutebook.constraints?.arrivalTime || savedRoutebook.constraints?.arrivalHub
        ? [`• 首日到达：${savedRoutebook.constraints.arrivalTime || ''} ${savedRoutebook.constraints.arrivalHub || ''}`.trim()]
        : []),
      ...(savedRoutebook.constraints?.departureTime || savedRoutebook.constraints?.departureHub
        ? [
            `• 末日返程：${savedRoutebook.constraints.departureTime || ''} ${savedRoutebook.constraints.departureHub || ''}（建议提前 75 分钟动身去车站）`.trim()
          ]
        : []),
      ...(bookingNames.length ? [`• 建议提前关注预约/闭馆：${bookingNames.join('、')}`] : []),
      '',
      '站点概览：',
      ...stops.slice(0, 16).map((s, idx) => `${idx + 1}. [${s.day || 'Day 1'} ${s.time || ''}] ${s.name}`),
      '',
      '—— 可信路书（系统自动发送，无需回复）'
    ];
    await sendMail({
      to,
      kind: 'trip-reminder',
      subject: `出发准备备忘：${savedRoutebook.city || ''} · ${savedRoutebook.title || '路书'}`,
      text: lines.join('\n')
    });
    return sendJson(res, 200, { ok: true, sentTo: account.user.emailMasked || '已绑定邮箱' });
  }),
  route('GET', '/api/share/:id', async ({ req, res, params, url }) => {
    enforceRateLimit(req, 'public-read');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const routebook = await enrichRoutebook(await getResolvableRoutebook(id));
    const listed = Boolean(routebook) && isPublicRoutebook(routebook);
    const friendKey = url.searchParams.get('k') || '';
    const unlisted = !listed && hasFriendLinkAccess(routebook, friendKey);
    if (!routebook || (!listed && !unlisted)) {
      throw createHttpError('分享路书不存在或已失效', 404, 'SHARE_NOT_FOUND');
    }
    if (unlisted) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    // 记在分享者名下，漏斗最后一步才是「这个人分享的东西被打开了」。
    void recordFunnelEvent('share_open', { ref: id, profileId: routebook.profileId || '' });
    const publicRoutebook = {
      ...publicRoutebookView(routebook),
      visibility: unlisted ? 'unlisted' : 'public',
      ...(unlisted
        ? {
            confirmAcks: normalizeConfirmAcks(routebook.confirmAcks),
            expenseLedger: await readOwnerExpenseLedger(id),
            companions: await readCompanionFeedback(id, friendKey)
          }
        : {})
    };
    // 分享页也显示核对过的门票/开放时间和附带条件（只含已填的值、来源域名和原文摘句）。
    const enrichment = await enrichmentView(routebook).catch(() => null);
    return sendJson(res, 200, {
      ok: true,
      routebook: publicRoutebook,
      enrichedFacts: (enrichment?.claims ?? []).map(({ stopName, field, display, conditions, sources }) => ({
        stopName,
        field,
        display,
        conditions,
        domains: [...new Set((sources ?? []).map((x) => x.domain))]
      })),
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
  route('POST', '/api/share/:id/companion', async ({ req, res, params, url }) => {
    enforceRateLimit(req, 'core-write');
    const id = sanitizePublicId(safeDecodePathSegment(params.id));
    const body = await readJsonBody(req);
    const friendKey = url.searchParams.get('k') || String(body?.friendKey ?? '');
    const routebook = await getResolvableRoutebook(id);
    if (!routebook || !hasFriendLinkAccess(routebook, friendKey)) {
      throw createHttpError('朋友分享链接不存在或已失效', 404, 'SHARE_NOT_FOUND');
    }
    const linkGen = companionLinkGeneration(friendKey);
    const clean = normalizeCompanionSubmission(body);
    const ownerProfileId = normalizeProfileId(routebook.profileId);
    const modEntityId = companionModerationEntityId(id, linkGen, clean.companionId);
    await withStorageEntityLock('companion-feedback', id, async () => {
      const currentList = await readCompanionFeedback(id, friendKey);
      const isExistingCompanion = currentList.some((item) => item.companionId === clean.companionId);
      if (!isExistingCompanion && currentList.length >= MAX_COMPANIONS_PER_LINK) {
        throw createHttpError(`当前同行表态人数已满（最多 ${MAX_COMPANIONS_PER_LINK} 人）`, 409, 'COMPANION_LIMIT_REACHED');
      }
      await moderateAndQueue({
        entityType: 'companion',
        entityId: modEntityId,
        profileId: ownerProfileId,
        scene: 'companion',
        fields: {
          nickname: clean.nickname,
          expenses: clean.expenses.map((item) => `${item.title} ${item.paidBy}`).join('\n')
        }
      });
      const now = new Date().toISOString();
      const row = {
        id: cryptoRandomId(),
        kind: 'companion-feedback',
        sessionKey: `companion:${id}:${linkGen}:${clean.companionId}`,
        routeId: id,
        profileId: ownerProfileId,
        linkGen,
        ...clean,
        updatedAt: now
      };
      await appendJsonLine(TRIP_SESSION_LOG_PATH, row);
    });
    return sendJson(res, 200, {
      ok: true,
      companionId: clean.companionId,
      companions: await readCompanionFeedback(id, friendKey)
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

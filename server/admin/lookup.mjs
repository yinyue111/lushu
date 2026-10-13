// User & roadbook lookup for the admin console (PRD P4/P5). Never returns passwords, recovery codes or tokens.
import { AI_LOG_PATH, GENERATION_QUOTA_WINDOW_MS, AUTH_ENABLED } from '../config/index.mjs';
import { getConfig } from '../config/runtime.mjs';
import { readMatchingJsonLines } from '../storage/jsonl.mjs';
import { opsListUsers, opsUpdateUser, accountEmail } from '../accounts/service.mjs';
import { accountStore } from '../accounts/store.mjs';
import { issueRecoveryCodes } from '../accounts/recovery.mjs';
import { sendMail } from '../mail/transport.mjs';
import { getSavedRoutebook } from '../storage/records.mjs';
import { listSavedRoutebooks } from '../routebooks/list.mjs';
import { isPublicRoutebook } from '../routebooks/views.mjs';
import { currentRoutebookVersion } from '../routebooks/versions.mjs';
import { updateRoutebookStatus, adminRevokeFriendLink } from '../routebooks/mutations.mjs';
import { enrichStore } from '../enrich/store.mjs';
import { enqueueEnrichment } from '../enrich/service.mjs';
import { rowConsumesQuota } from '../ai/generationGuard.mjs';
import { adminStore } from './store.mjs';
import { adminAudit } from './audit.mjs';
import { createHttpError } from './util.mjs';
import { sanitizePublicId } from '../lib/util.mjs';

function requireReason(reason) {
  const text = String(reason ?? '').trim();
  if (text.length < 4) throw createHttpError('请写明原因（至少 4 个字）', 400, 'ADMIN_REASON_REQUIRED');
  return text.slice(0, 300);
}

async function usedInWindow(profileId) {
  const resetAt = Date.parse((await adminStore().quotaResetAt(profileId)) ?? '') || 0;
  const since = Math.max(Date.now() - GENERATION_QUOTA_WINDOW_MS, resetAt);
  const rows = await readMatchingJsonLines(
    AI_LOG_PATH,
    (row) => row?.kind === 'generate-routebook' && row?.profileId === profileId && rowConsumesQuota(row) && Date.parse(row?.createdAt ?? '') >= since,
    5000,
    50000
  );
  return rows.length;
}

export async function searchUsers(query) {
  if (!AUTH_ENABLED) return { enabled: false, users: [] };
  const users = await opsListUsers({ query, limit: 50 });
  // opsListUsers already returns masked email/phone only; strip anything credential-like defensively.
  const out = [];
  for (const u of users) {
    const { recoveryCodesLeft: _r, ...safe } = u;
    out.push({ ...safe, usedInWindow: await usedInWindow(u.profileId), windowHours: Math.round(GENERATION_QUOTA_WINDOW_MS / 3600000) });
  }
  return { enabled: true, users: out };
}

/**
 * @param {{ admin: any, req: any, userId: string, action: string, reason: string, quota?: number|string|null }} input
 */
export async function updateUser({ admin, req, userId, action, reason, quota }) {
  const why = requireReason(reason);
  const id = sanitizePublicId(userId);
  const user = await accountStore().getUser(id);
  if (!user || user.status === 'deleted') throw createHttpError('账号不存在', 404, 'ACCOUNT_NOT_FOUND');
  const actor = `admin:${admin.username}`;
  if (action === 'ban' || action === 'unban') {
    const result = await opsUpdateUser(req, id, { action: action === 'ban' ? 'disable' : 'enable', reason: why }, actor);
    await adminAudit(req, {
      admin,
      action: `user.${action}`,
      target: `user:${id}`,
      before: { status: user.status },
      after: { status: result.user.status },
      reason: why
    });
    return { user: result.user };
  }
  if (action === 'set-quota') {
    const max = getConfig('admin.operatorQuotaMax');
    const value = quota === null || quota === '' ? null : Number(quota);
    if (admin.role !== 'admin' && (value === null || value > max)) throw createHttpError(`运营单人额度最多改到 ${max}`, 403, 'ADMIN_QUOTA_CAP');
    const result = await opsUpdateUser(req, id, { action: 'set-quota', quota: value, reason: why }, actor);
    await adminAudit(req, {
      admin,
      action: 'user.set-quota',
      target: `user:${id}`,
      before: { quota: user.generationQuota ?? null },
      after: { quota: value },
      reason: why
    });
    return { user: result.user };
  }
  if (action === 'reset-quota') {
    const now = new Date().toISOString();
    await adminStore().setQuotaReset(user.primaryProfileId, now, admin.username);
    await adminAudit(req, { admin, action: 'user.reset-quota', target: `user:${id}`, after: { resetAt: now }, reason: why });
    return { ok: true, resetAt: now };
  }
  if (action === 'send-recovery') {
    // PRD Q4 default: the code goes ONLY to the user's verified email; the operator never sees it.
    const to = user.emailVerifiedAt ? accountEmail(user) : '';
    if (!to) throw createHttpError('这个账号没有已验证的邮箱，不能发恢复码', 409, 'ADMIN_NO_VERIFIED_EMAIL');
    const { codes, hashes } = issueRecoveryCodes(1, 'ops');
    await accountStore().updateUser(id, { recoveryHashes: [...(user.recoveryHashes ?? []), ...hashes] });
    await sendMail({
      to,
      kind: 'ops-recovery',
      subject: '你的路书恢复码',
      text: `应你的请求，我们为你的路书账号补发了 1 个恢复码：\n\n    ${codes[0]}\n\n只能用一次，可在登录页「忘了密码」里用它重设密码。如果不是你本人申请，忽略这封邮件并联系我们。\n\n—— 路书\n这封邮件由系统发出，不用回复。`
    });
    await adminAudit(req, { admin, action: 'user.send-recovery', target: `user:${id}`, after: { sentTo: user.emailMasked }, reason: why });
    return { ok: true, sentTo: user.emailMasked };
  }
  throw createHttpError('不支持的账号操作', 400, 'OPS_ACCOUNT_ACTION_INVALID');
}

function statusOf(routebook) {
  if ((routebook.publishStatus || 'draft') === 'archived') return 'taken-down';
  if (isPublicRoutebook(routebook)) return 'public';
  if (routebook.friendLink) return 'friend-link';
  return 'draft';
}

async function generationFor(publicId) {
  const rows = await readMatchingJsonLines(AI_LOG_PATH, (row) => row?.kind === 'generate-routebook' && row?.publicId === publicId, 1, 200000);
  const row = rows[0];
  if (!row) return null;
  return {
    mode: row.mode ?? '',
    fellBackFrom: row.fellBackFrom ?? '',
    model: row.model ?? row.observability?.model ?? row.provider?.model ?? '',
    durationMs: row.durationMs ?? null,
    requestId: row.requestId ?? '',
    status: row.status,
    createdAt: row.createdAt
  };
}

export async function roadbookView(publicId) {
  const routebook = await getSavedRoutebook(sanitizePublicId(publicId));
  if (!routebook) throw createHttpError('路书不存在', 404, 'ROUTEBOOK_NOT_FOUND');
  const job = await enrichStore().getJob(routebook.publicId);
  const summary = job?.summary ?? {};
  return {
    publicId: routebook.publicId,
    title: routebook.title ?? '',
    city: routebook.city ?? '',
    status: statusOf(routebook),
    publishStatus: routebook.publishStatus || 'draft',
    stops: (routebook.stops ?? []).length,
    createdAt: routebook.createdAt ?? null,
    updatedAt: routebook.updatedAt ?? null,
    profileId: routebook.profileId ?? routebook.creator?.profileId ?? '',
    generation: await generationFor(routebook.publicId),
    enrichment: job
      ? {
          status: job.status,
          attempts: job.attempts,
          lastError: job.lastError,
          filled: summary.filled ?? 0,
          kept: summary.kept ?? 0,
          usd: summary.usd ?? null,
          stoppedBy: summary.stoppedBy ?? '',
          updatedAt: job.updatedAt
        }
      : null
  };
}

/** Search: exact id, else by city and/or owner profile, newest first. */
export async function searchRoadbooks({ q = '', city = '', profileId = '' } = {}) {
  const id = sanitizePublicId(q);
  if (id) {
    const one = await getSavedRoutebook(id).catch(() => null);
    if (one) return [await roadbookView(id)];
  }
  const rows = await listSavedRoutebooks(
    50,
    (row) => (!city || row.city === city) && (!profileId || row.profileId === profileId) && (!q || id || String(row.title ?? '').includes(q))
  );
  return Promise.all(rows.map((r) => roadbookView(r.publicId)));
}

/** Recent failed generations (never saved as routebooks): code + request id for support. */
export async function recentFailures({ profileId = '' } = {}) {
  const rows = await readMatchingJsonLines(
    AI_LOG_PATH,
    (row) => row?.kind === 'generate-routebook' && row?.status === 'error' && (!profileId || row.profileId === profileId),
    50,
    100000
  );
  return rows.map((r) => ({
    requestId: r.requestId,
    code: r.code,
    failureReason: r.failureReason ?? '',
    mode: r.mode,
    city: r.city,
    profileId: r.profileId,
    createdAt: r.createdAt
  }));
}

export async function roadbookAction({ admin, req, publicId, action, reason }) {
  const why = requireReason(reason);
  const id = sanitizePublicId(publicId);
  const routebook = await getSavedRoutebook(id);
  if (!routebook) throw createHttpError('路书不存在', 404, 'ROUTEBOOK_NOT_FOUND');
  const before = { status: statusOf(routebook) };
  if (action === 'rerun-enrichment') {
    const job = await enqueueEnrichment({ routebookId: id, userId: (await enrichStore().getJob(id))?.userId || 'admin', refresh: true });
    await adminAudit(req, { admin, action: 'roadbook.rerun-enrichment', target: `routebook:${id}`, after: { queued: Boolean(job) }, reason: why });
    return { queued: Boolean(job) };
  }
  if (action === 'take-down') {
    // Public → archived (share page returns not found); friend link → revoked. The routebook itself stays.
    if (isPublicRoutebook(routebook))
      await updateRoutebookStatus(id, { publishStatus: 'archived', opsNote: `管理后台下架：${why}`, expectedVersion: await currentRoutebookVersion(id) });
    if (routebook.friendLink) await adminRevokeFriendLink(id, why);
    const after = { status: statusOf(await getSavedRoutebook(id)) };
    await adminAudit(req, { admin, action: 'roadbook.take-down', target: `routebook:${id}`, before, after, reason: why });
    return { before, after };
  }
  throw createHttpError('不支持的路书操作', 400, 'ADMIN_ROADBOOK_ACTION');
}

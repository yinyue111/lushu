// Admin console API (/api/admin/*). Session cookie + TOTP only; X-Routebook-Admin-Token never opens these.
// Every handler checks the role table (server/admin/permissions.mjs); a denied call is audited.
import { ADMIN_ENABLED } from '../config/index.mjs';
import { NO_POI_CATALOG, route } from '../http/router.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { createHttpError } from '../lib/util.mjs';
import { adminEnroll, adminLogin, adminLogout, adminView, createAdminAccount, requireAdminSession, resetAdminTotp, ADMIN_ROLES } from '../admin/auth.mjs';
import { can } from '../admin/permissions.mjs';
import { adminAudit } from '../admin/audit.mjs';
import { adminStore } from '../admin/store.mjs';
import { configView, exportConfig, listVersions, previewConfig, restoreConfig, saveConfig, testRunModel } from '../admin/configService.mjs';
import { applyCorrection, listCorrectionQueue } from '../admin/corrections.mjs';
import { dashboard } from '../admin/dashboard.mjs';
import { recentFailures, roadbookAction, roadbookView, searchRoadbooks, searchUsers, updateUser } from '../admin/lookup.mjs';
import { systemInfo } from '../ops/systemInfo.mjs';
import { generateInviteCode, inviteCodeHash } from '../admin/invites.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { getConfig } from '../config/runtime.mjs';

function assertEnabled() {
  if (!ADMIN_ENABLED) throw createHttpError('接口不存在', 404, 'API_NOT_FOUND');
}

/** @param {any} req @param {import('../admin/permissions.mjs').PERMISSIONS extends Record<infer K, any> ? K : string} permission */
async function guard(req, permission, { write = false } = {}) {
  assertEnabled();
  enforceRateLimit(req, 'ops-read');
  const { admin } = await requireAdminSession(req, { write });
  if (!can(admin.role, /** @type {any} */ (permission))) {
    await adminAudit(req, { admin, action: 'denied', target: permission, extra: { method: req.method, path: String(req.url ?? '').split('?')[0] } });
    throw createHttpError('没有权限做这件事', 403, 'ADMIN_FORBIDDEN');
  }
  return admin;
}

const r = (method, pattern, handler) => route(method, pattern, handler, NO_POI_CATALOG);

export const adminRoutes = [
  r('POST', '/api/admin/login', async ({ req, res }) => {
    assertEnabled();
    enforceRateLimit(req, 'ops-read');
    const result = await adminLogin(req, res, await readJsonBody(req));
    if (result.enroll) return sendJson(res, 200, { ok: true, enroll: result.enroll });
    await adminAudit(req, { admin: result.admin, action: 'login' });
    return sendJson(res, 200, { ok: true, admin: adminView(result.admin), csrfToken: result.session.csrfToken, idleMinutes: result.session.idleMinutes });
  }),
  r('POST', '/api/admin/enroll', async ({ req, res }) => {
    assertEnabled();
    enforceRateLimit(req, 'ops-read');
    const result = await adminEnroll(req, res, await readJsonBody(req));
    await adminAudit(req, { admin: result.admin, action: 'totp.bind' });
    return sendJson(res, 200, {
      ok: true,
      admin: adminView(result.admin),
      backupCodes: result.backupCodes,
      csrfToken: result.session.csrfToken,
      idleMinutes: result.session.idleMinutes
    });
  }),
  r('POST', '/api/admin/logout', async ({ req, res }) => {
    assertEnabled();
    await adminLogout(req, res);
    return sendJson(res, 200, { ok: true });
  }),
  r('GET', '/api/admin/me', async ({ req, res }) => {
    assertEnabled();
    const { admin } = await requireAdminSession(req);
    return sendJson(res, 200, { ok: true, admin: adminView(admin), idleMinutes: getConfig('admin.sessionIdleMinutes') });
  }),

  // ---- overview
  r('GET', '/api/admin/dashboard', async ({ req, res }) => {
    await guard(req, 'dashboard.read');
    return sendJson(res, 200, { ok: true, ...(await dashboard()) });
  }),
  r('GET', '/api/admin/system', async ({ req, res }) => {
    await guard(req, 'system.read');
    return sendJson(res, 200, { ok: true, ...(await systemInfo()) });
  }),

  // ---- runtime config
  r('GET', '/api/admin/config', async ({ req, res }) => {
    await guard(req, 'config.read');
    return sendJson(res, 200, { ok: true, ...(await configView()) });
  }),
  r('POST', '/api/admin/config/preview', async ({ req, res }) => {
    await guard(req, 'config.write', { write: true });
    const body = await readJsonBody(req);
    const { changes } = previewConfig({ values: body.values, secrets: body.secrets });
    return sendJson(res, 200, { ok: true, changes });
  }),
  r('POST', '/api/admin/config', async ({ req, res }) => {
    const admin = await guard(req, 'config.write', { write: true });
    const body = await readJsonBody(req);
    const result = await saveConfig({
      admin,
      req,
      values: body.values,
      secrets: body.secrets,
      reason: body.reason,
      testRunIds: Array.isArray(body.testRunIds) ? body.testRunIds : [],
      force: body.force === true,
      confirmTwoSourceOff: body.confirmTwoSourceOff === true
    });
    return sendJson(res, 200, { ok: true, ...result });
  }),
  r('POST', '/api/admin/config/test-run', async ({ req, res }) => {
    const admin = await guard(req, 'config.testRun', { write: true });
    const body = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, ...(await testRunModel({ admin, req, tier: body.tier, draft: body.draft, apiKey: body.apiKey })) });
  }),
  r('GET', '/api/admin/config/versions', async ({ req, res }) => {
    await guard(req, 'config.read');
    return sendJson(res, 200, { ok: true, versions: await listVersions() });
  }),
  r('POST', '/api/admin/config/versions/:version/restore', async ({ req, res, params }) => {
    const admin = await guard(req, 'config.restore', { write: true });
    const body = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, ...(await restoreConfig({ admin, req, version: Number(params.version), reason: body.reason })) });
  }),
  r('GET', '/api/admin/config/versions/:version/export', async ({ req, res, params }) => {
    await guard(req, 'config.export');
    const data = await exportConfig(Number(params.version) || 0);
    res.setHeader('content-disposition', `attachment; filename="lushu-config-v${data.version}.json"`);
    return sendJson(res, 200, data);
  }),

  // ---- invite codes
  r('GET', '/api/admin/invites', async ({ req, res }) => {
    await guard(req, 'invites.manage');
    const invites = (await adminStore().listInvites()).map(({ codeHash: _h, ...rest }) => rest);
    return sendJson(res, 200, { ok: true, invites });
  }),
  r('POST', '/api/admin/invites', async ({ req, res }) => {
    const admin = await guard(req, 'invites.manage', { write: true });
    const body = await readJsonBody(req);
    const maxUses = Math.max(1, Math.min(10000, Math.floor(Number(body.maxUses) || 1)));
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && !(expiresAt.getTime() > Date.now())) throw createHttpError('过期时间要晚于现在', 400, 'ADMIN_INVITE_EXPIRY');
    const code = generateInviteCode();
    const invite = await adminStore().createInvite({
      id: `inv_${cryptoRandomId()}`,
      codeHash: inviteCodeHash(code),
      label: String(body.label ?? '').slice(0, 60),
      maxUses,
      expiresAt: expiresAt?.toISOString() ?? null,
      createdBy: admin.username
    });
    await adminAudit(req, {
      admin,
      action: 'invite.create',
      target: `invite:${invite.id}`,
      after: { label: invite.label, maxUses, expiresAt: invite.expiresAt }
    });
    const { codeHash: _h, ...rest } = invite;
    return sendJson(res, 200, { ok: true, invite: rest, code });
  }),
  r('POST', '/api/admin/invites/:id/revoke', async ({ req, res, params }) => {
    const admin = await guard(req, 'invites.manage', { write: true });
    const body = await readJsonBody(req);
    const invite = await adminStore().revokeInvite(String(params.id));
    if (!invite) throw createHttpError('邀请码不存在', 404, 'ADMIN_INVITE_NOT_FOUND');
    await adminAudit(req, {
      admin,
      action: 'invite.revoke',
      target: `invite:${invite.id}`,
      after: { revokedAt: invite.revokedAt },
      reason: String(body.reason ?? '')
    });
    return sendJson(res, 200, { ok: true });
  }),

  // ---- corrections
  r('GET', '/api/admin/corrections', async ({ req, res, url }) => {
    await guard(req, 'corrections.read');
    const p = url.searchParams;
    const items = await listCorrectionQueue({
      status: p.get('status') || '',
      city: p.get('city') || '',
      field: p.get('field') || '',
      since: p.get('since') || '',
      until: p.get('until') || ''
    });
    return sendJson(res, 200, { ok: true, items });
  }),
  r('POST', '/api/admin/corrections', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const admin = await guard(req, body.batch ? 'corrections.batch' : 'corrections.write', { write: true });
    return sendJson(res, 200, await applyCorrection({ ...body, admin, req }));
  }),

  // ---- users
  r('GET', '/api/admin/users', async ({ req, res, url }) => {
    await guard(req, 'users.read');
    return sendJson(res, 200, { ok: true, ...(await searchUsers(url.searchParams.get('q') || '')) });
  }),
  r('POST', '/api/admin/users/:id', async ({ req, res, params }) => {
    const body = await readJsonBody(req);
    const admin = await guard(req, ['set-quota', 'reset-quota'].includes(body.action) ? 'users.quota' : 'users.write', { write: true });
    return sendJson(res, 200, {
      ok: true,
      ...(await updateUser({ admin, req, userId: params.id, action: body.action, reason: body.reason, quota: body.quota }))
    });
  }),

  // ---- roadbooks
  r('GET', '/api/admin/roadbooks', async ({ req, res, url }) => {
    await guard(req, 'roadbooks.read');
    const p = url.searchParams;
    return sendJson(res, 200, {
      ok: true,
      items: await searchRoadbooks({ q: p.get('q') || '', city: p.get('city') || '', profileId: p.get('profileId') || '' })
    });
  }),
  r('GET', '/api/admin/roadbooks/:id', async ({ req, res, params }) => {
    await guard(req, 'roadbooks.read');
    return sendJson(res, 200, { ok: true, roadbook: await roadbookView(params.id) });
  }),
  r('POST', '/api/admin/roadbooks/:id', async ({ req, res, params }) => {
    const admin = await guard(req, 'roadbooks.write', { write: true });
    const body = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, ...(await roadbookAction({ admin, req, publicId: params.id, action: body.action, reason: body.reason })) });
  }),
  r('GET', '/api/admin/failures', async ({ req, res, url }) => {
    await guard(req, 'roadbooks.read');
    return sendJson(res, 200, { ok: true, items: await recentFailures({ profileId: url.searchParams.get('profileId') || '' }) });
  }),

  // ---- audit
  r('GET', '/api/admin/audit', async ({ req, res, url }) => {
    const admin = await guard(req, 'audit.read.own');
    const all = can(admin.role, 'audit.read.all');
    const actor = url.searchParams.get('actor') || '';
    const target = url.searchParams.get('target') || '';
    const items = (await adminStore().listAudit({ limit: 500, action: url.searchParams.get('action') || '' })).filter(
      (e) => (all || e.actor === admin.username) && (!actor || e.actor === actor) && (!target || String(e.target).includes(target))
    );
    return sendJson(res, 200, { ok: true, scope: all ? 'all' : 'own', items: items.slice(0, 200) });
  }),

  // ---- admin accounts
  r('GET', '/api/admin/admins', async ({ req, res }) => {
    await guard(req, 'admins.manage');
    return sendJson(res, 200, { ok: true, admins: (await adminStore().listAdmins()).map(adminView) });
  }),
  r('POST', '/api/admin/admins', async ({ req, res }) => {
    const admin = await guard(req, 'admins.manage', { write: true });
    const body = await readJsonBody(req);
    const { admin: created, initialPassword } = await createAdminAccount({ username: body.username, role: body.role });
    await adminAudit(req, { admin, action: 'admin.create', target: `admin:${created.username}`, after: { role: created.role } });
    return sendJson(res, 200, { ok: true, admin: adminView(created), initialPassword });
  }),
  r('POST', '/api/admin/admins/:id', async ({ req, res, params }) => {
    const admin = await guard(req, 'admins.manage', { write: true });
    const body = await readJsonBody(req);
    const target = await adminStore().getAdmin(String(params.id));
    if (!target) throw createHttpError('后台账号不存在', 404, 'ADMIN_NOT_FOUND');
    if (target.id === admin.id && body.action !== 'reset-totp') throw createHttpError('不能停用或降级自己', 400, 'ADMIN_SELF');
    let after;
    if (body.action === 'disable' || body.action === 'enable') {
      after = adminView(await adminStore().updateAdmin(target.id, { status: body.action === 'disable' ? 'disabled' : 'active' }));
      if (body.action === 'disable') await adminStore().deleteAdminSessions(target.id);
    } else if (body.action === 'set-role') {
      if (!ADMIN_ROLES.includes(body.role)) throw createHttpError('角色只能是 operator 或 admin', 400, 'ADMIN_ROLE_INVALID');
      after = adminView(await adminStore().updateAdmin(target.id, { role: body.role }));
      await adminStore().deleteAdminSessions(target.id);
    } else if (body.action === 'reset-totp') {
      after = adminView(await resetAdminTotp(target.id));
    } else throw createHttpError('不支持的操作', 400, 'ADMIN_ACTION_INVALID');
    await adminAudit(req, {
      admin,
      action: `admin.${body.action}`,
      target: `admin:${target.username}`,
      before: adminView(target),
      after,
      reason: String(body.reason ?? '')
    });
    return sendJson(res, 200, { ok: true, admin: after });
  })
];

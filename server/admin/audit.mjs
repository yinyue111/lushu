// Append-only admin audit (PostgreSQL: trigger forbids update/delete). Secrets are logged as "replaced".
import { adminStore } from './store.mjs';
import { cryptoRandomId } from './util.mjs';
import { clientIp } from './auth.mjs';

/**
 * @param {import('node:http').IncomingMessage | null} req
 * @param {{ admin?: any, actor?: string, role?: string, action: string, target?: string, before?: any, after?: any, reason?: string, extra?: Record<string, any> }} event
 */
export async function adminAudit(req, { admin, actor, role, action, target = '', before, after, reason = '', extra = {} }) {
  return adminStore().addAudit({
    id: `aud_${cryptoRandomId()}`,
    actor: actor ?? admin?.username ?? 'unknown',
    role: role ?? admin?.role ?? '',
    action,
    target,
    detail: { ...extra, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), ...(reason ? { reason } : {}) },
    ip: req ? clientIp(req) : '',
    createdAt: new Date().toISOString()
  });
}

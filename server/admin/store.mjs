// Admin console storage. PostgreSQL uses the tables of migration 0012; the JSONL backend keeps an
// append-only admin.jsonl replayed into memory (the JSONL runtime is single-writer, like accounts.jsonl).
// Report queue state for the JSONL backend lives here too (PostgreSQL adds columns to enrich_reports).
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../config/index.mjs';
import { usesPostgresStorage, getPostgresStorage } from '../storage/runtime.mjs';
import { createHttpError } from '../lib/util.mjs';

const S = 'trusted_routebook';
const iso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null);
export const CONFIG_NOTIFY_CHANNEL = 'routebook_admin_config';

function createJsonlStore(path = join(DATA_DIR, 'admin.jsonl')) {
  const versions = [];
  const users = new Map();
  const sessions = new Map();
  const audit = [];
  const invites = new Map();
  const corrections = [];
  const quotaResets = new Map();
  const reportStates = new Map();
  let loaded = null;
  const apply = (row) => {
    const v = row.v;
    if (row.t === 'config') versions.push(v);
    else if (row.t === 'user') users.set(v.id, v);
    else if (row.t === 'session') (v.deleted ? sessions.delete(v.sidHash) : sessions.set(v.sidHash, v));
    else if (row.t === 'audit') audit.push(v);
    else if (row.t === 'invite') invites.set(v.id, v);
    else if (row.t === 'correction') corrections.push(v);
    else if (row.t === 'quota-reset') quotaResets.set(v.profileId, v);
    else if (row.t === 'report-state') reportStates.set(v.reportId, v);
  };
  const load = () =>
    (loaded ??= (async () => {
      let text = '';
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          apply(JSON.parse(line));
        } catch {
          // torn last line after a crash: skipped
        }
      }
    })());
  const write = async (t, v) => {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(path, `${JSON.stringify({ t, v })}\n`, { mode: 0o600 });
    apply({ t, v });
    return v;
  };
  return {
    kind: 'jsonl',
    // ---- config versions
    async latestConfig() {
      await load();
      return versions.at(-1) ?? null;
    },
    async getConfigVersion(version) {
      await load();
      return versions.find((v) => v.version === version) ?? null;
    },
    async listConfigVersions(limit = 50) {
      await load();
      return versions.slice(-limit).reverse();
    },
    async insertConfigVersion(entry, expectedVersion) {
      await load();
      const current = versions.at(-1)?.version ?? 0;
      if (current !== expectedVersion) throw createHttpError('配置刚被别人改过，请刷新后再保存', 409, 'ADMIN_CONFIG_CONFLICT');
      return write('config', { ...entry, version: current + 1, createdAt: new Date().toISOString() });
    },
    // ---- admin users / sessions
    async createAdmin(user) {
      await load();
      if ([...users.values()].some((u) => u.username === user.username)) throw createHttpError('用户名已存在', 409, 'ADMIN_USERNAME_TAKEN');
      return write('user', { status: 'active', lastTotpStep: 0, lastLoginAt: null, createdAt: new Date().toISOString(), ...user });
    },
    async getAdmin(id) {
      await load();
      return users.get(id) ?? null;
    },
    async findAdminByUsername(username) {
      await load();
      return [...users.values()].find((u) => u.username === username) ?? null;
    },
    async listAdmins() {
      await load();
      return [...users.values()];
    },
    async updateAdmin(id, patch) {
      await load();
      const user = users.get(id);
      if (!user) return null;
      return write('user', { ...user, ...patch });
    },
    /** Atomic "TOTP step must increase" (replay protection). */
    async consumeTotpStep(id, step) {
      await load();
      const user = users.get(id);
      if (!user || step <= (user.lastTotpStep ?? 0)) return false;
      await write('user', { ...user, lastTotpStep: step, lastLoginAt: new Date().toISOString() });
      return true;
    },
    async createSession(session) {
      await load();
      return write('session', session);
    },
    async getSession(sidHash) {
      await load();
      return sessions.get(sidHash) ?? null;
    },
    async deleteSession(sidHash) {
      await load();
      if (sessions.has(sidHash)) await write('session', { sidHash, deleted: true });
    },
    // ---- audit
    async addAudit(event) {
      await load();
      return write('audit', event);
    },
    async listAudit({ limit = 100, action = '' } = {}) {
      await load();
      return audit
        .filter((e) => !action || e.action.startsWith(action))
        .slice(-limit)
        .reverse();
    },
    // ---- invites
    async createInvite(invite) {
      await load();
      return write('invite', { revokedAt: null, createdAt: new Date().toISOString(), ...invite });
    },
    async listInvites() {
      await load();
      return [...invites.values()].reverse();
    },
    async revokeInvite(id) {
      await load();
      const invite = invites.get(id);
      if (!invite) return null;
      if (invite.revokedAt) return invite;
      return write('invite', { ...invite, revokedAt: new Date().toISOString() });
    },
    async findActiveInviteByHash(codeHash) {
      await load();
      return [...invites.values()].find((i) => i.codeHash === codeHash && !i.revokedAt) ?? null;
    },
    // ---- corrections / reports
    async addCorrection(correction) {
      await load();
      return write('correction', correction);
    },
    async listCorrections(routebookId) {
      await load();
      return corrections.filter((c) => !routebookId || c.routebookId === routebookId).reverse();
    },
    async setReportState(reportId, state) {
      await load();
      return write('report-state', { reportId, ...state });
    },
    async reportStates() {
      await load();
      return new Map(reportStates);
    },
    // ---- quota resets
    async setQuotaReset(profileId, resetAt, actor) {
      await load();
      return write('quota-reset', { profileId, resetAt, actor });
    },
    async quotaResetAt(profileId) {
      await load();
      return quotaResets.get(profileId)?.resetAt ?? null;
    },
    async notifyConfigChanged() {}
  };
}

function createPostgresStore(poolProvider) {
  const q = (text, values) => poolProvider().query(text, values);
  const configFromRow = (r) =>
    r && {
      version: r.version,
      overrides: r.overrides ?? {},
      secrets: r.secrets ?? {},
      changes: r.changes ?? [],
      actor: r.actor,
      note: r.note,
      restoredFrom: r.restored_from,
      createdAt: iso(r.created_at)
    };
  const adminFromRow = (r) =>
    r && {
      id: r.id,
      username: r.username,
      passwordHash: r.password_hash,
      totpSecretEnc: r.totp_secret_enc,
      role: r.role,
      status: r.status,
      lastTotpStep: Number(r.last_totp_step),
      createdAt: iso(r.created_at),
      lastLoginAt: iso(r.last_login_at)
    };
  const inviteFromRow = (r) => r && { id: r.id, codeHash: r.code_hash, label: r.label, createdBy: r.created_by, createdAt: iso(r.created_at), revokedAt: iso(r.revoked_at) };
  return {
    kind: 'postgres',
    async latestConfig() {
      return configFromRow((await q(`select * from ${S}.admin_config_versions order by version desc limit 1`)).rows[0]) ?? null;
    },
    async getConfigVersion(version) {
      return configFromRow((await q(`select * from ${S}.admin_config_versions where version = $1`, [version])).rows[0]) ?? null;
    },
    async listConfigVersions(limit = 50) {
      return (await q(`select * from ${S}.admin_config_versions order by version desc limit $1`, [limit])).rows.map(configFromRow);
    },
    async insertConfigVersion(entry, expectedVersion) {
      // Primary key on version = optimistic concurrency: two admins saving at once, one gets 409.
      try {
        const { rows } = await q(
          `insert into ${S}.admin_config_versions (version, overrides, secrets, changes, actor, note, restored_from)
           select $1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7
           where coalesce((select max(version) from ${S}.admin_config_versions), 0) = $8
           returning *`,
          [
            expectedVersion + 1,
            JSON.stringify(entry.overrides),
            JSON.stringify(entry.secrets),
            JSON.stringify(entry.changes),
            entry.actor,
            entry.note ?? '',
            entry.restoredFrom ?? null,
            expectedVersion
          ]
        );
        if (!rows[0]) throw createHttpError('配置刚被别人改过，请刷新后再保存', 409, 'ADMIN_CONFIG_CONFLICT');
        return configFromRow(rows[0]);
      } catch (error) {
        if (error?.code === '23505') throw createHttpError('配置刚被别人改过，请刷新后再保存', 409, 'ADMIN_CONFIG_CONFLICT');
        throw error;
      }
    },
    async createAdmin(user) {
      try {
        const { rows } = await q(
          `insert into ${S}.admin_users (id, username, password_hash, totp_secret_enc, role) values ($1,$2,$3,$4,$5) returning *`,
          [user.id, user.username, user.passwordHash, user.totpSecretEnc, user.role]
        );
        return adminFromRow(rows[0]);
      } catch (error) {
        if (error?.code === '23505') throw createHttpError('用户名已存在', 409, 'ADMIN_USERNAME_TAKEN');
        throw error;
      }
    },
    async getAdmin(id) {
      return adminFromRow((await q(`select * from ${S}.admin_users where id = $1`, [id])).rows[0]) ?? null;
    },
    async findAdminByUsername(username) {
      return adminFromRow((await q(`select * from ${S}.admin_users where username = $1`, [username])).rows[0]) ?? null;
    },
    async listAdmins() {
      return (await q(`select * from ${S}.admin_users order by created_at`)).rows.map(adminFromRow);
    },
    async updateAdmin(id, patch) {
      const cols = { passwordHash: 'password_hash', totpSecretEnc: 'totp_secret_enc', role: 'role', status: 'status' };
      const sets = [];
      const values = [id];
      for (const [key, column] of Object.entries(cols)) {
        if (!(key in patch)) continue;
        values.push(patch[key]);
        sets.push(`${column} = $${values.length}`);
      }
      if (!sets.length) return this.getAdmin(id);
      return adminFromRow((await q(`update ${S}.admin_users set ${sets.join(', ')} where id = $1 returning *`, values)).rows[0]) ?? null;
    },
    async consumeTotpStep(id, step) {
      const { rowCount } = await q(
        `update ${S}.admin_users set last_totp_step = $2, last_login_at = clock_timestamp() where id = $1 and last_totp_step < $2`,
        [id, step]
      );
      return rowCount === 1;
    },
    async createSession(session) {
      await q(`insert into ${S}.admin_sessions (sid_hash, admin_id, expires_at) values ($1,$2,$3)`, [session.sidHash, session.adminId, session.expiresAt]);
      await q(`delete from ${S}.admin_sessions where expires_at < clock_timestamp()`);
      return session;
    },
    async getSession(sidHash) {
      const r = (await q(`select * from ${S}.admin_sessions where sid_hash = $1`, [sidHash])).rows[0];
      return r ? { sidHash: r.sid_hash, adminId: r.admin_id, expiresAt: iso(r.expires_at), createdAt: iso(r.created_at) } : null;
    },
    async deleteSession(sidHash) {
      await q(`delete from ${S}.admin_sessions where sid_hash = $1`, [sidHash]);
    },
    async addAudit(e) {
      await q(`insert into ${S}.admin_audit (id, actor, role, action, target, detail, created_at) values ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [
        e.id,
        e.actor,
        e.role ?? '',
        e.action,
        e.target ?? '',
        JSON.stringify(e.detail ?? {}),
        e.createdAt
      ]);
      return e;
    },
    async listAudit({ limit = 100, action = '' } = {}) {
      const { rows } = await q(`select * from ${S}.admin_audit where ($2 = '' or action like $2 || '%') order by created_at desc limit $1`, [limit, action]);
      return rows.map((r) => ({ id: r.id, actor: r.actor, role: r.role, action: r.action, target: r.target, detail: r.detail, createdAt: iso(r.created_at) }));
    },
    async createInvite(invite) {
      const { rows } = await q(`insert into ${S}.admin_invite_codes (id, code_hash, label, created_by) values ($1,$2,$3,$4) returning *`, [
        invite.id,
        invite.codeHash,
        invite.label ?? '',
        invite.createdBy
      ]);
      return inviteFromRow(rows[0]);
    },
    async listInvites() {
      return (await q(`select * from ${S}.admin_invite_codes order by created_at desc limit 200`)).rows.map(inviteFromRow);
    },
    async revokeInvite(id) {
      await q(`update ${S}.admin_invite_codes set revoked_at = coalesce(revoked_at, clock_timestamp()) where id = $1`, [id]);
      return inviteFromRow((await q(`select * from ${S}.admin_invite_codes where id = $1`, [id])).rows[0]) ?? null;
    },
    async findActiveInviteByHash(codeHash) {
      return inviteFromRow((await q(`select * from ${S}.admin_invite_codes where code_hash = $1 and revoked_at is null`, [codeHash])).rows[0]) ?? null;
    },
    async addCorrection(c) {
      await q(
        `insert into ${S}.admin_corrections (id, routebook_id, stop_key, field, action, value, source_url, report_id, actor, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [c.id, c.routebookId, c.stopKey, c.field, c.action, c.value ?? '', c.sourceUrl ?? '', c.reportId ?? null, c.actor, c.createdAt]
      );
      return c;
    },
    async listCorrections(routebookId) {
      const { rows } = await q(`select * from ${S}.admin_corrections where ($1 = '' or routebook_id = $1) order by created_at desc limit 200`, [routebookId ?? '']);
      return rows.map((r) => ({
        id: r.id,
        routebookId: r.routebook_id,
        stopKey: r.stop_key,
        field: r.field,
        action: r.action,
        value: r.value,
        sourceUrl: r.source_url,
        reportId: r.report_id,
        actor: r.actor,
        createdAt: iso(r.created_at)
      }));
    },
    async setReportState(reportId, state) {
      await q(`update ${S}.enrich_reports set status = $2, resolved_by = $3, resolved_at = $4 where id = $1`, [reportId, state.status, state.resolvedBy, state.resolvedAt]);
      return { reportId, ...state };
    },
    async reportStates() {
      const { rows } = await q(`select id, status, resolved_by, resolved_at from ${S}.enrich_reports where status <> 'open'`);
      return new Map(rows.map((r) => [r.id, { reportId: r.id, status: r.status, resolvedBy: r.resolved_by, resolvedAt: iso(r.resolved_at) }]));
    },
    async setQuotaReset(profileId, resetAt, actor) {
      await q(
        `insert into ${S}.admin_quota_resets (profile_id, reset_at, actor) values ($1,$2,$3)
         on conflict (profile_id) do update set reset_at = excluded.reset_at, actor = excluded.actor`,
        [profileId, resetAt, actor]
      );
    },
    async quotaResetAt(profileId) {
      return iso((await q(`select reset_at from ${S}.admin_quota_resets where profile_id = $1`, [profileId])).rows[0]?.reset_at) ?? null;
    },
    async notifyConfigChanged(version) {
      await q(`select pg_notify($1, $2)`, [CONFIG_NOTIFY_CHANNEL, String(version)]);
    }
  };
}

let store = null;
export function adminStore() {
  store ??= usesPostgresStorage() ? createPostgresStore(() => getPostgresStorage().pool) : createJsonlStore();
  return store;
}
export function setAdminStoreForTests(next) {
  store = next;
}
export { createJsonlStore, createPostgresStore };

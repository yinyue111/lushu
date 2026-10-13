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
  const facts = new Map();
  let loaded = null;
  const apply = (row) => {
    const v = row.v;
    if (row.t === 'config') versions.push(v);
    else if (row.t === 'user') users.set(v.id, v);
    else if (row.t === 'session') v.deleted ? sessions.delete(v.sidHash) : sessions.set(v.sidHash, v);
    else if (row.t === 'audit') audit.push(v);
    else if (row.t === 'invite') invites.set(v.id, v);
    else if (row.t === 'correction') corrections.push(v);
    else if (row.t === 'quota-reset') quotaResets.set(v.profileId, v);
    else if (row.t === 'report-state') reportStates.set(v.reportId, v);
    else if (row.t === 'fact') v.deleted ? facts.delete(v.cacheKey) : facts.set(v.cacheKey, v);
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
      return write('user', {
        status: 'active',
        totpConfirmed: false,
        backupCodeHashes: [],
        failedAttempts: 0,
        lockedUntil: null,
        lastTotpStep: 0,
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
        ...user
      });
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
    async touchSession(sidHash, lastSeenAt) {
      await load();
      const session = sessions.get(sidHash);
      if (session) await write('session', { ...session, lastSeenAt });
    },
    async deleteAdminSessions(adminId) {
      await load();
      for (const session of [...sessions.values()]) if (session.adminId === adminId) await write('session', { sidHash: session.sidHash, deleted: true });
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
      return write('invite', { revokedAt: null, used: 0, maxUses: 1, expiresAt: null, createdAt: new Date().toISOString(), ...invite });
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
    /** Atomically takes one use of a live invite code. Returns the invite or null. */
    async consumeInvite(codeHash, now = Date.now()) {
      await load();
      const invite = [...invites.values()].find((i) => i.codeHash === codeHash);
      if (!invite || invite.revokedAt || (invite.expiresAt && Date.parse(invite.expiresAt) <= now) || invite.used >= invite.maxUses) return null;
      return write('invite', { ...invite, used: invite.used + 1 });
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
    async putVerifiedFact(fact) {
      await load();
      return write('fact', fact);
    },
    async getVerifiedFact(cacheKey, now = Date.now()) {
      await load();
      const fact = facts.get(cacheKey);
      return fact && Date.parse(fact.expiresAt) > now ? fact : null;
    },
    async deleteVerifiedFact(cacheKey) {
      await load();
      if (facts.has(cacheKey)) await write('fact', { cacheKey, deleted: true });
    },
    async listVerifiedFacts(limit = 200) {
      await load();
      return [...facts.values()].slice(-limit).reverse();
    },
    async setQuotaReset(profileId, resetAt, actor) {
      await load();
      return write('quota-reset', { profileId, resetAt, actor });
    },
    async quotaResetAt(profileId) {
      await load();
      return quotaResets.get(profileId)?.resetAt ?? null;
    },
    async notifyConfigChanged() {},
    async ping() {},
  };
}

// Rollback safety: this code also runs on schema v11 (before 0012). The admin tables and the new
// enrich_reports columns are then missing; every admin-store query fails with one clear 503
// ADMIN_SCHEMA_MISSING, the console reports itself unavailable, and the user app keeps working
// (callers on user paths already treat admin-store failures as "no data").
const MISSING_SCHEMA_CODES = new Set(['42P01', '42703']); // undefined_table, undefined_column
export function adminSchemaMissingError() {
  const error = /** @type {any} */ (new Error('管理后台需要数据库结构 v12（迁移 0012）；当前数据库还没有这些表，后台暂不可用，用户端不受影响。'));
  error.statusCode = 503;
  error.code = 'ADMIN_SCHEMA_MISSING';
  return error;
}

function createPostgresStore(poolProvider) {
  const q = async (text, values) => {
    try {
      return await poolProvider().query(text, values);
    } catch (error) {
      if (MISSING_SCHEMA_CODES.has(error?.code)) throw adminSchemaMissingError();
      throw error;
    }
  };
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
      totpConfirmed: r.totp_confirmed,
      backupCodeHashes: r.backup_code_hashes ?? [],
      failedAttempts: r.failed_attempts,
      lockedUntil: iso(r.locked_until),
      lastTotpStep: Number(r.last_totp_step),
      createdAt: iso(r.created_at),
      lastLoginAt: iso(r.last_login_at)
    };
  const inviteFromRow = (r) =>
    r && {
      id: r.id,
      codeHash: r.code_hash,
      label: r.label,
      maxUses: r.max_uses,
      used: r.used,
      expiresAt: iso(r.expires_at),
      createdBy: r.created_by,
      createdAt: iso(r.created_at),
      revokedAt: iso(r.revoked_at)
    };
  const factFromRow = (r) =>
    r && {
      cacheKey: r.cache_key,
      city: r.city,
      place: r.place,
      field: r.field,
      value: r.value,
      sources: r.sources ?? [],
      scope: r.scope,
      verifiedBy: r.verified_by,
      verifiedAt: iso(r.verified_at),
      expiresAt: iso(r.expires_at)
    };
  return {
    kind: 'postgres',
    async ping() {
      await q(`select 1 from ${S}.admin_users limit 0`);
    },
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
        const { rows } = await q(`insert into ${S}.admin_users (id, username, password_hash, totp_secret_enc, role) values ($1,$2,$3,$4,$5) returning *`, [
          user.id,
          user.username,
          user.passwordHash,
          user.totpSecretEnc,
          user.role
        ]);
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
      const cols = {
        passwordHash: 'password_hash',
        totpSecretEnc: 'totp_secret_enc',
        role: 'role',
        status: 'status',
        totpConfirmed: 'totp_confirmed',
        backupCodeHashes: 'backup_code_hashes',
        failedAttempts: 'failed_attempts',
        lockedUntil: 'locked_until',
        lastTotpStep: 'last_totp_step'
      };
      const sets = [];
      const values = [id];
      for (const [key, column] of Object.entries(cols)) {
        if (!(key in patch)) continue;
        values.push(key === 'backupCodeHashes' ? JSON.stringify(patch[key]) : patch[key]);
        sets.push(`${column} = $${values.length}${key === 'backupCodeHashes' ? '::jsonb' : ''}`);
      }
      if (!sets.length) return this.getAdmin(id);
      return adminFromRow((await q(`update ${S}.admin_users set ${sets.join(', ')} where id = $1 returning *`, values)).rows[0]) ?? null;
    },
    async consumeTotpStep(id, step) {
      const { rowCount } = await q(`update ${S}.admin_users set last_totp_step = $2, last_login_at = clock_timestamp() where id = $1 and last_totp_step < $2`, [
        id,
        step
      ]);
      return rowCount === 1;
    },
    async createSession(session) {
      await q(`insert into ${S}.admin_sessions (sid_hash, admin_id, csrf_hash, expires_at) values ($1,$2,$3,$4)`, [
        session.sidHash,
        session.adminId,
        session.csrfHash ?? '',
        session.expiresAt
      ]);
      await q(`delete from ${S}.admin_sessions where expires_at < clock_timestamp()`);
      return session;
    },
    async getSession(sidHash) {
      const r = (await q(`select * from ${S}.admin_sessions where sid_hash = $1`, [sidHash])).rows[0];
      return r
        ? {
            sidHash: r.sid_hash,
            adminId: r.admin_id,
            csrfHash: r.csrf_hash,
            expiresAt: iso(r.expires_at),
            lastSeenAt: iso(r.last_seen_at),
            createdAt: iso(r.created_at)
          }
        : null;
    },
    async deleteSession(sidHash) {
      await q(`delete from ${S}.admin_sessions where sid_hash = $1`, [sidHash]);
    },
    async touchSession(sidHash, lastSeenAt) {
      await q(`update ${S}.admin_sessions set last_seen_at = $2 where sid_hash = $1`, [sidHash, lastSeenAt]);
    },
    async deleteAdminSessions(adminId) {
      await q(`delete from ${S}.admin_sessions where admin_id = $1`, [adminId]);
    },
    async addAudit(e) {
      await q(`insert into ${S}.admin_audit (id, actor, role, action, target, detail, ip, created_at) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [
        e.id,
        e.actor,
        e.role ?? '',
        e.action,
        e.target ?? '',
        JSON.stringify(e.detail ?? {}),
        e.ip ?? '',
        e.createdAt
      ]);
      return e;
    },
    async listAudit({ limit = 100, action = '' } = {}) {
      const { rows } = await q(`select * from ${S}.admin_audit where ($2 = '' or action like $2 || '%') order by created_at desc limit $1`, [limit, action]);
      return rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        role: r.role,
        action: r.action,
        target: r.target,
        detail: r.detail,
        ip: r.ip,
        createdAt: iso(r.created_at)
      }));
    },
    async createInvite(invite) {
      const { rows } = await q(
        `insert into ${S}.admin_invite_codes (id, code_hash, label, max_uses, expires_at, created_by) values ($1,$2,$3,$4,$5,$6) returning *`,
        [invite.id, invite.codeHash, invite.label ?? '', invite.maxUses ?? 1, invite.expiresAt ?? null, invite.createdBy]
      );
      return inviteFromRow(rows[0]);
    },
    async listInvites() {
      return (await q(`select * from ${S}.admin_invite_codes order by created_at desc limit 200`)).rows.map(inviteFromRow);
    },
    async revokeInvite(id) {
      await q(`update ${S}.admin_invite_codes set revoked_at = coalesce(revoked_at, clock_timestamp()) where id = $1`, [id]);
      return inviteFromRow((await q(`select * from ${S}.admin_invite_codes where id = $1`, [id])).rows[0]) ?? null;
    },
    async consumeInvite(codeHash, now = Date.now()) {
      const { rows } = await q(
        `update ${S}.admin_invite_codes set used = used + 1
         where code_hash = $1 and revoked_at is null and used < max_uses and (expires_at is null or expires_at > $2) returning *`,
        [codeHash, new Date(now).toISOString()]
      );
      return inviteFromRow(rows[0]) ?? null;
    },
    async addCorrection(c) {
      await q(
        `insert into ${S}.admin_corrections (id, routebook_id, stop_key, field, action, value, source_url, report_id, reason, actor, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [c.id, c.routebookId, c.stopKey, c.field, c.action, c.value ?? '', c.sourceUrl ?? '', c.reportId ?? null, c.reason ?? '', c.actor, c.createdAt]
      );
      return c;
    },
    async listCorrections(routebookId) {
      const { rows } = await q(`select * from ${S}.admin_corrections where ($1 = '' or routebook_id = $1) order by created_at desc limit 200`, [
        routebookId ?? ''
      ]);
      return rows.map((r) => ({
        id: r.id,
        routebookId: r.routebook_id,
        stopKey: r.stop_key,
        field: r.field,
        action: r.action,
        value: r.value,
        sourceUrl: r.source_url,
        reportId: r.report_id,
        reason: r.reason,
        actor: r.actor,
        createdAt: iso(r.created_at)
      }));
    },
    async setReportState(reportId, state) {
      await q(`update ${S}.enrich_reports set status = $2, resolved_by = $3, resolved_at = $4 where id = $1`, [
        reportId,
        state.status,
        state.resolvedBy,
        state.resolvedAt
      ]);
      return { reportId, ...state };
    },
    async reportStates() {
      const { rows } = await q(`select id, status, resolved_by, resolved_at from ${S}.enrich_reports where status <> 'open'`);
      return new Map(rows.map((r) => [r.id, { reportId: r.id, status: r.status, resolvedBy: r.resolved_by, resolvedAt: iso(r.resolved_at) }]));
    },
    async putVerifiedFact(f) {
      await q(
        `insert into ${S}.admin_verified_facts (cache_key, city, place, field, value, sources, scope, verified_by, verified_at, expires_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
         on conflict (cache_key) do update set value = excluded.value, sources = excluded.sources, verified_by = excluded.verified_by,
           verified_at = excluded.verified_at, expires_at = excluded.expires_at`,
        [
          f.cacheKey,
          f.city ?? '',
          f.place ?? '',
          f.field,
          f.value,
          JSON.stringify(f.sources ?? []),
          f.scope ?? 'cache-key',
          f.verifiedBy,
          f.verifiedAt,
          f.expiresAt
        ]
      );
      return f;
    },
    async getVerifiedFact(cacheKey, now = Date.now()) {
      return (
        factFromRow(
          (await q(`select * from ${S}.admin_verified_facts where cache_key = $1 and expires_at > $2`, [cacheKey, new Date(now).toISOString()])).rows[0]
        ) ?? null
      );
    },
    async deleteVerifiedFact(cacheKey) {
      await q(`delete from ${S}.admin_verified_facts where cache_key = $1`, [cacheKey]);
    },
    async listVerifiedFacts(limit = 200) {
      return (await q(`select * from ${S}.admin_verified_facts order by verified_at desc limit $1`, [limit])).rows.map(factFromRow);
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

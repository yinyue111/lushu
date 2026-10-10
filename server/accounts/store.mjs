// Account storage. PostgreSQL uses dedicated tables (migration 0008); the JSONL backend keeps an
// append-only accounts.jsonl that is replayed into memory (the JSONL runtime is single-writer).
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../config/index.mjs';
import { usesPostgresStorage, getPostgresStorage } from '../storage/runtime.mjs';
import { createHttpError } from '../lib/util.mjs';

export const ACCOUNTS_LOG_PATH = join(DATA_DIR, 'accounts.jsonl');
const S = 'trusted_routebook';

const iso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null);
const taken = (code) => createHttpError(code === 'PHONE_TAKEN' ? '这个手机号不能注册' : '这个档案已属于别的账号', 409, code);

// ---------------------------------------------------------------- JSONL
function createJsonlStore(path = ACCOUNTS_LOG_PATH) {
  const users = new Map();
  const sessions = new Map();
  const throttles = new Map();
  const links = new Map();
  let loaded = null;

  const apply = (row) => {
    if (row.t === 'user') users.set(row.v.id, row.v);
    else if (row.t === 'session') sessions.set(row.v.sidHash, row.v);
    else if (row.t === 'throttle') row.v.deleted ? throttles.delete(row.v.key) : throttles.set(row.v.key, row.v);
    else if (row.t === 'link') links.set(row.v.profileId, row.v);
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
          // A torn last line (crash mid-append) is skipped; earlier rows stay authoritative.
        }
      }
    })());
  const write = async (t, v) => {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(path, `${JSON.stringify({ t, v, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    apply({ t, v });
    return v;
  };
  const liveByPhone = (hash) => [...users.values()].find((u) => u.phoneHash === hash && u.status !== 'deleted') ?? null;
  const liveByProfile = (profileId) => [...users.values()].find((u) => u.primaryProfileId === profileId && u.status !== 'deleted') ?? null;

  return {
    kind: 'jsonl',
    async createUser(user) {
      await load();
      if (liveByPhone(user.phoneHash)) throw taken('PHONE_TAKEN');
      if (liveByProfile(user.primaryProfileId) || links.has(user.primaryProfileId)) throw taken('PROFILE_TAKEN');
      return write('user', { generationQuota: null, lastLoginAt: null, credentialsChangedAt: user.createdAt, updatedAt: user.createdAt, ...user });
    },
    async getUser(id) {
      await load();
      return users.get(id) ?? null;
    },
    async findUserByPhoneHash(hash) {
      await load();
      return liveByPhone(hash);
    },
    async updateUser(id, patch) {
      await load();
      const current = users.get(id);
      if (!current) return null;
      return write('user', { ...current, ...patch, updatedAt: new Date().toISOString() });
    },
    async listUsers({ last4 = '', phoneHash = '', limit = 50 } = {}) {
      await load();
      return [...users.values()]
        .filter((u) => (!phoneHash || u.phoneHash === phoneHash) && (!last4 || u.phoneLast4 === last4))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    },
    async createSession(session) {
      await load();
      return write('session', { revokedAt: null, ...session });
    },
    async getSession(sidHash) {
      await load();
      return sessions.get(sidHash) ?? null;
    },
    async touchSession(sidHash, patch) {
      await load();
      const current = sessions.get(sidHash);
      if (current) await write('session', { ...current, ...patch });
    },
    async revokeSession(sidHash) {
      await load();
      const current = sessions.get(sidHash);
      if (current && !current.revokedAt) await write('session', { ...current, revokedAt: new Date().toISOString() });
    },
    async revokeUserSessions(userId, { except = '' } = {}) {
      await load();
      let count = 0;
      for (const session of [...sessions.values()]) {
        if (session.userId !== userId || session.revokedAt || session.sidHash === except) continue;
        await write('session', { ...session, revokedAt: new Date().toISOString() });
        count += 1;
      }
      return count;
    },
    async countActiveSessions(userId, now = Date.now()) {
      await load();
      return [...sessions.values()].filter((s) => s.userId === userId && !s.revokedAt && Date.parse(s.expiresAt) > now).length;
    },
    async getThrottle(key) {
      await load();
      return throttles.get(key) ?? null;
    },
    async putThrottle(record) {
      await load();
      return write('throttle', { ...record });
    },
    async deleteThrottle(key) {
      await load();
      if (throttles.has(key)) await write('throttle', { key, deleted: true });
    },
    async linkProfile(profileId, userId, via = 'claim') {
      await load();
      const owner = links.get(profileId)?.userId ?? liveByProfile(profileId)?.id;
      if (owner) return owner;
      await write('link', { profileId, userId, via, linkedAt: new Date().toISOString() });
      return userId;
    },
    async findUserIdByProfile(profileId) {
      await load();
      return liveByProfile(profileId)?.id ?? links.get(profileId)?.userId ?? null;
    },
    async listLinkedProfiles(userId) {
      await load();
      return [...links.values()].filter((l) => l.userId === userId).map((l) => l.profileId);
    }
  };
}

// ---------------------------------------------------------------- PostgreSQL
const userFromRow = (r) =>
  r && {
    id: r.id,
    phoneHash: r.phone_hash,
    phoneMasked: r.phone_masked,
    phoneLast4: r.phone_last4,
    passwordHash: r.password_hash,
    recoveryHashes: r.recovery_hashes ?? [],
    primaryProfileId: r.primary_profile_id,
    status: r.status,
    generationQuota: r.generation_quota ?? null,
    credentialsChangedAt: iso(r.credentials_changed_at),
    lastLoginAt: iso(r.last_login_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at)
  };
const sessionFromRow = (r) =>
  r && {
    sidHash: r.sid_hash,
    userId: r.user_id,
    createdAt: iso(r.created_at),
    lastSeenAt: iso(r.last_seen_at),
    expiresAt: iso(r.expires_at),
    absoluteExpiresAt: iso(r.absolute_expires_at),
    revokedAt: iso(r.revoked_at),
    userAgent: r.user_agent
  };
const USER_COLUMNS = {
  phoneMasked: 'phone_masked',
  phoneLast4: 'phone_last4',
  passwordHash: 'password_hash',
  recoveryHashes: 'recovery_hashes',
  primaryProfileId: 'primary_profile_id',
  status: 'status',
  generationQuota: 'generation_quota',
  credentialsChangedAt: 'credentials_changed_at',
  lastLoginAt: 'last_login_at'
};

function createPostgresStore(poolProvider) {
  const q = (text, values) => poolProvider().query(text, values);
  const uniqueViolation = (error) => {
    if (error?.code !== '23505') throw error;
    throw taken(/primary_profile/.test(String(error?.constraint ?? '')) ? 'PROFILE_TAKEN' : 'PHONE_TAKEN');
  };
  return {
    kind: 'postgres',
    async createUser(u) {
      const linked = await q(`select 1 from ${S}.auth_profile_links where profile_id = $1`, [u.primaryProfileId]);
      if (linked.rowCount) throw taken('PROFILE_TAKEN');
      try {
        const { rows } = await q(
          `insert into ${S}.auth_users (id, phone_hash, phone_masked, phone_last4, password_hash, recovery_hashes, primary_profile_id, status, created_at, updated_at, credentials_changed_at)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$9,$9) returning *`,
          [
            u.id,
            u.phoneHash,
            u.phoneMasked,
            u.phoneLast4,
            u.passwordHash,
            JSON.stringify(u.recoveryHashes ?? []),
            u.primaryProfileId,
            u.status ?? 'active',
            u.createdAt
          ]
        );
        return userFromRow(rows[0]);
      } catch (error) {
        return uniqueViolation(error);
      }
    },
    async getUser(id) {
      return userFromRow((await q(`select * from ${S}.auth_users where id = $1`, [id])).rows[0]) ?? null;
    },
    async findUserByPhoneHash(hash) {
      return userFromRow((await q(`select * from ${S}.auth_users where phone_hash = $1 and status <> 'deleted'`, [hash])).rows[0]) ?? null;
    },
    async updateUser(id, patch) {
      const sets = [];
      const values = [id];
      for (const [key, column] of Object.entries(USER_COLUMNS)) {
        if (!(key in patch)) continue;
        values.push(key === 'recoveryHashes' ? JSON.stringify(patch[key]) : patch[key]);
        sets.push(`${column} = $${values.length}${key === 'recoveryHashes' ? '::jsonb' : ''}`);
      }
      if (!sets.length) return this.getUser(id);
      try {
        const { rows } = await q(`update ${S}.auth_users set ${sets.join(', ')}, updated_at = clock_timestamp() where id = $1 returning *`, values);
        return userFromRow(rows[0]) ?? null;
      } catch (error) {
        return uniqueViolation(error);
      }
    },
    async listUsers({ last4 = '', phoneHash = '', limit = 50 } = {}) {
      const { rows } = await q(
        `select * from ${S}.auth_users where ($1 = '' or phone_hash = $1) and ($2 = '' or phone_last4 = $2) order by created_at desc limit $3`,
        [phoneHash, last4, limit]
      );
      return rows.map(userFromRow);
    },
    async createSession(s) {
      await q(
        `insert into ${S}.auth_sessions (sid_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, user_agent) values ($1,$2,$3,$4,$5,$6,$7)`,
        [s.sidHash, s.userId, s.createdAt, s.lastSeenAt, s.expiresAt, s.absoluteExpiresAt, s.userAgent ?? '']
      );
      return s;
    },
    async getSession(sidHash) {
      return sessionFromRow((await q(`select * from ${S}.auth_sessions where sid_hash = $1`, [sidHash])).rows[0]) ?? null;
    },
    async touchSession(sidHash, patch) {
      await q(`update ${S}.auth_sessions set last_seen_at = $2, expires_at = $3 where sid_hash = $1 and revoked_at is null`, [
        sidHash,
        patch.lastSeenAt,
        patch.expiresAt
      ]);
    },
    async revokeSession(sidHash) {
      await q(`update ${S}.auth_sessions set revoked_at = clock_timestamp() where sid_hash = $1 and revoked_at is null`, [sidHash]);
    },
    async revokeUserSessions(userId, { except = '' } = {}) {
      const result = await q(`update ${S}.auth_sessions set revoked_at = clock_timestamp() where user_id = $1 and revoked_at is null and sid_hash <> $2`, [
        userId,
        except
      ]);
      // Expired rows are pruned opportunistically here instead of a separate job.
      await q(`delete from ${S}.auth_sessions where absolute_expires_at < clock_timestamp() - interval '30 days'`);
      return result.rowCount;
    },
    async countActiveSessions(userId) {
      const { rows } = await q(
        `select count(*)::int as n from ${S}.auth_sessions where user_id = $1 and revoked_at is null and expires_at > clock_timestamp()`,
        [userId]
      );
      return rows[0].n;
    },
    async getThrottle(key) {
      const r = (await q(`select * from ${S}.auth_throttles where key = $1`, [key])).rows[0];
      return r
        ? { key: r.key, failures: r.failures, windowStartedAt: iso(r.window_started_at), lockedUntil: iso(r.locked_until), lockLevel: r.lock_level }
        : null;
    },
    async putThrottle(t) {
      await q(
        `insert into ${S}.auth_throttles (key, failures, window_started_at, locked_until, lock_level, updated_at) values ($1,$2,$3,$4,$5,clock_timestamp())
         on conflict (key) do update set failures = excluded.failures, window_started_at = excluded.window_started_at, locked_until = excluded.locked_until,
           lock_level = excluded.lock_level, updated_at = excluded.updated_at`,
        [t.key, t.failures, t.windowStartedAt, t.lockedUntil, t.lockLevel]
      );
      return t;
    },
    async deleteThrottle(key) {
      await q(`delete from ${S}.auth_throttles where key = $1`, [key]);
    },
    async linkProfile(profileId, userId, via = 'claim') {
      const primary = await q(`select id from ${S}.auth_users where primary_profile_id = $1 and status <> 'deleted'`, [profileId]);
      if (primary.rowCount) return primary.rows[0].id;
      const { rows } = await q(
        `insert into ${S}.auth_profile_links (profile_id, user_id, via) values ($1,$2,$3) on conflict (profile_id) do update set profile_id = excluded.profile_id returning user_id`,
        [profileId, userId, via]
      );
      return rows[0].user_id;
    },
    async findUserIdByProfile(profileId) {
      const { rows } = await q(
        `select id from ${S}.auth_users where primary_profile_id = $1 and status <> 'deleted'
         union all select user_id from ${S}.auth_profile_links where profile_id = $1 limit 1`,
        [profileId]
      );
      return rows[0]?.id ?? null;
    },
    async listLinkedProfiles(userId) {
      return (await q(`select profile_id from ${S}.auth_profile_links where user_id = $1`, [userId])).rows.map((r) => r.profile_id);
    }
  };
}

let store = null;
export function accountStore() {
  store ??= usesPostgresStorage() ? createPostgresStore(() => getPostgresStorage().pool) : createJsonlStore();
  return store;
}
/** Test hook. */
export function setAccountStoreForTests(next) {
  store = next;
}
export { createJsonlStore, createPostgresStore };

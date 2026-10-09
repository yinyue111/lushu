import { createHash, createHmac } from 'node:crypto';

export const LOCAL_PROFILE_ID_SECRET = 'trusted-routebook-local-profile-id-v1';

export function profileIdSecretFingerprint(value) {
  const secret = String(value ?? '').trim();
  if (!secret) return '';
  return createHash('sha256').update(`trusted-routebook:profile-id-secret:v1:${secret}`).digest('hex');
}

const EDIT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;
const EDIT_TOKEN_HASH_PATTERN = /^[a-f0-9]{18}$/;

export function resolveRoutebookCredentialSecret(env = process.env) {
  const secret = [env?.PROFILE_ID_SECRET, env?.ROUTEBOOK_ADMIN_TOKEN, env?.ROUTEBOOK_API_TOKEN].map((value) => String(value ?? '').trim()).find(Boolean);
  if (secret) return secret;
  if (
    String(env?.NODE_ENV ?? '')
      .trim()
      .toLowerCase() !== 'production'
  ) {
    return LOCAL_PROFILE_ID_SECRET;
  }
  throw credentialError('ROUTEBOOK_CREDENTIAL_SECRET_REQUIRED', 'PROFILE_ID_SECRET is required to migrate plaintext routebook edit tokens in production.');
}

export function hashRoutebookEditToken(value, options = {}) {
  const token = normalizeLegacyEditToken(value, '$.editToken');
  if (!token) return '';
  const secret = Object.hasOwn(options, 'profileIdSecret') ? String(options.profileIdSecret ?? '').trim() : resolveRoutebookCredentialSecret(options.env);
  if (!secret) {
    throw credentialError('ROUTEBOOK_CREDENTIAL_SECRET_REQUIRED', 'A non-empty profile credential secret is required to hash a routebook edit token.');
  }
  return createHmac('sha256', `${secret}:profile-token`).update(token).digest('hex').slice(0, 18);
}

export function sanitizeRoutebookSnapshotCredentials(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw credentialError('INVALID_ROUTEBOOK_SNAPSHOT', 'A routebook snapshot must be a JSON object before credentials can be sanitized.');
  }
  const sanitized = scrubValue(value, '$', options);
  assertRoutebookSnapshotCredentialsSanitized(sanitized);
  return sanitized;
}

export function assertRoutebookSnapshotCredentialsSanitized(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRoutebookSnapshotCredentialsSanitized(entry, `${path}[${index}]`));
    return true;
  }
  if (!value || typeof value !== 'object') return true;
  for (const [key, nested] of Object.entries(value)) {
    const kind = credentialKeyKind(key);
    if (kind === 'edit-token' || kind === 'profile-access-token') {
      throw credentialError('PLAINTEXT_ROUTEBOOK_CREDENTIAL', `Routebook snapshot still contains a plaintext credential at ${path}.${key}.`);
    }
    if (kind === 'edit-token-hash') normalizeEditTokenHash(nested, `${path}.${key}`);
    assertRoutebookSnapshotCredentialsSanitized(nested, `${path}.${key}`);
  }
  return true;
}

function scrubValue(value, path, options) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => scrubValue(entry, `${path}[${index}]`, options));
  }
  if (!value || typeof value !== 'object') return value;

  const retained = [];
  let editTokenHash = '';
  for (const [key, nested] of Object.entries(value)) {
    const keyPath = `${path}.${key}`;
    const kind = credentialKeyKind(key);
    if (kind === 'profile-access-token') continue;
    if (kind === 'edit-token') {
      const token = normalizeLegacyEditToken(nested, keyPath);
      if (!token) continue;
      editTokenHash = mergeEditTokenHash(editTokenHash, hashRoutebookEditToken(token, options), keyPath);
      continue;
    }
    if (kind === 'edit-token-hash') {
      const normalizedHash = normalizeEditTokenHash(nested, keyPath);
      if (normalizedHash) editTokenHash = mergeEditTokenHash(editTokenHash, normalizedHash, keyPath);
      continue;
    }
    retained.push([key, scrubValue(nested, keyPath, options)]);
  }
  if (editTokenHash) retained.push(['editTokenHash', editTokenHash]);
  return Object.fromEntries(retained);
}

function normalizeLegacyEditToken(value, path) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw credentialError('INVALID_ROUTEBOOK_EDIT_TOKEN', `Routebook edit token at ${path} must be a string.`);
  }
  const token = value.trim();
  if (!token) return '';
  if (!EDIT_TOKEN_PATTERN.test(token)) {
    throw credentialError('INVALID_ROUTEBOOK_EDIT_TOKEN', `Routebook edit token at ${path} is outside the supported credential contract.`);
  }
  return token;
}

function normalizeEditTokenHash(value, path) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw credentialError('INVALID_ROUTEBOOK_EDIT_TOKEN_HASH', `Routebook edit token hash at ${path} must be a string.`);
  }
  const hash = value.trim().toLowerCase();
  if (!EDIT_TOKEN_HASH_PATTERN.test(hash)) {
    throw credentialError('INVALID_ROUTEBOOK_EDIT_TOKEN_HASH', `Routebook edit token hash at ${path} is outside the supported credential contract.`);
  }
  return hash;
}

function mergeEditTokenHash(current, incoming, path) {
  if (!current || current === incoming) return incoming || current;
  throw credentialError('ROUTEBOOK_EDIT_TOKEN_HASH_CONFLICT', `Routebook snapshot contains conflicting edit credentials at ${path}.`);
}

function credentialKeyKind(key) {
  const normalized = String(key ?? '')
    .replace(/[\s._-]+/g, '')
    .toLowerCase();
  if (normalized === 'edittoken') return 'edit-token';
  if (normalized === 'edittokenhash') return 'edit-token-hash';
  if (normalized === 'profileaccesstoken') return 'profile-access-token';
  return '';
}

function credentialError(code, message) {
  const error = /** @type {Error & Record<string, any>} */ (new Error(message));
  error.code = code;
  return error;
}

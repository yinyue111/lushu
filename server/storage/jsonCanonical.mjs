import { createHash } from 'node:crypto';

export function normalizeJsonObject(value, label = 'JSON value') {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    const wrapped = /** @type {TypeError & {code?: string}} */ (new TypeError(`${label} is not JSON-serializable: ${error.message}`));
    wrapped.code = 'INVALID_JSON_VALUE';
    throw wrapped;
  }
  if (serialized === undefined) {
    const error = /** @type {Error & Record<string, any>} */ (new TypeError(`${label} is not JSON-serializable`));
    error.code = 'INVALID_JSON_VALUE';
    throw error;
  }
  const normalized = JSON.parse(serialized);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    const error = /** @type {Error & Record<string, any>} */ (new TypeError(`${label} must be a JSON object`));
    error.code = 'JSON_OBJECT_REQUIRED';
    throw error;
  }
  return normalized;
}

export function canonicalJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

export function jsonSha256(value) {
  return sha256(canonicalJson(value));
}

export function eventSequenceSha256(rows) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(canonicalJson(row)).update('\n');
  return hash.digest('hex');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = sortJsonValue(value[key]);
    return output;
  }
  return value;
}

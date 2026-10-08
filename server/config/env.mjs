// Defensive environment parsing. `Number(process.env.X ?? d)` turns typos and
// empty strings into NaN/0 (e.g. RATE_LIMIT_MAX=abc made every request 429);
// these helpers fall back to the documented default and clamp to a sane range.

const warnedKeys = new Set();

function defaultWarn(message) {
  console.warn(`[config] ${message}`);
}

/**
 * Reads a numeric environment variable.
 * - unset / blank → fallback
 * - not a finite number (or not an integer when `integer`) → fallback + one warning
 * - outside [min, max] → clamped + one warning
 * @param {string} name
 * @param {number} fallback
 * @param {{ min?: number, max?: number, integer?: boolean, env?: Record<string, string | undefined>, warn?: (message: string) => void }} [options]
 * @returns {number}
 */
export function envNumber(name, fallback, options = {}) {
  const { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, integer = true, env = process.env, warn = defaultWarn } = options;
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  const warnOnce = (message) => {
    const key = `${name}:${raw}`;
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    warn(message);
  };
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    warnOnce(`${name}=${JSON.stringify(raw)} is not a valid ${integer ? 'integer' : 'number'}; using default ${fallback}`);
    return fallback;
  }
  if (value < min || value > max) {
    const clamped = Math.min(max, Math.max(min, value));
    warnOnce(`${name}=${value} is outside [${min}, ${max}]; using ${clamped}`);
    return clamped;
  }
  return value;
}

/**
 * Reads a boolean flag. Only the literal strings "true"/"false" (any case) count;
 * anything else yields the fallback.
 * @param {string} name
 * @param {boolean} fallback
 * @param {Record<string, string | undefined>} [env]
 */
export function envFlag(name, fallback, env = process.env) {
  const raw = String(env[name] ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

/** Test hook: forget which invalid values were already reported. */
export function resetEnvWarnings() {
  warnedKeys.clear();
}

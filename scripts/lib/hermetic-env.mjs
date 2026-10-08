import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Variables that change server behaviour. Tests must never inherit them from the
// developer's shell (real model keys, local bypass flags, secrets...).
const INHERITED_RUNTIME_KEYS =
  /^(OPENAI_|AI_|CODEX_|AMAP_|GEOCODE_|ROUTEBOOK_|PROFILE_|ALLOW_|REQUIRE_LOCAL_|TRUST_|TRUSTED_|RATE_LIMIT_|DATABASE_|STORAGE_BACKEND$|PUBLIC_BASE_URL$|MAX_|CHECKIN_|IMPORT_|MAP_TILE_|TIANDITU_|HOST$|PORT$|NODE_ENV$|VITE_)/;

/**
 * Builds an isolated environment for spawning server.mjs in tests.
 * The model runtime is "configured" with fake values pointing at a closed port,
 * so /api/health reports ready without any real credentials, and CODEX_HOME is
 * an empty temp dir so ~/.codex is never read.
 * @param {Record<string, string>} overrides
 */
export function hermeticServerEnv(overrides = {}) {
  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!INHERITED_RUNTIME_KEYS.test(key)) base[key] = value;
  }
  const codexHome = mkdtempSync(join(tmpdir(), 'routebook-test-codex-'));
  return {
    ...base,
    CODEX_HOME: codexHome,
    CODEX_CONFIG_PATH: join(codexHome, 'config.toml'),
    CODEX_AUTH_PATH: join(codexHome, 'auth.json'),
    AI_PROVIDER: 'test-fake',
    OPENAI_BASE_URL: 'http://127.0.0.1:9',
    OPENAI_API_KEY: 'test-fake-key',
    OPENAI_MODEL: 'test-fake-model',
    OPENAI_WIRE_API: 'responses',
    ...overrides
  };
}

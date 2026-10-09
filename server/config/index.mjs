// Runtime configuration derived from the environment (M5 split from server.mjs).
// Imported before anything else so every module sees the same values.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envNumber, envFlag } from './env.mjs';
import { resolveProfileIdSecret } from './startup-checks.mjs';
import { curatedRoutes } from '../../src/lib/content.js';
import { sanitizePublicId } from '../lib/util.mjs';
import { resolveMapTileProviders } from '../http/map-providers.mjs';

export const PORT = envNumber('PORT', 5173, { min: 0, max: 65535 });
export const HOST = process.env.HOST ?? '127.0.0.1';

// `--production` lets `npm start` work on every OS (no POSIX `NODE_ENV=... node` syntax).
if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST_DIR = join(PROJECT_ROOT, 'dist');
export const DATA_DIR = process.env.ROUTEBOOK_DATA_DIR ? resolve(process.env.ROUTEBOOK_DATA_DIR) : join(PROJECT_ROOT, 'data');
export const AI_LOG_PATH = join(DATA_DIR, 'ai-logs.jsonl');
export const CHECKIN_LOG_PATH = join(DATA_DIR, 'checkins.jsonl');
export const CLICK_LOG_PATH = join(DATA_DIR, 'clicks.jsonl');
export const EXPOSURE_LOG_PATH = join(DATA_DIR, 'exposures.jsonl');
export const ROUTEBOOK_LOG_PATH = join(DATA_DIR, 'routebooks.jsonl');
export const ROUTEBOOK_AUDIT_LOG_PATH = join(DATA_DIR, 'routebook-audits.jsonl');
export const PROFILE_LOG_PATH = join(DATA_DIR, 'profiles.jsonl');
export const POI_CORRECTION_LOG_PATH = join(DATA_DIR, 'poi-corrections.jsonl');
export const POI_KNOWLEDGE_LOG_PATH = join(DATA_DIR, 'poi-knowledge.jsonl');
export const POI_LOG_PATH = join(DATA_DIR, 'pois.jsonl');
export const REVIEW_LOG_PATH = join(DATA_DIR, 'reviews.jsonl');
export const IMPORT_LOG_PATH = join(DATA_DIR, 'imports.jsonl');
export const FAVORITE_LOG_PATH = join(DATA_DIR, 'favorites.jsonl');
export const CHECKIN_PHOTO_LOG_PATH = join(DATA_DIR, 'checkin-photos.jsonl');
export const CHECKIN_PHOTO_DIR = join(DATA_DIR, 'photos');
export const CMS_CONFIG_PATH = join(DATA_DIR, 'cms-config.json');
export const PRODUCT_CONFIG_PATH = join(DATA_DIR, 'product-config.json');
export const IDENTITY_NONCE_LOG_PATH = join(DATA_DIR, 'identity-nonces.jsonl');
export const OPS_AUDIT_LOG_PATH = join(DATA_DIR, 'ops-audits.jsonl');
export const TRIP_SESSION_LOG_PATH = join(DATA_DIR, 'trip-sessions.jsonl');
export const PROFILE_LIFECYCLE_LOG_PATH = join(DATA_DIR, 'profile-lifecycle.jsonl');
const CODEX_HOME = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
export const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH ?? join(CODEX_HOME, 'config.toml');
export const CODEX_AUTH_PATH = process.env.CODEX_AUTH_PATH ?? join(CODEX_HOME, 'auth.json');

// H6: the operator's personal Codex CLI config is only read in development unless
// explicitly enabled; production must use OPENAI_* env vars.
export const AI_RUNTIME_FROM_CODEX = envFlag('AI_RUNTIME_FROM_CODEX', !IS_PRODUCTION);
export const APP_ID = 'trusted-routebook';
export const MAX_JSON_BODY_BYTES = envNumber('MAX_JSON_BODY_BYTES', 1024 * 1024, { min: 1024 });
export const MAX_GUIDE_CHARS = envNumber('MAX_GUIDE_CHARS', 20000, { min: 100 });
export const MAX_IMPORT_URLS = envNumber('MAX_IMPORT_URLS', 5, { min: 1, max: 50 });
export const MAX_IMPORT_PAGE_BYTES = envNumber('MAX_IMPORT_PAGE_BYTES', 512 * 1024, { min: 1024 });
export const MAX_ROUTEBOOK_STOPS = envNumber('MAX_ROUTEBOOK_STOPS', 40, { min: 2, max: 500 });
export const MAX_OCR_IMAGES = envNumber('MAX_OCR_IMAGES', 4, { min: 1, max: 20 });
export const MAX_OCR_IMAGE_BYTES = envNumber('MAX_OCR_IMAGE_BYTES', 2 * 1024 * 1024, { min: 1024 });
export const MAX_OCR_REQUEST_BYTES = envNumber('MAX_OCR_REQUEST_BYTES', Math.ceil((MAX_OCR_IMAGES * MAX_OCR_IMAGE_BYTES * 4) / 3) + 64 * 1024, { min: 1024 });
export const IMPORT_TIMEOUT_MS = envNumber('IMPORT_TIMEOUT_MS', 12000, { min: 100 });
export const AI_TIMEOUT_MS = envNumber('AI_TIMEOUT_MS', 120000, { min: 1000 });

// A 12-stop Chinese routebook plus assets/validations/metrics does not fit in the
// old 2400-token budget; the retry limit covers the longest 3-day itineraries.
export const AI_MAX_OUTPUT_TOKENS = envNumber('AI_MAX_OUTPUT_TOKENS', 6000, { min: 256 });
export const AI_MAX_OUTPUT_TOKENS_RETRY = envNumber('AI_MAX_OUTPUT_TOKENS_RETRY', 12000, { min: 256 });
export const OCR_MAX_OUTPUT_TOKENS = envNumber('OCR_MAX_OUTPUT_TOKENS', 4000, { min: 256 });
export const RATE_LIMIT_WINDOW_MS = envNumber('RATE_LIMIT_WINDOW_MS', 60000, { min: 1000 });
export const RATE_LIMIT_MAX = envNumber('RATE_LIMIT_MAX', 12, { min: 1 });

// rank9 写限流分桶：埋点、AI、核心写与只读热点各自独立配额，互不挤兑。
export const RATE_LIMIT_TELEMETRY_MAX = envNumber('RATE_LIMIT_TELEMETRY_MAX', 60, { min: 1 });
export const RATE_LIMIT_CORE_WRITE_MAX = envNumber('RATE_LIMIT_CORE_WRITE_MAX', 24, { min: 1 });
export const RATE_LIMIT_MAP_TILE_MAX = envNumber('RATE_LIMIT_MAP_TILE_MAX', 300, { min: 1 });
export const RATE_LIMIT_PUBLIC_READ_MAX = envNumber('RATE_LIMIT_PUBLIC_READ_MAX', 60, { min: 1 });

// L9: cheap public config reads (cities/cms/products) get their own, larger bucket.
// Read-only ops listings (review queue, check-ins, imports, audits) per admin client.
export const RATE_LIMIT_OPS_READ_MAX = envNumber('RATE_LIMIT_OPS_READ_MAX', 120, { min: 1 });
// Phase 2 generation guard: identical requests within the TTL reuse the result
// (0 disables); registered profiles get N model generations per rolling window (0 disables).
export const GENERATION_DEDUP_TTL_MS = envNumber('GENERATION_DEDUP_TTL_MS', 10 * 60 * 1000, { min: 0 });
export const GENERATION_QUOTA_PER_PROFILE = envNumber('GENERATION_QUOTA_PER_PROFILE', 30, { min: 0 });
export const GENERATION_QUOTA_WINDOW_MS = envNumber('GENERATION_QUOTA_WINDOW_MS', 24 * 60 * 60 * 1000, { min: 60 * 1000 });
export const RATE_LIMIT_PUBLIC_CONFIG_MAX = envNumber('RATE_LIMIT_PUBLIC_CONFIG_MAX', 240, { min: 1 });
export const RATE_LIMIT_BUCKET_SWEEP_SIZE = 10000;

// rank13 打卡照片：解码后大小上限与 OCR 同级；请求体按 base64 膨胀预留余量。
export const MAX_CHECKIN_PHOTO_BYTES = envNumber('MAX_CHECKIN_PHOTO_BYTES', MAX_OCR_IMAGE_BYTES, { min: 1024 });
export const MAX_CHECKIN_PHOTO_REQUEST_BYTES = Math.ceil((MAX_CHECKIN_PHOTO_BYTES * 4) / 3) + 64 * 1024;
export const CHECKIN_PHOTO_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const CHECKIN_PHOTO_GPS_MATCH_METERS = 500;

// 照片上传配额：同一 profile 24 小时滚动窗口内最多 60 张。
export const CHECKIN_PHOTO_QUOTA_MAX = envNumber('CHECKIN_PHOTO_QUOTA_MAX', 60, { min: 1 });
export const CHECKIN_PHOTO_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

export const CHECKIN_PHOTO_EXTENSIONS = [
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp']
];

// rank18 GCJ02 双算：仅当 WGS84 直算距离落在该灰区时才尝试纠偏重算。
export const CHECKIN_COORDINATE_SYSTEMS = new Set(['unknown', 'wgs84', 'gcj02']);
export const CHECKIN_GCJ_CORRECTION_MIN_METERS = 250;
export const CHECKIN_GCJ_CORRECTION_MAX_METERS = 800;
export const PUBLIC_MODEL_PROXY_ALLOWED = process.env.ALLOW_PUBLIC_MODEL_PROXY === 'true';
export const API_TOKEN = process.env.ROUTEBOOK_API_TOKEN ?? '';
export const ADMIN_API_TOKEN = process.env.ROUTEBOOK_ADMIN_TOKEN ?? '';

// M2: the legacy fallback (admin token → API token → dev default) is kept so existing
// stored profile ids / token hashes stay valid; startup checks warn when it is used.
export const { secret: PROFILE_ID_SECRET, source: PROFILE_ID_SECRET_SOURCE } = resolveProfileIdSecret({
  profileIdSecret: process.env.PROFILE_ID_SECRET,
  adminToken: ADMIN_API_TOKEN,
  apiToken: API_TOKEN,
  isProduction: IS_PRODUCTION
});

const REQUIRE_LOCAL_ADMIN_TOKEN = process.env.REQUIRE_LOCAL_ADMIN_TOKEN === 'true';

export const ALLOW_LOCAL_API_BYPASS = process.env.ALLOW_LOCAL_API_BYPASS === 'true' || (!IS_PRODUCTION && process.env.ALLOW_LOCAL_API_BYPASS !== 'false');

export const ALLOW_LOCAL_ADMIN_BYPASS =
  process.env.ALLOW_LOCAL_ADMIN_BYPASS === 'true' || (!IS_PRODUCTION && !REQUIRE_LOCAL_ADMIN_TOKEN && process.env.ALLOW_LOCAL_ADMIN_BYPASS !== 'false');

export const PROFILE_IDENTITY_ASSERTION_SECRET = process.env.PROFILE_IDENTITY_ASSERTION_SECRET || '';
export const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === 'true';

// L4: canonical public origin for absolute URLs in share-page og:image tags.
export const PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);

function normalizePublicBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be an absolute http(s) URL, got ${JSON.stringify(text)}`);
  }
}

export const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXY_CIDRS ?? '127.0.0.1,::1')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

export const PUBLIC_ROUTE_STATUSES = new Set(['published', 'featured']);
export const ROUTEBOOK_STATUSES = new Set(['draft', 'pending_review', 'published', 'featured', 'archived']);
export const CURATED_ROUTE_VERSION = '2026-07-11T00:00:00.000Z';
export const CURATED_ROUTE_IDS = new Set(curatedRoutes.map((route) => sanitizePublicId(route.id)).filter(Boolean));
export const TRUST_FEEDBACK_SAMPLE_TARGET = envNumber('TRUST_FEEDBACK_SAMPLE_TARGET', 12, { min: 1 });
export const PUBLIC_TRUST_SAMPLE_THRESHOLD = 3;

// profile-owned = holds a server-issued profile token; profile-attested additionally
// bound a phone/WeChat identity. Both count as public samples; only attested is
// reported as strongly verified.
export const PUBLIC_TRUST_ELIGIBLE_STATES = new Set(['profile-attested', 'profile-owned']);
export const CHECKIN_TRUSTED_ACCURACY_METERS = envNumber('CHECKIN_TRUSTED_ACCURACY_METERS', 200, { min: 1, integer: false });
export const CHECKIN_MAX_REPORTED_ACCURACY_METERS = envNumber('CHECKIN_MAX_REPORTED_ACCURACY_METERS', 500, { min: 1, integer: false });
export const CHECKIN_MAX_PLAUSIBLE_KMH = envNumber('CHECKIN_MAX_PLAUSIBLE_KMH', 300, { min: 1, integer: false });
export const CHECKIN_PLAUSIBILITY_WINDOW_HOURS = envNumber('CHECKIN_PLAUSIBILITY_WINDOW_HOURS', 12, { min: 0, integer: false });
export const POI_FEEDBACK_WINDOW_DAYS = envNumber('POI_FEEDBACK_WINDOW_DAYS', 30, { min: 1, integer: false });
export const TRAVEL_DAY_TIME_ZONE = 'Asia/Shanghai';
export const TRAVEL_DAY_WINDOW_DAYS = 1;

export const TRAVEL_DAY_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TRAVEL_DAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export const AMAP_GEOCODE_KEY = String(process.env.AMAP_GEOCODE_KEY ?? '').trim();
export const AMAP_ROUTING_KEY = String(process.env.AMAP_ROUTING_KEY ?? AMAP_GEOCODE_KEY).trim();
export const ROUTING_TIMEOUT_MS = envNumber('ROUTING_TIMEOUT_MS', 8000, { min: 100, max: 60000 });
export const ROUTING_CONCURRENCY = envNumber('ROUTING_CONCURRENCY', 3, { min: 1, max: 8 });
export const GEOCODE_TIMEOUT_MS = envNumber('GEOCODE_TIMEOUT_MS', 5000, { min: 100 });
export const MAP_TILE_TIMEOUT_MS = envNumber('MAP_TILE_TIMEOUT_MS', 12000, { min: 3000, max: 30000 });
export const MAP_TILE_UPSTREAM_TIMEOUT_MS = envNumber('MAP_TILE_UPSTREAM_TIMEOUT_MS', 4000, { min: 1000, max: 10000 });
export const MAP_TILE_CACHE_MAX_ENTRIES = envNumber('MAP_TILE_CACHE_MAX_ENTRIES', 600, { min: 50, max: 5000 });
export const MAP_TILE_MAX_BYTES = envNumber('MAP_TILE_MAX_BYTES', 1024 * 1024, { min: 64 * 1024, max: 4 * 1024 * 1024 });

// Ordered basemap providers (see server/http/map-providers.mjs and .env.example).
const resolvedMapTileProviders = resolveMapTileProviders(process.env);
export const MAP_TILE_UPSTREAMS = resolvedMapTileProviders.providers;
export const MAP_TILE_SKIPPED_PROVIDERS = resolvedMapTileProviders.skipped;
// After a provider serves a placeholder or keeps failing it is skipped for this long.
export const MAP_TILE_PROVIDER_COOLDOWN_MS = envNumber('MAP_TILE_PROVIDER_COOLDOWN_MS', 10 * 60 * 1000, { min: 1000 });

export const MIME_TYPES = {
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

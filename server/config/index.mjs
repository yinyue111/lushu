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
export const POI_MERGE_LOG_PATH = join(DATA_DIR, 'poi-merges.jsonl');
export const MODERATION_QUEUE_LOG_PATH = join(DATA_DIR, 'moderation-queue.jsonl');
export const SHADOW_JUDGMENT_LOG_PATH = join(DATA_DIR, 'shadow-judgments.jsonl');
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
// Real models (e.g. grok-4.7 via a relay) take 140-180 s for a 2-day routebook, so the
// default leaves headroom; every other timeout on the generation path derives from it.
// AI_TIMEOUT_MS is the budget for one whole generation (every model call + geocoding + routing).
export const AI_TIMEOUT_MS = envNumber('AI_TIMEOUT_MS', 300000, { min: 1000 });
// One model request may take at most this long (and never past the generation budget).
export const AI_CALL_TIMEOUT_MS = envNumber('AI_CALL_TIMEOUT_MS', AI_TIMEOUT_MS, { min: 1000 });

// Generation modes. 轻快 (fast): a quick model with a short budget; 细品 (deep): the slower reasoning model.
// Empty AI_MODEL_DEEP keeps OPENAI_MODEL. Each mode has its own total budget, output cap and stream idle timeout.
export const GENERATION_MODE_KEYS = /** @type {const} */ (['fast', 'deep']);
const defaultModeEnv = String(process.env.GENERATION_DEFAULT_MODE ?? 'fast').trim();
// Optional extra cap on 细品 generations per profile inside GENERATION_QUOTA_WINDOW_MS (0 = only the shared quota).
export const GENERATION_QUOTA_DEEP_PER_PROFILE = envNumber('GENERATION_QUOTA_DEEP_PER_PROFILE', 0, { min: 0 });
export const GENERATION_DEFAULT_MODE = defaultModeEnv === 'deep' ? 'deep' : 'fast';
// Stream model output (SSE): detects a stuck upstream within AI_STREAM_IDLE_MS_* instead of after the whole budget.
export const AI_STREAM =
  String(process.env.AI_STREAM ?? 'true')
    .trim()
    .toLowerCase() !== 'false';
// Optional reasoning effort sent to the model (low | medium | high | xhigh; the relay silently ignores unknown values). Empty = not sent: the model/relay default applies.
// For Gemini on the relay the thinking tier is chosen by the model id suffix (-low / -medium / -high) instead.
function reasoningEffortEnv(name, fallback = '') {
  const value = String(process.env[name] ?? fallback)
    .trim()
    .toLowerCase();
  return ['low', 'medium', 'high', 'xhigh'].includes(value) ? value : '';
}
export const GENERATION_MODES = {
  fast: {
    key: 'fast',
    label: '轻快',
    model: String(process.env.AI_MODEL_FAST ?? 'gemini-3.8-flash-high').trim(),
    timeoutMs: envNumber('AI_TIMEOUT_MS_FAST', Math.min(120000, AI_TIMEOUT_MS), { min: 1000 }),
    maxOutputTokens: envNumber('AI_MAX_OUTPUT_TOKENS_FAST', 12000, { min: 256 }),
    idleTimeoutMs: envNumber('AI_STREAM_IDLE_MS_FAST', 30000, { min: 1000 }),
    reasoningEffort: reasoningEffortEnv('AI_REASONING_EFFORT_FAST'),
    typicalSeconds: [20, 45]
  },
  deep: {
    key: 'deep',
    label: '细品',
    model: String(process.env.AI_MODEL_DEEP ?? '').trim(),
    timeoutMs: envNumber('AI_TIMEOUT_MS_DEEP', AI_TIMEOUT_MS, { min: 1000 }),
    maxOutputTokens: envNumber('AI_MAX_OUTPUT_TOKENS_DEEP', 12000, { min: 256 }),
    idleTimeoutMs: envNumber('AI_STREAM_IDLE_MS_DEEP', 150000, { min: 1000 }),
    // grok-4.7 without the parameter was the slowest in tests (>200 s); xhigh measured about as fast as high.
    reasoningEffort: reasoningEffortEnv('AI_REASONING_EFFORT_DEEP', 'xhigh'),
    typicalSeconds: [90, 180]
  }
};
/** @param {unknown} value @returns {'fast' | 'deep'} */
export function resolveGenerationMode(value) {
  return value === 'fast' || value === 'deep' ? value : GENERATION_DEFAULT_MODE;
}
// The synchronous /api/generate-routebook request (legacy) must outlive the model call
// plus geocoding/routing; node's requestTimeout would otherwise cut it first.
export const REQUEST_TIMEOUT_MS = envNumber('REQUEST_TIMEOUT_MS', AI_TIMEOUT_MS + 90000, { min: 0 });
// Async generation jobs: finished jobs stay readable (page reload / resume) this long.
export const GENERATION_JOB_RETENTION_MS = envNumber('GENERATION_JOB_RETENTION_MS', 30 * 60 * 1000, { min: 60 * 1000 });
// Running jobs per client (IP / profile); cancelling one frees the slot immediately.
export const GENERATION_MAX_ACTIVE_JOBS = envNumber('GENERATION_MAX_ACTIVE_JOBS', 2, { min: 1, max: 20 });
// Long-poll window for GET /api/generation-jobs/:id?after=<seq>.
export const GENERATION_JOB_POLL_WAIT_MS = envNumber('GENERATION_JOB_POLL_WAIT_MS', 15000, { min: 0, max: 60000 });

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
// Owner-triggered re-geocode + road re-verification (AMap quota): per client per window.
export const RATE_LIMIT_RECHECK_MAX = envNumber('RATE_LIMIT_RECHECK_MAX', 6, { min: 1 });
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
// Routebooks generated from imported third-party guides (X/小红书/抖音/links/OCR):
// - unlisted-unless-authorized (default): private or friend link only; public listing
//   only after the user claims original authorship and ops authorize every source.
// - unlisted-only: never publicly listed.
// - authorization-required: legacy behaviour (owner may submit; ops source gate decides).
export const IMPORTED_ROUTEBOOK_PUBLIC_POLICIES = ['unlisted-unless-authorized', 'unlisted-only', 'authorization-required'];
export const IMPORTED_ROUTEBOOK_PUBLIC_POLICY = IMPORTED_ROUTEBOOK_PUBLIC_POLICIES.includes(String(process.env.IMPORTED_ROUTEBOOK_PUBLIC_POLICY ?? ''))
  ? String(process.env.IMPORTED_ROUTEBOOK_PUBLIC_POLICY)
  : 'unlisted-unless-authorized';
// PUBLIC_PUBLISHING=disabled turns public listing off for every routebook (owners and ops):
// routebooks stay private or go out as friend links. Already-public routebooks are untouched.
export const PUBLIC_PUBLISHING_ENABLED =
  String(process.env.PUBLIC_PUBLISHING ?? 'enabled')
    .trim()
    .toLowerCase() !== 'disabled';
// ---- Accounts (phone + password) -------------------------------------------------------------
// AUTH_MODE: access-code (default, today's behaviour) | both (login or access code) | login (login only).
// Rolling back is setting AUTH_MODE=access-code again; account tables stay and are simply unused.
const AUTH_MODES = ['access-code', 'both', 'login'];
export const AUTH_MODE = AUTH_MODES.includes(String(process.env.AUTH_MODE ?? '').trim()) ? String(process.env.AUTH_MODE).trim() : 'access-code';
export const AUTH_ENABLED = AUTH_MODE !== 'access-code';
const REGISTRATION_MODES = ['open', 'invite', 'closed'];
export const REGISTRATION_MODE = REGISTRATION_MODES.includes(String(process.env.REGISTRATION_MODE ?? '').trim())
  ? String(process.env.REGISTRATION_MODE).trim()
  : 'invite';
// The invite code falls back to the old access code so testers keep using what they already have.
export const REGISTRATION_INVITE_CODE = String(process.env.REGISTRATION_INVITE_CODE || API_TOKEN || '').trim();
// HMAC key for phone lookups. Losing it makes every account unfindable: back it up.
export const AUTH_PHONE_HASH_SECRET = String(process.env.AUTH_PHONE_HASH_SECRET ?? '').trim() || (IS_PRODUCTION ? '' : `dev-only:${PROFILE_ID_SECRET}:phone`);
export const AUTH_PASSWORD_PEPPER = String(process.env.AUTH_PASSWORD_PEPPER ?? '');
export const AUTH_SESSION_TTL_DAYS = envNumber('AUTH_SESSION_TTL_DAYS', 30, { min: 1 });
export const AUTH_SESSION_MAX_DAYS = envNumber('AUTH_SESSION_MAX_DAYS', 90, { min: 1 });
// Secure __Host- cookie everywhere by default (browsers accept Secure cookies on http://localhost).
// AUTH_COOKIE_SECURE=false is a dev-only escape hatch for other http hosts and is ignored in production.
export const AUTH_COOKIE_SECURE = IS_PRODUCTION || process.env.AUTH_COOKIE_SECURE !== 'false';
export const AUTH_POW_DIFFICULTY = envNumber('AUTH_POW_DIFFICULTY', 16, { min: 0 });
export const AUTH_SCRYPT_CONCURRENCY = envNumber('AUTH_SCRYPT_CONCURRENCY', 2, { min: 1 });
// ---- Email (verification codes, password reset) ---------------------------------------------
// Emails are stored as an HMAC (lookup/uniqueness), AES-256-GCM ciphertext (to send mail) and a mask.
export const AUTH_EMAIL_HASH_SECRET = String(process.env.AUTH_EMAIL_HASH_SECRET ?? '').trim() || (IS_PRODUCTION ? '' : `dev-only:${PROFILE_ID_SECRET}:email`);
export const AUTH_EMAIL_ENC_KEY = String(process.env.AUTH_EMAIL_ENC_KEY ?? '').trim() || (IS_PRODUCTION ? '' : `dev-only:${PROFILE_ID_SECRET}:email-enc`);
// false only while mail delivery is not set up: accounts are created with an unverified email.
export const EMAIL_VERIFICATION_REQUIRED =
  String(process.env.EMAIL_VERIFICATION_REQUIRED ?? 'true')
    .trim()
    .toLowerCase() !== 'false';
const MAIL_TRANSPORTS = ['file', 'log', 'resend', 'smtp', 'disabled'];
const mailTransportEnv = String(process.env.MAIL_TRANSPORT ?? '')
  .trim()
  .toLowerCase();
export const MAIL_TRANSPORT = MAIL_TRANSPORTS.includes(mailTransportEnv) ? mailTransportEnv : IS_PRODUCTION ? 'disabled' : 'file';
export const MAIL_TRANSPORT_INVALID = Boolean(mailTransportEnv) && !MAIL_TRANSPORTS.includes(mailTransportEnv);
// Minimum gap between two codes to the same address.
export const EMAIL_CODE_RESEND_SECONDS = envNumber('EMAIL_CODE_RESEND_SECONDS', 60, { min: 0 });
export const MAIL_FROM = String(process.env.MAIL_FROM ?? '').trim() || (IS_PRODUCTION ? '' : '路书 <no-reply@localhost>');
export const MAIL_API_KEY = String(process.env.MAIL_API_KEY ?? '').trim();
export const MAIL_API_URL = String(process.env.MAIL_API_URL ?? 'https://api.resend.com/emails').trim();
// SMTP (e.g. the mail server on our own host). SECURE: tls (implicit TLS, 465) | starttls (587, TLS required) | none (plain, loopback only).
const SMTP_SECURE_MODES = ['tls', 'starttls', 'none'];
const smtpSecureEnv = String(process.env.MAIL_SMTP_SECURE ?? 'starttls')
  .trim()
  .toLowerCase();
export const MAIL_SMTP_SECURE = SMTP_SECURE_MODES.includes(smtpSecureEnv) ? smtpSecureEnv : 'invalid';
export const MAIL_SMTP_HOST = String(process.env.MAIL_SMTP_HOST ?? '').trim();
export const MAIL_SMTP_PORT = envNumber('MAIL_SMTP_PORT', MAIL_SMTP_SECURE === 'tls' ? 465 : MAIL_SMTP_SECURE === 'none' ? 25 : 587, { min: 1 });
export const MAIL_SMTP_USER = String(process.env.MAIL_SMTP_USER ?? '').trim();
export const MAIL_SMTP_PASS = String(process.env.MAIL_SMTP_PASS ?? '');
// Certificate verification is on unless explicitly turned off (never do that in production).
export const MAIL_SMTP_TLS_VERIFY =
  String(process.env.MAIL_SMTP_TLS_VERIFY ?? 'true')
    .trim()
    .toLowerCase() !== 'false';
// Optional PEM bundle to trust (a private CA); public CAs are trusted by default.
export const MAIL_SMTP_CA_FILE = String(process.env.MAIL_SMTP_CA_FILE ?? '').trim();
// Opt-in for SECURE=none to a private IP literal (e.g. host Postfix on the Docker bridge gateway). Public hosts are always refused.
export const MAIL_SMTP_ALLOW_PLAINTEXT_PRIVATE =
  String(process.env.MAIL_SMTP_ALLOW_PLAINTEXT_PRIVATE ?? '')
    .trim()
    .toLowerCase() === 'true';
export const MAIL_SMTP_TIMEOUT_MS = envNumber('MAIL_SMTP_TIMEOUT_MS', 15000, { min: 1000 });
export const MAIL_OUTBOX_DIR = String(process.env.MAIL_OUTBOX_DIR ?? '').trim() || join(DATA_DIR, 'mail-outbox');

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
// An empty AMAP_ROUTING_KEY= line (common in .env templates) must fall back too, not disable routing.
export const AMAP_ROUTING_KEY = String(process.env.AMAP_ROUTING_KEY ?? '').trim() || AMAP_GEOCODE_KEY;
export const ROUTING_TIMEOUT_MS = envNumber('ROUTING_TIMEOUT_MS', 8000, { min: 100, max: 60000 });
export const ROUTING_CONCURRENCY = envNumber('ROUTING_CONCURRENCY', 3, { min: 1, max: 8 });
// Requests per second across all AMap Web-service calls (personal keys: about 3).
export const AMAP_QPS = envNumber('AMAP_QPS', 3, { min: 1, max: 200 });
export const AMAP_API_BASE_URL = String(process.env.AMAP_API_BASE_URL ?? '').trim() || 'https://restapi.amap.com';
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

// Content moderation (see docs/compliance.md). keyword = local pre-filter only (default);
// domestic = pre-filter + domestic content-safety API adapter; none = disabled (dev only).
export const MODERATION_PROVIDER = ['keyword', 'domestic', 'none'].includes(String(process.env.MODERATION_PROVIDER ?? '').trim())
  ? String(process.env.MODERATION_PROVIDER).trim()
  : 'keyword';
export const MODERATION_KEYWORDS_FILE = String(process.env.MODERATION_KEYWORDS_FILE ?? '').trim();
export const MODERATION_API_URL = String(process.env.MODERATION_API_URL ?? '').trim();
export const MODERATION_API_KEY = String(process.env.MODERATION_API_KEY ?? '').trim();
export const MODERATION_TIMEOUT_MS = envNumber('MODERATION_TIMEOUT_MS', 3000, { min: 200, max: 20000 });

// Jev (TypeSafe System One) shadow mode — off by default, never changes behaviour
// (docs/jev-pilot.md). Enabled only when JEV_SHADOW_ENABLED=true and TYPESAFE_API_KEY is set.
export const TYPESAFE_API_KEY = String(process.env.TYPESAFE_API_KEY ?? '').trim();
export const JEV_SHADOW_ENABLED = process.env.JEV_SHADOW_ENABLED === 'true';
export const JEV_API_URL = String(process.env.JEV_API_URL ?? '').trim() || 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = String(process.env.JEV_MODEL ?? '').trim() || 'jev-latest';
export const JEV_SHADOW_TIMEOUT_MS = envNumber('JEV_SHADOW_TIMEOUT_MS', 800, { min: 100, max: 10000 });
export const JEV_SHADOW_SAMPLE_RATE = envNumber('JEV_SHADOW_SAMPLE_RATE', 1, { min: 0, max: 1, integer: false });
export const JEV_SHADOW_MAX_IN_FLIGHT = envNumber('JEV_SHADOW_MAX_IN_FLIGHT', 8, { min: 1, max: 64 });

// Background fact enrichment (logged-in users only): after a routebook is saved, ticket price / 免费 and
// opening hours of scenic stops are looked up (AMap first, then web search through the relay's Responses
// API) and kept only when two independent sources agree. See docs/deploy.md「联网补全」.
export const ENRICH_ENABLED = envFlag('ENRICH_ENABLED', false);
export const ENRICH_MODEL = String(process.env.ENRICH_MODEL ?? 'grok-4.7').trim();
export const ENRICH_BASE_URL = String(process.env.ENRICH_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');
export const ENRICH_API_KEY = String(process.env.ENRICH_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim();
export const ENRICH_DAILY_BUDGET_USD = envNumber('ENRICH_DAILY_BUDGET_USD', 5, { min: 0 });
export const ENRICH_MAX_SEARCHES_PER_ROUTEBOOK = envNumber('ENRICH_MAX_SEARCHES_PER_ROUTEBOOK', 5, { min: 0, max: 50 });
export const ENRICH_MAX_USD_PER_ROUTEBOOK = envNumber('ENRICH_MAX_USD_PER_ROUTEBOOK', 0.3, { min: 0 });
// Used when the relay does not report a cost for a search call.
export const ENRICH_ASSUMED_USD_PER_SEARCH = envNumber('ENRICH_ASSUMED_USD_PER_SEARCH', 0.1, { min: 0 });
export const ENRICH_CONCURRENCY = envNumber('ENRICH_CONCURRENCY', 2, { min: 1, max: 10 });
export const ENRICH_MAX_ATTEMPTS = envNumber('ENRICH_MAX_ATTEMPTS', 4, { min: 1, max: 20 });
export const ENRICH_RETRY_BASE_MS = envNumber('ENRICH_RETRY_BASE_MS', 60000, { min: 100 });
// A job whose worker died (restart, crash) is picked up again once its lease runs out.
export const ENRICH_LEASE_MS = envNumber('ENRICH_LEASE_MS', 10 * 60 * 1000, { min: 500 });
export const ENRICH_POLL_MS = envNumber('ENRICH_POLL_MS', 5000, { min: 50 });
export const ENRICH_CACHE_DAYS = envNumber('ENRICH_CACHE_DAYS', 7, { min: 0 });
export const ENRICH_SEARCH_TIMEOUT_MS = envNumber('ENRICH_SEARCH_TIMEOUT_MS', 120000, { min: 1000 });
export const ENRICH_PAGE_TIMEOUT_MS = envNumber('ENRICH_PAGE_TIMEOUT_MS', 10000, { min: 500 });
export const ENRICH_PAGE_MAX_BYTES = envNumber('ENRICH_PAGE_MAX_BYTES', 2 * 1024 * 1024, { min: 1024 });
// Sites whose terms forbid automated access or that need a login. Never fetched, never cited.
export const ENRICH_BLOCKED_DOMAINS = String(
  process.env.ENRICH_BLOCKED_DOMAINS ??
    'dianping.com,meituan.com,xiaohongshu.com,xhslink.com,douyin.com,weibo.com,weibo.cn,zhihu.com,ctrip.com,trip.com,qunar.com,ly.com,mafengwo.cn'
)
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
// Test hook only (never set in production): lets integration tests point the page fetcher at a local mock server.
export const ENRICH_ALLOW_PRIVATE_FETCH_FOR_TESTS = envFlag('ENRICH_ALLOW_PRIVATE_FETCH_FOR_TESTS', false);

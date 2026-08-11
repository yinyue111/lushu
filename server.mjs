import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { access, appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createNetServer, isIP } from 'node:net';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { cities as supportedCities, getRegionForCity, isSupportedCity, regionCenters, regionCityGroups } from './src/lib/chinaCities.js';
import { curatedRoutes, curatedRouteToRoutebook, cityStories, defaultCityImage, productCards as seedProductCards } from './src/lib/content.js';

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(PROJECT_ROOT, 'dist');
const DATA_DIR = process.env.ROUTEBOOK_DATA_DIR ? resolve(process.env.ROUTEBOOK_DATA_DIR) : join(PROJECT_ROOT, 'data');
const AI_LOG_PATH = join(DATA_DIR, 'ai-logs.jsonl');
const CHECKIN_LOG_PATH = join(DATA_DIR, 'checkins.jsonl');
const CLICK_LOG_PATH = join(DATA_DIR, 'clicks.jsonl');
const EXPOSURE_LOG_PATH = join(DATA_DIR, 'exposures.jsonl');
const ROUTEBOOK_LOG_PATH = join(DATA_DIR, 'routebooks.jsonl');
const ROUTEBOOK_AUDIT_LOG_PATH = join(DATA_DIR, 'routebook-audits.jsonl');
const PROFILE_LOG_PATH = join(DATA_DIR, 'profiles.jsonl');
const POI_CORRECTION_LOG_PATH = join(DATA_DIR, 'poi-corrections.jsonl');
const POI_KNOWLEDGE_LOG_PATH = join(DATA_DIR, 'poi-knowledge.jsonl');
const POI_LOG_PATH = join(DATA_DIR, 'pois.jsonl');
const REVIEW_LOG_PATH = join(DATA_DIR, 'reviews.jsonl');
const IMPORT_LOG_PATH = join(DATA_DIR, 'imports.jsonl');
const FAVORITE_LOG_PATH = join(DATA_DIR, 'favorites.jsonl');
const CHECKIN_PHOTO_LOG_PATH = join(DATA_DIR, 'checkin-photos.jsonl');
const CHECKIN_PHOTO_DIR = join(DATA_DIR, 'photos');
const CMS_CONFIG_PATH = join(DATA_DIR, 'cms-config.json');
const PRODUCT_CONFIG_PATH = join(DATA_DIR, 'product-config.json');
const CODEX_HOME = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH ?? join(CODEX_HOME, 'config.toml');
const CODEX_AUTH_PATH = process.env.CODEX_AUTH_PATH ?? join(CODEX_HOME, 'auth.json');
const DEFAULT_MODEL = 'gpt-5.5';
const APP_ID = 'trusted-routebook';
const JSONL_SCAN_CHUNK_BYTES = 256 * 1024;
const JSONL_NEWLINE_BYTE = 0x0a;
const JSONL_EMPTY_BUFFER = Buffer.alloc(0);
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES ?? 1024 * 1024);
const MAX_GUIDE_CHARS = Number(process.env.MAX_GUIDE_CHARS ?? 20000);
const MAX_IMPORT_URLS = Number(process.env.MAX_IMPORT_URLS ?? 5);
const MAX_IMPORT_PAGE_BYTES = Number(process.env.MAX_IMPORT_PAGE_BYTES ?? 512 * 1024);
const MAX_ROUTEBOOK_STOPS = Number(process.env.MAX_ROUTEBOOK_STOPS ?? 40);
const MAX_OCR_IMAGES = Number(process.env.MAX_OCR_IMAGES ?? 4);
const MAX_OCR_IMAGE_BYTES = Number(process.env.MAX_OCR_IMAGE_BYTES ?? 2 * 1024 * 1024);
const MAX_OCR_REQUEST_BYTES = Number(process.env.MAX_OCR_REQUEST_BYTES ?? Math.ceil(MAX_OCR_IMAGES * MAX_OCR_IMAGE_BYTES * 4 / 3) + 64 * 1024);
const IMPORT_TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS ?? 12000);
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 120000);
// A 12-stop Chinese routebook plus assets/validations/metrics does not fit in the
// old 2400-token budget; the retry limit covers the longest 3-day itineraries.
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS ?? 6000);
const AI_MAX_OUTPUT_TOKENS_RETRY = Number(process.env.AI_MAX_OUTPUT_TOKENS_RETRY ?? 12000);
const OCR_MAX_OUTPUT_TOKENS = Number(process.env.OCR_MAX_OUTPUT_TOKENS ?? 4000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 12);
// rank9 写限流分桶：埋点、AI、核心写与只读热点各自独立配额，互不挤兑。
const RATE_LIMIT_TELEMETRY_MAX = Number(process.env.RATE_LIMIT_TELEMETRY_MAX ?? 60);
const RATE_LIMIT_CORE_WRITE_MAX = Number(process.env.RATE_LIMIT_CORE_WRITE_MAX ?? 24);
const RATE_LIMIT_MAP_TILE_MAX = Number(process.env.RATE_LIMIT_MAP_TILE_MAX ?? 300);
const RATE_LIMIT_PUBLIC_READ_MAX = Number(process.env.RATE_LIMIT_PUBLIC_READ_MAX ?? 60);
const RATE_LIMIT_BUCKET_SWEEP_SIZE = 10000;
// rank13 打卡照片：解码后大小上限与 OCR 同级；请求体按 base64 膨胀预留余量。
const MAX_CHECKIN_PHOTO_BYTES = Number(process.env.MAX_CHECKIN_PHOTO_BYTES ?? MAX_OCR_IMAGE_BYTES);
const MAX_CHECKIN_PHOTO_REQUEST_BYTES = Math.ceil(MAX_CHECKIN_PHOTO_BYTES * 4 / 3) + 64 * 1024;
const CHECKIN_PHOTO_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CHECKIN_PHOTO_GPS_MATCH_METERS = 500;
// 照片上传配额：同一 profile 24 小时滚动窗口内最多 60 张。
const CHECKIN_PHOTO_QUOTA_MAX = Number(process.env.CHECKIN_PHOTO_QUOTA_MAX ?? 60);
const CHECKIN_PHOTO_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHECKIN_PHOTO_EXTENSIONS = [
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp']
];
// rank18 GCJ02 双算：仅当 WGS84 直算距离落在该灰区时才尝试纠偏重算。
const CHECKIN_COORDINATE_SYSTEMS = new Set(['unknown', 'wgs84', 'gcj02']);
const CHECKIN_GCJ_CORRECTION_MIN_METERS = 250;
const CHECKIN_GCJ_CORRECTION_MAX_METERS = 800;
const PUBLIC_MODEL_PROXY_ALLOWED = process.env.ALLOW_PUBLIC_MODEL_PROXY === 'true';
const API_TOKEN = process.env.ROUTEBOOK_API_TOKEN ?? '';
const ADMIN_API_TOKEN = process.env.ROUTEBOOK_ADMIN_TOKEN ?? '';
const PROFILE_ID_SECRET = process.env.PROFILE_ID_SECRET || ADMIN_API_TOKEN || API_TOKEN || (IS_PRODUCTION ? '' : 'trusted-routebook-local-profile-id-v1');
if (!PROFILE_ID_SECRET) {
  throw new Error('PROFILE_ID_SECRET must be set in production, or provide ROUTEBOOK_ADMIN_TOKEN/ROUTEBOOK_API_TOKEN as a fallback secret.');
}
const REQUIRE_LOCAL_ADMIN_TOKEN = process.env.REQUIRE_LOCAL_ADMIN_TOKEN === 'true';
const ALLOW_LOCAL_API_BYPASS = process.env.ALLOW_LOCAL_API_BYPASS === 'true' ||
  (!IS_PRODUCTION && process.env.ALLOW_LOCAL_API_BYPASS !== 'false');
const ALLOW_LOCAL_ADMIN_BYPASS = process.env.ALLOW_LOCAL_ADMIN_BYPASS === 'true' ||
  (!IS_PRODUCTION && !REQUIRE_LOCAL_ADMIN_TOKEN && process.env.ALLOW_LOCAL_ADMIN_BYPASS !== 'false');
const PROFILE_IDENTITY_ASSERTION_SECRET = process.env.PROFILE_IDENTITY_ASSERTION_SECRET || '';
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === 'true';
const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXY_CIDRS ?? '127.0.0.1,::1')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const PUBLIC_ROUTE_STATUSES = new Set(['published', 'featured']);
const ROUTEBOOK_STATUSES = new Set(['draft', 'published', 'featured', 'archived']);
const CURATED_ROUTE_VERSION = '2026-07-11T00:00:00.000Z';
const CURATED_ROUTE_IDS = new Set(curatedRoutes.map((route) => sanitizePublicId(route.id)).filter(Boolean));
const TRUST_FEEDBACK_SAMPLE_TARGET = Number(process.env.TRUST_FEEDBACK_SAMPLE_TARGET ?? 12);
const PUBLIC_TRUST_SAMPLE_THRESHOLD = 3;
// profile-owned = holds a server-issued profile token; profile-attested additionally
// bound a phone/WeChat identity. Both count as public samples; only attested is
// reported as strongly verified.
const PUBLIC_TRUST_ELIGIBLE_STATES = new Set(['profile-attested', 'profile-owned']);
const CHECKIN_TRUSTED_ACCURACY_METERS = Number(process.env.CHECKIN_TRUSTED_ACCURACY_METERS ?? 200);
const CHECKIN_MAX_REPORTED_ACCURACY_METERS = Number(process.env.CHECKIN_MAX_REPORTED_ACCURACY_METERS ?? 500);
const CHECKIN_MAX_PLAUSIBLE_KMH = Number(process.env.CHECKIN_MAX_PLAUSIBLE_KMH ?? 300);
const CHECKIN_PLAUSIBILITY_WINDOW_HOURS = Number(process.env.CHECKIN_PLAUSIBILITY_WINDOW_HOURS ?? 12);
const POI_FEEDBACK_WINDOW_DAYS = Number(process.env.POI_FEEDBACK_WINDOW_DAYS ?? 30);
const TRAVEL_DAY_TIME_ZONE = 'Asia/Shanghai';
const TRAVEL_DAY_WINDOW_DAYS = 1;
const TRAVEL_DAY_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TRAVEL_DAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const AMAP_GEOCODE_KEY = String(process.env.AMAP_GEOCODE_KEY ?? '').trim();
const GEOCODE_TIMEOUT_MS = Number(process.env.GEOCODE_TIMEOUT_MS ?? 5000);
const geocodeCache = new Map();
const MAP_TILE_TIMEOUT_MS = Math.max(3000, Math.min(30000, Number(process.env.MAP_TILE_TIMEOUT_MS) || 12000));
const MAP_TILE_UPSTREAM_TIMEOUT_MS = Math.max(1000, Math.min(10000, Number(process.env.MAP_TILE_UPSTREAM_TIMEOUT_MS) || 4000));
const MAP_TILE_CACHE_MAX_ENTRIES = Math.max(50, Math.min(5000, Number(process.env.MAP_TILE_CACHE_MAX_ENTRIES) || 600));
const MAP_TILE_MAX_BYTES = Math.max(64 * 1024, Math.min(4 * 1024 * 1024, Number(process.env.MAP_TILE_MAX_BYTES) || 1024 * 1024));
const MAP_TILE_UPSTREAMS = [
  { id: 'carto-light', hostname: 'a.basemaps.cartocdn.com', path: (key) => `/light_all/${key}.png` },
  { id: 'osm-de', hostname: 'tile.openstreetmap.de', path: (key) => `/${key}.png` },
  { id: 'osm-fr', hostname: 'a.tile.openstreetmap.fr', path: (key) => `/hot/${key}.png` }
];
const mapTileCache = new Map();
const MIME_TYPES = {
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
const rateLimitBuckets = new Map();
const checkinIdempotencyLocks = new Map();
const poiCatalogMutationLocks = new Map();
const routebookMutationLocks = new Map();
const profileMutationLocks = new Map();

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), payment=()'
};
const STATIC_CONNECT_SOURCES = [
  "'self'",
  ...(!IS_PRODUCTION ? ["http://127.0.0.1:*", "ws://127.0.0.1:*"] : [])
];
const STATIC_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${STATIC_CONNECT_SOURCES.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

function securityHeaders(extra = {}) {
  return {
    ...SECURITY_HEADERS,
    ...extra
  };
}

async function appendJsonLine(filePath, payload) {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  // rank23 读放大治理：写后主动失效对应文件的行缓存/派生缓存。
  invalidateJsonlRowsCache(filePath);
  if (filePath === POI_LOG_PATH) invalidateMergedPoiCache();
  if (filePath === ROUTEBOOK_LOG_PATH) await noteRoutebookVersionAppend(payload);
}

// rank23②：(path, mtimeMs, size) 键的进程级 JSONL 尾窗行缓存（LRU，上限 32 个文件）。
// 缓存按「最新在前」的已解析行数组存放；同一文件指纹下重复读直接命中，
// appendJsonLine 落盘后主动失效；外部写入靠指纹变化兜底失效。
// 除条目数外还按估算字符总量（原始 JSONL 行长求和）设约 6400 万字符的
// 内存上限，超出按 LRU 逐出，防止大 JSONL 常驻缓存拖向 OOM。
const JSONL_ROWS_CACHE_MAX_ENTRIES = 32;
const JSONL_ROWS_CACHE_MAX_TOTAL_CHARS = 64_000_000;
const jsonlRowsCache = new Map();

function evictJsonlRowsCacheOverBudget() {
  while (jsonlRowsCache.size > JSONL_ROWS_CACHE_MAX_ENTRIES) {
    jsonlRowsCache.delete(jsonlRowsCache.keys().next().value);
  }
  let totalChars = 0;
  for (const entry of jsonlRowsCache.values()) totalChars += entry.approxChars ?? 0;
  while (totalChars > JSONL_ROWS_CACHE_MAX_TOTAL_CHARS && jsonlRowsCache.size > 0) {
    const oldestKey = jsonlRowsCache.keys().next().value;
    totalChars -= jsonlRowsCache.get(oldestKey)?.approxChars ?? 0;
    jsonlRowsCache.delete(oldestKey);
  }
}

function invalidateJsonlRowsCache(filePath) {
  jsonlRowsCache.delete(filePath);
}

async function jsonlFileFingerprint(filePath) {
  try {
    const stats = await stat(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

async function scanRecentJsonlRows(filePath, maxRows) {
  const handle = await open(filePath, 'r');
  const rows = [];
  let pending = JSONL_EMPTY_BUFFER;
  let complete = false;
  // 估算字符量（原始行长求和），供行缓存做内存预算。
  let approxChars = 0;
  try {
    const { size } = await handle.stat();
    if (!size) return { rows, complete: true, approxChars };
    let position = size;
    while (position > 0 && rows.length < maxRows) {
      const bytesToRead = Math.min(JSONL_SCAN_CHUNK_BYTES, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, position);
      const { head, lines } = splitTrailingJsonlLines(
        pending.length ? Buffer.concat([buffer, pending]) : buffer
      );
      pending = head;
      for (let index = lines.length - 1; index >= 0 && rows.length < maxRows; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          rows.push(JSON.parse(line));
          approxChars += line.length;
        } catch {
          // Skip corrupted historical JSONL rows.
        }
      }
    }
    if (position <= 0 && rows.length < maxRows) {
      const firstLine = pending.toString('utf8').trim();
      if (firstLine) {
        try {
          rows.push(JSON.parse(firstLine));
          approxChars += firstLine.length;
        } catch {
          // Skip corrupted historical JSONL rows.
        }
      }
      complete = true;
    }
    return { rows, complete, approxChars };
  } finally {
    await handle.close();
  }
}

async function readRecentJsonlRows(filePath, maxRows) {
  if (!existsSync(filePath)) return [];
  const safeMaxRows = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : Number.MAX_SAFE_INTEGER;
  const fingerprint = await jsonlFileFingerprint(filePath);
  const cached = jsonlRowsCache.get(filePath);
  if (cached && cached.fingerprint === fingerprint && (cached.complete || cached.rows.length >= safeMaxRows)) {
    // LRU touch。
    jsonlRowsCache.delete(filePath);
    jsonlRowsCache.set(filePath, cached);
    return cached.rows;
  }
  const { rows, complete, approxChars } = await scanRecentJsonlRows(filePath, safeMaxRows);
  jsonlRowsCache.delete(filePath);
  jsonlRowsCache.set(filePath, { fingerprint, rows, complete, approxChars });
  evictJsonlRowsCacheOverBudget();
  return rows;
}

// rank23③：路书 id -> 当前最大版本号 的惰性内存 Map。首次访问全量扫描一次，
// 之后 appendJsonLine 落 routebooks.jsonl 时增量更新，替代每次保存的全窗口扫描。
// 指纹不匹配（外部进程直写 JSONL）时重建，保持与 listRoutebookVersionRows 同口径。
const routebookVersionCache = { byId: null, fingerprint: '' };

function applyRoutebookVersionRow(byId, row) {
  const id = sanitizePublicId(row?.id || row?.publicId);
  if (!id) return;
  const currentVersion = byId.get(id) ?? 0;
  const explicitVersion = positiveInteger(row?.version);
  byId.set(id, Math.max(currentVersion, explicitVersion ?? (currentVersion + 1)));
}

async function noteRoutebookVersionAppend(payload) {
  if (!routebookVersionCache.byId) return;
  applyRoutebookVersionRow(routebookVersionCache.byId, payload);
  // 不回写指纹：并发/外部写入落盘后再 stat 会拿到「新于 byId 已消化行」的
  // 指纹，把别人的行标记成已合并。置空强制下次 currentRoutebookVersion 校验重建。
  routebookVersionCache.fingerprint = '';
}

async function withSingleProcessKeyLock(lockMap, key, operation) {
  const predecessor = lockMap.get(key);
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  lockMap.set(key, gate);
  if (predecessor) await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (lockMap.get(key) === gate) lockMap.delete(key);
  }
}

async function readJsonLines(filePath, limit = 50) {
  if (!existsSync(filePath)) return [];
  const safeLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 50);
  const rows = await readRecentJsonlRows(filePath, safeLimit);
  return rows.slice(0, safeLimit);
}

// Reverse scans keep the incomplete leading fragment as bytes, not as a decoded
// string: a chunk boundary inside a multi-byte character would otherwise decode
// to U+FFFD on both sides and silently corrupt that row's Chinese text.
function splitTrailingJsonlLines(buffer) {
  const boundary = buffer.indexOf(JSONL_NEWLINE_BYTE);
  if (boundary === -1) return { head: buffer, lines: [] };
  const lines = [];
  let cursor = boundary + 1;
  while (cursor < buffer.length) {
    const next = buffer.indexOf(JSONL_NEWLINE_BYTE, cursor);
    if (next === -1) {
      lines.push(buffer.subarray(cursor).toString('utf8'));
      break;
    }
    lines.push(buffer.subarray(cursor, next).toString('utf8'));
    cursor = next + 1;
  }
  return { head: buffer.subarray(0, boundary), lines };
}

async function findLatestJsonLine(filePath, predicate, scanLimit = 50000) {
  if (!existsSync(filePath)) return null;
  const handle = await open(filePath, 'r');
  let pending = JSONL_EMPTY_BUFFER;
  let scanned = 0;
  try {
    const { size } = await handle.stat();
    if (!size) return null;
    let position = size;
    while (position > 0 && scanned < scanLimit) {
      const bytesToRead = Math.min(JSONL_SCAN_CHUNK_BYTES, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, position);
      const { head, lines } = splitTrailingJsonlLines(
        pending.length ? Buffer.concat([buffer, pending]) : buffer
      );
      pending = head;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        scanned += 1;
        try {
          const row = JSON.parse(line);
          if (predicate(row)) return row;
        } catch {
          // Skip corrupted historical JSONL rows.
        }
        if (scanned >= scanLimit) break;
      }
    }
    const firstLine = pending.toString('utf8').trim();
    if (firstLine && scanned < scanLimit) {
      try {
        const row = JSON.parse(firstLine);
        if (predicate(row)) return row;
      } catch {
        // Skip corrupted historical JSONL rows.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function readLatestUniqueJsonLines(filePath, keyFn, limit = 100, scanLimit = 50000) {
  if (!existsSync(filePath)) return [];
  const safeLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 100);
  const handle = await open(filePath, 'r');
  const latestByKey = new Map();
  let pending = JSONL_EMPTY_BUFFER;
  let scanned = 0;
  try {
    const { size } = await handle.stat();
    if (!size) return [];
    let position = size;
    while (position > 0 && scanned < scanLimit && latestByKey.size < safeLimit) {
      const bytesToRead = Math.min(JSONL_SCAN_CHUNK_BYTES, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, position);
      const { head, lines } = splitTrailingJsonlLines(
        pending.length ? Buffer.concat([buffer, pending]) : buffer
      );
      pending = head;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        scanned += 1;
        try {
          const row = JSON.parse(line);
          const key = keyFn(row);
          if (key && !latestByKey.has(key)) latestByKey.set(key, row);
        } catch {
          // Skip corrupted historical JSONL rows.
        }
        if (scanned >= scanLimit || latestByKey.size >= safeLimit) break;
      }
    }
    const firstLine = pending.toString('utf8').trim();
    if (firstLine && scanned < scanLimit && latestByKey.size < safeLimit) {
      try {
        const row = JSON.parse(firstLine);
        const key = keyFn(row);
        if (key && !latestByKey.has(key)) latestByKey.set(key, row);
      } catch {
        // Skip corrupted historical JSONL rows.
      }
    }
    return [...latestByKey.values()].slice(0, safeLimit);
  } finally {
    await handle.close();
  }
}

// 先物化 scanLimit 行的尾窗（走 readRecentJsonlRows 行缓存），再在内存中按
// 谓词过滤凑满 limit 条。窗口远大于旧「全局尾窗 + filter」路径，避免热门
// 租户把其他 profile/route 的历史行挤出统计；返回顺序与 readJsonLines 一致
// （最新在前），保证各处「首个命中即最新」的去重语义不变。
async function readMatchingJsonLines(filePath, predicate, limit = 50, scanLimit = 50000) {
  if (!existsSync(filePath)) return [];
  const safeLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 50);
  const safeScanLimit = Number.isFinite(scanLimit) && scanLimit > 0 ? Math.floor(scanLimit) : 50000;
  const rows = await readRecentJsonlRows(filePath, safeScanLimit);
  return collectMatchingRows(rows, predicate, safeLimit, safeScanLimit);
}

function collectMatchingRows(rows, predicate, limit, scanLimit = Number.MAX_SAFE_INTEGER) {
  const matches = [];
  let scanned = 0;
  for (const row of rows ?? []) {
    scanned += 1;
    if (predicate(row)) {
      matches.push(row);
      if (matches.length >= limit) break;
    }
    if (scanned >= scanLimit) break;
  }
  return matches;
}

function sanitizePublicId(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

function stablePublicId(value, prefix = 'id') {
  const sanitized = sanitizePublicId(value);
  if (/[A-Za-z0-9]/.test(sanitized)) return sanitized;
  const text = String(value ?? '').trim();
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${sanitizePublicId(prefix) || 'id'}-${Math.abs(hash || Date.now()).toString(36)}`.slice(0, 80);
}

function parseMoney(value) {
  const matches = String(value ?? '').match(/\d+/g);
  if (!matches?.length) return 0;
  return matches.map(Number).filter(Number.isFinite).reduce((sum, item) => sum + item, 0);
}

function distanceMeters(a, b) {
  const lat1 = Number(a?.lat);
  const lng1 = Number(a?.lng);
  const lat2 = Number(b?.lat);
  const lng2 = Number(b?.lng);
  if (!isValidCoordinate(lat1, lng1) || !isValidCoordinate(lat2, lng2)) return null;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

function normalizeProfileId(value) {
  const id = sanitizePublicId(value);
  return id || 'anonymous';
}

function createRouteEditToken() {
  return randomBytes(24).toString('base64url');
}

function createServerProfileId() {
  return `p_${cryptoRandomId().replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
}

function sanitizeEditToken(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96);
}

function normalizeCreator(input = {}) {
  return {
    id: sanitizePublicId(input?.id || input?.creatorId) || 'official-curation',
    name: truncateString(input?.name || input?.creatorName, 60) || '可信路书编辑部',
    avatar: truncateString(input?.avatar || input?.creatorAvatar, 500),
    bio: truncateString(input?.bio || input?.creatorBio, 140),
    sourceAuthorization: truncateString(input?.sourceAuthorization || input?.authorization, 40) || 'self-owned'
  };
}

function normalizeProfile(input = {}) {
  const now = new Date().toISOString();
  const externalIdentity = normalizeProfileIdentity(input?.identity ?? input);
  const baseId = normalizeProfileId(input?.id || input?.profileId);
  const stableId = externalIdentity.key ? `u_${hmacText(externalIdentity.key)}` : baseId;
  return {
    id: stableId,
    previousLocalId: externalIdentity.key && baseId !== stableId ? baseId : '',
    identity: externalIdentity.publicIdentity,
    identityBound: Boolean(externalIdentity.key),
    identityBindingRequired: Boolean(externalIdentity.rejectedReason),
    identityBindingReason: externalIdentity.rejectedReason || '',
    homeCity: input?.homeCity ? normalizeCityName(input.homeCity) : '',
    preferredCities: Array.isArray(input?.preferredCities)
      ? [...new Set(input.preferredCities.map((city) => normalizeCityName(city)).filter(Boolean))].slice(0, 12)
      : [],
    budget: truncateString(input?.budget, 40) || '人均 900',
    companion: truncateString(input?.companion, 40) || '朋友',
    tempo: truncateString(input?.tempo, 40) || '松弛但不空',
    transport: truncateString(input?.transport, 60) || '步行 + 打车',
    themes: Array.isArray(input?.themes)
      ? [...new Set(input.themes.map((item) => truncateString(item, 40)).filter(Boolean))].slice(0, 12)
      : [],
    creatorName: truncateString(input?.creatorName, 60),
    creatorBio: truncateString(input?.creatorBio, 140),
    accessTokenHash: '',
    updatedAt: now,
    createdAt: truncateString(input?.createdAt, 60) || now
  };
}

function normalizeProfileIdentity(input = {}) {
  const identity = verifiedProfileIdentity(input);
  if (identity?.type === 'wechat-openid') {
    return {
      key: `wechat:${identity.subject}`,
      publicIdentity: {
        type: 'wechat-openid',
        label: `微信 ${identity.subject.slice(0, 4)}****${identity.subject.slice(-4)}`,
        boundAt: new Date().toISOString()
      }
    };
  }
  if (identity?.type === 'phone') {
    return {
      key: `phone:${identity.subject}`,
      publicIdentity: {
        type: 'phone',
        label: `${identity.subject.slice(0, 3)}****${identity.subject.slice(-4)}`,
        boundAt: new Date().toISOString()
      }
    };
  }
  return {
    key: '',
    publicIdentity: null,
    rejectedReason: hasProfileIdentityCandidate(input) ? 'IDENTITY_ASSERTION_REQUIRED' : ''
  };
}

function hasProfileIdentityCandidate(input = {}) {
  const phone = String(input?.phone ?? input?.mobile ?? input?.subject ?? '').replace(/\D/g, '');
  const wechatOpenId = sanitizePublicId(input?.wechatOpenId || input?.openid || input?.openId || input?.subject);
  return /^1\d{10}$/.test(phone) || Boolean(wechatOpenId && String(input?.type ?? input?.provider ?? '').includes('wechat'));
}

function verifiedProfileIdentity(input = {}) {
  const proof = input?.proof && typeof input.proof === 'object' ? input.proof : input;
  const phone = String(input?.phone ?? input?.mobile ?? proof?.phone ?? proof?.subject ?? '').replace(/\D/g, '');
  const wechatOpenId = sanitizePublicId(input?.wechatOpenId || input?.openid || input?.openId || proof?.wechatOpenId || proof?.openid || proof?.openId || proof?.subject);
  const requestedType = String(input?.type ?? input?.provider ?? proof?.type ?? proof?.provider ?? '').toLowerCase();
  const type = /^1\d{10}$/.test(phone)
    ? 'phone'
    : (wechatOpenId && requestedType.includes('wechat') ? 'wechat-openid' : '');
  const subject = type === 'phone' ? phone : wechatOpenId;
  if (!type || !subject || !PROFILE_IDENTITY_ASSERTION_SECRET) return null;

  const issuedAt = truncateString(proof?.issuedAt || proof?.timestamp, 60);
  const nonce = sanitizePublicId(proof?.nonce);
  const signature = String(proof?.signature ?? proof?.identitySignature ?? '').trim().toLowerCase();
  const issuedAtMs = Date.parse(issuedAt);
  if (!issuedAt || !nonce || !signature || !Number.isFinite(issuedAtMs)) return null;
  if (Math.abs(Date.now() - issuedAtMs) > 10 * 60 * 1000) return null;

  const payload = `${APP_ID}:${type}:${subject}:${issuedAt}:${nonce}`;
  const expected = createHmac('sha256', PROFILE_IDENTITY_ASSERTION_SECRET).update(payload).digest('hex');
  if (!safeEqualHex(signature, expected)) return null;
  return { type, subject };
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeTokenEqual(provided, expected) {
  const providedText = String(provided ?? '');
  const expectedText = String(expected ?? '');
  if (!providedText || !expectedText) return false;
  const left = Buffer.from(providedText);
  const right = Buffer.from(expectedText);
  return left.length === right.length && timingSafeEqual(left, right);
}

function importedSourceProofPayload(source = {}) {
  return [
    safeSourceUrl(source?.url),
    safeSourceUrl(source?.finalUrl),
    truncateString(source?.platform, 40),
    truncateString(source?.platformId, 40),
    truncateString(source?.status, 30),
    truncateString(source?.title, 120),
    truncateString(source?.description, 260),
    truncateString(source?.excerpt, 700),
    clampNumber(source?.trustScore, 0, 100, 20),
    (Array.isArray(source?.signals) ? source.signals : []).slice(0, 5).map((item) => truncateString(item, 80)).join(';'),
    (Array.isArray(source?.warnings) ? source.warnings : []).slice(0, 5).map((item) => truncateString(item, 100)).join(';'),
    truncateString(source?.fetchedAt, 60)
  ].join('|');
}

function signImportedSource(source = {}) {
  return createHmac('sha256', PROFILE_ID_SECRET).update(importedSourceProofPayload(source)).digest('hex');
}

function hasValidImportedSourceProof(source = {}) {
  return safeEqualHex(String(source?.proof ?? ''), signImportedSource(source));
}

async function buildStoredProfile(input = {}) {
  const requestedToken = sanitizeEditToken(input?.profileAccessToken);
  const requestedId = normalizeProfileId(input?.id || input?.profileId);
  let normalizedProfile = normalizeProfile(input);
  const shouldIssueServerLocalProfile = !normalizedProfile.identityBound &&
    !requestedToken &&
    (!requestedId || requestedId === 'anonymous' || !(await getSavedProfile(requestedId)));
  if (shouldIssueServerLocalProfile) {
    normalizedProfile = {
      ...normalizedProfile,
      id: createServerProfileId(),
      previousLocalId: requestedId && requestedId !== 'anonymous' ? requestedId : '',
      identityBindingRequired: normalizedProfile.identityBindingRequired,
      identityBindingReason: normalizedProfile.identityBindingReason || (requestedId && requestedId !== 'anonymous' ? 'SERVER_ISSUED_PROFILE_ID' : '')
    };
  }
  const existing = await getSavedProfile(normalizedProfile.id);
  let accessToken = requestedToken || createRouteEditToken();
  let accessTokenHash = hashSecretToken(accessToken);

  if (existing) {
    const validExistingToken = requestedToken && hashSecretToken(requestedToken) === existing.accessTokenHash;
    // 换设备找回：identityBound 只有在 verifiedProfileIdentity 通过（签名 + 10 分钟
    // 时效 + nonce）后才为 true，且 normalizedProfile.id 就是该身份的 stableId，与
    // existing 按同一 id 命中；此时允许在无旧 accessToken 的情况下轮换新 token。
    // 签名与时效校验本身不放宽，未携带合法断言的请求仍必须持有当前 token。
    const identityRecovery = !validExistingToken &&
      normalizedProfile.identityBound &&
      existing.identityBound === true;
    if (!validExistingToken && !identityRecovery) {
      throw createHttpError('更新已绑定身份需要当前 profile token，请在原设备同步或重新登录', 403, 'PROFILE_TOKEN_REQUIRED');
    }
    if (validExistingToken) {
      accessTokenHash = existing.accessTokenHash || hashSecretToken(accessToken);
      accessToken = requestedToken;
    } else {
      accessToken = createRouteEditToken();
      accessTokenHash = hashSecretToken(accessToken);
    }
  }

  const mergedProfile = existing
    ? normalizeProfile({
        ...existing,
        ...input,
        id: normalizedProfile.id,
        profileId: normalizedProfile.id
      })
    : normalizedProfile;
  const profile = existing
    ? {
        ...mergedProfile,
        identity: normalizedProfile.identityBound ? normalizedProfile.identity : existing.identity,
        identityBound: normalizedProfile.identityBound || Boolean(existing.identityBound),
        identityBindingRequired: normalizedProfile.identityBound
          ? false
          : (normalizedProfile.identityBindingRequired || Boolean(existing.identityBindingRequired)),
        identityBindingReason: normalizedProfile.identityBound
          ? ''
          : (normalizedProfile.identityBindingReason || existing.identityBindingReason || ''),
        previousLocalId: normalizedProfile.identityBound ? normalizedProfile.previousLocalId : ''
      }
    : normalizedProfile;

  const storedProfile = {
    ...profile,
    createdAt: existing?.createdAt || profile.createdAt,
    accessTokenHash
  };
  const { accessTokenHash: _accessTokenHash, ...publicProfile } = storedProfile;
  return {
    storedProfile,
    publicProfile: {
      ...publicProfile,
      profileAccessToken: accessToken
    }
  };
}

// 客户端可直接上报的曝光类型白名单；routebook-copy 属于计费/激励口径，
// 只允许 POST /api/routebooks/:id/copy 内部落库，防止刷复制量。
const PUBLIC_EXPOSURE_ITEM_TYPES = new Set(['routebook', 'product', 'journey-event']);
const INTERNAL_EXPOSURE_ITEM_TYPES = new Set(['routebook-copy']);

function sanitizeExposureSurface(value) {
  const surface = truncateString(value, 40).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return surface || 'unknown';
}

function normalizeExposure(input = {}, derived = {}) {
  const surface = sanitizeExposureSurface(input?.surface);
  const requestedItemType = truncateString(derived.itemType || input?.itemType || input?.type, 40) || 'routebook';
  const itemType = PUBLIC_EXPOSURE_ITEM_TYPES.has(requestedItemType) || INTERNAL_EXPOSURE_ITEM_TYPES.has(requestedItemType)
    ? requestedItemType
    : 'routebook';
  const itemId = stablePublicId(derived.itemId || input?.itemId || input?.routeId || input?.productId || input?.title, itemType);
  return {
    id: cryptoRandomId(),
    profileId: normalizeProfileId(input?.profileId),
    sessionId: sanitizePublicId(input?.sessionId),
    surface,
    itemType,
    itemId,
    routeId: sanitizePublicId(derived.routeId || input?.routeId || input?.publicId),
    routeTitle: truncateString(derived.routeTitle || input?.routeTitle || input?.title, 100),
    stopId: truncateString(input?.stopId, 40),
    stopName: truncateString(input?.stopName, 80),
    productId: derived.productId || (input?.productId ? stablePublicId(input.productId, 'product') : ''),
    productTitle: truncateString(derived.productTitle || input?.productTitle || input?.product, 100),
    city: derived.city || (input?.city ? normalizeCityName(input.city) : ''),
    creatorId: sanitizePublicId(derived.creatorId || input?.creatorId),
    sourcePosition: truncateString(input?.sourcePosition, 40),
    travelDate: itemType === 'journey-event'
      ? resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate)
      : '',
    createdAt: new Date().toISOString()
  };
}

function buildRoutebookMetrics(stops, existingMetrics = []) {
  const metrics = Array.isArray(existingMetrics) ? existingMetrics : [];
  const stopCount = stops.length;
  const lowGeoCount = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length;
  const avgScore = stopCount
    ? Math.round(stops.reduce((sum, stop) => sum + Number(stop.score ?? 78), 0) / stopCount)
    : 78;
  const estimatedBudget = stops.reduce((sum, stop) => sum + parseMoney(stop.cost), 0);
  const calculated = [
    { label: '站点均分', value: `${avgScore}` },
    { label: '定位待复核', value: lowGeoCount ? `${lowGeoCount} 处` : '0 处' },
    { label: '预算估算', value: estimatedBudget ? `约 ${estimatedBudget} 元` : '待验证' },
    { label: '编辑校验', value: '已重算' }
  ];
  const merged = [...calculated, ...metrics.filter((item) => !calculated.some((next) => next.label === item.label))];
  return merged.slice(0, 6);
}

function buildSourceSummary(sources = []) {
  const normalized = normalizeImportedSources(sources);
  if (!normalized.length) {
    return {
      sourceCount: 0,
      averageTrust: null,
      platforms: [],
      warnings: [],
      signals: []
    };
  }
  const averageTrust = Math.round(normalized.reduce((sum, source) => sum + source.trustScore, 0) / normalized.length);
  return {
    sourceCount: normalized.length,
    averageTrust,
    platforms: [...new Set(normalized.map((source) => source.platform).filter(Boolean))],
    warnings: [...new Set(normalized.flatMap((source) => source.warnings ?? []))].slice(0, 8),
    signals: [...new Set(normalized.flatMap((source) => source.signals ?? []))].slice(0, 8)
  };
}

function normalizeSourceSummary(summary, sources = []) {
  return buildSourceSummary(sources);
}

function mergeSourceMetrics(metrics, sourceSummary) {
  if (!sourceSummary?.sourceCount) return metrics;
  const sourceMetrics = [
    { label: '导入来源', value: `${sourceSummary.sourceCount} 条` },
    { label: '来源均分', value: `${sourceSummary.averageTrust}` }
  ];
  return [...sourceMetrics, ...metrics.filter((item) => !sourceMetrics.some((next) => next.label === item.label))].slice(0, 6);
}

function mergeSourceValidations(validations, sourceSummary) {
  if (!sourceSummary?.sourceCount) return validations;
  const state = sourceSummary.averageTrust >= 70 ? '可参考' : sourceSummary.averageTrust >= 45 ? '需复核' : '低可信';
  const detail = [
    `已分析 ${sourceSummary.sourceCount} 条导入来源，平均可信 ${sourceSummary.averageTrust}。`,
    sourceSummary.platforms?.length ? `平台：${sourceSummary.platforms.join('、')}。` : '',
    sourceSummary.warnings?.[0] ? `首要风险：${sourceSummary.warnings[0]}` : ''
  ].filter(Boolean).join('');
  const sourceValidation = {
    id: 'source-trust',
    label: '导入来源',
    state,
    detail: truncateString(detail, 120)
  };
  return [sourceValidation, ...validations.filter((item) => item.id !== 'source-trust')].slice(0, 8);
}

function calculateRouteTrustScore(stops) {
  if (!stops.length) return 60;
  const avgPoiScore = stops.reduce((sum, stop) => sum + clampNumber(stop.score, 40, 99, 78), 0) / stops.length;
  const lowGeoPenalty = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length * 3;
  const missingCostPenalty = stops.filter((stop) => !/\d/.test(String(stop.cost ?? ''))).length * 1.5;
  const denseDayPenalty = Math.max(0, Math.max(...Object.values(stops.reduce((acc, stop) => {
    const day = stop.day || 'Day 1';
    acc[day] = (acc[day] ?? 0) + 1;
    return acc;
  }, {}))) - 6) * 2;
  return Math.round(clampNumber(avgPoiScore - lowGeoPenalty - missingCostPenalty - denseDayPenalty, 45, 96, 78));
}

function hasPreciseCoordinate(stop) {
  return isValidCoordinate(Number(stop?.lat), Number(stop?.lng)) &&
    Number(stop?.geoConfidence ?? 0) >= 60 &&
    stop?.navigationDisabled !== true &&
    !['city-center', 'region-center', 'country-center'].includes(String(stop?.coordinateSource ?? ''));
}

function routeLegStats(stops) {
  let longestMeters = 0;
  let totalMeters = 0;
  let measuredLegs = 0;
  let unverifiedLegs = 0;
  const riskyLegs = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const current = stops[index];
    const next = stops[index + 1];
    if ((current.day || 'Day 1') !== (next.day || 'Day 1')) continue;
    if (!hasPreciseCoordinate(current) || !hasPreciseCoordinate(next)) {
      unverifiedLegs += 1;
      continue;
    }
    const distance = distanceMeters(current, next);
    if (!Number.isFinite(distance)) {
      unverifiedLegs += 1;
      continue;
    }
    measuredLegs += 1;
    totalMeters += distance;
    if (distance > longestMeters) longestMeters = distance;
    if (distance > 8000) {
      riskyLegs.push({
        from: truncateString(current.name, 48),
        to: truncateString(next.name, 48),
        distance
      });
    }
  }
  return { longestMeters, totalMeters, measuredLegs, unverifiedLegs, riskyLegs };
}

// Day labels are relative ("Day 2"), so a closure check needs the travel date to know
// which weekday each stop actually lands on.
function weekdayForDayLabel(travelDate, dayLabel) {
  if (!travelDate) return null;
  const offset = Math.max(0, (Number(String(dayLabel ?? '').match(/\d+/)?.[0]) || 1) - 1);
  const timestamp = Date.parse(`${travelDate}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + offset * 86400000).getUTCDay();
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function poiOpenHours(stop, city) {
  const trusted = findTrustedPoi(stop, city);
  const hours = trusted?.openHours;
  if (!hours || !Array.isArray(hours.closedWeekdays)) return null;
  return hours;
}

function openingHoursConflicts(stops, city, travelDate) {
  const closures = [];
  let checkedStops = 0;
  let unknownStops = 0;
  for (const stop of stops) {
    const hours = poiOpenHours(stop, city);
    if (!hours) {
      unknownStops += 1;
      continue;
    }
    checkedStops += 1;
    const weekday = weekdayForDayLabel(travelDate, stop.day);
    if (weekday == null || !hours.closedWeekdays.includes(weekday)) continue;
    closures.push({
      name: truncateString(stop.name, 48),
      day: truncateString(stop.day, 24) || 'Day 1',
      weekday: WEEKDAY_NAMES[weekday],
      note: truncateString(hours.note, 60)
    });
  }
  return { closures, checkedStops, unknownStops };
}

function buildOpeningHoursValidation(stops, city, travelDate) {
  const { closures, checkedStops, unknownStops } = openingHoursConflicts(stops, city, travelDate);
  if (closures.length) {
    const first = closures[0];
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '闭馆冲突',
      detail: `${first.day}（${first.weekday}）${first.name}${first.note ? ` ${first.note}` : '当天不开放'}，请换到其他日期或替换同区 POI。${closures.length > 1 ? `另有 ${closures.length - 1} 处冲突。` : ''}`
    };
  }
  if (!travelDate) {
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '需填出行日期',
      detail: '填写出行日期后可自动检查闭馆冲突（例如周一闭馆的美术馆）。'
    };
  }
  if (!checkedStops) {
    return {
      id: 'edit-hours',
      label: '营业时间',
      state: '无数据',
      detail: `${unknownStops} 个站点没有已核验的营业时间数据，出发前需逐个复核。`
    };
  }
  return {
    id: 'edit-hours',
    label: '营业时间',
    state: unknownStops ? '部分待复核' : '通过',
    detail: unknownStops
      ? `已核对 ${checkedStops} 个站点当天开放，另有 ${unknownStops} 个站点缺营业时间数据需复核。`
      : `已核对 ${checkedStops} 个站点在出行日均开放。`
  };
}

// Budget is only meaningful against what the user asked for: "人均 300" and "人均 3000"
// cannot share one threshold.
function budgetThresholdFromConstraints(constraints, stops) {
  const perPerson = parseMoney(constraints?.budget);
  if (!perPerson) return { threshold: 0, perPerson: 0 };
  const dayCount = Math.max(1, new Set(stops.map((stop) => stop.day || 'Day 1')).size);
  return { threshold: perPerson * dayCount, perPerson };
}

function buildBudgetValidation(budget, constraints, stops) {
  if (!budget) {
    return { id: 'edit-budget', label: '预算风险', state: '待补充', detail: '费用信息不足，建议补充门票/餐饮价格。' };
  }
  const { threshold, perPerson } = budgetThresholdFromConstraints(constraints, stops);
  if (!threshold) {
    return {
      id: 'edit-budget',
      label: '预算风险',
      state: '无预算约束',
      detail: `按站点费用粗估约 ${budget} 元，填写预算后可判断是否超支。`
    };
  }
  const overspent = budget > threshold;
  return {
    id: 'edit-budget',
    label: '预算风险',
    state: overspent ? '超预算' : '可控',
    detail: `按站点费用粗估约 ${budget} 元，你的预算为人均 ${perPerson} 元（约 ${threshold} 元）。${overspent ? `超出约 ${budget - threshold} 元，建议替换高价站点。` : '实际价格仍需出发前复核。'}`
  };
}

function buildRoutebookValidations(stops, existingValidations = [], reason = '保存', context = {}) {
  const validations = Array.isArray(existingValidations) ? existingValidations : [];
  const groupedByDay = stops.reduce((map, stop) => {
    const day = stop.day || 'Day 1';
    map.set(day, (map.get(day) ?? 0) + 1);
    return map;
  }, new Map());
  const crowdedDay = [...groupedByDay.entries()].find(([, count]) => count > 6);
  const missingCoordinate = stops.filter((stop) => !isValidCoordinate(Number(stop.lat), Number(stop.lng))).length;
  const lowConfidence = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length;
  const budget = stops.reduce((sum, stop) => sum + parseMoney(stop.cost), 0);
  const legStats = routeLegStats(stops);
  const measuredDistanceKm = legStats.totalMeters ? (legStats.totalMeters / 1000).toFixed(1) : '';
  const calculated = [
    {
      id: 'edit-routing',
      label: '编辑后动线',
      state: missingCoordinate || legStats.unverifiedLegs ? '需复核' : '已更新',
      detail: `${reason}后已重算站点顺序；${missingCoordinate ? `${missingCoordinate} 个站点缺少可用坐标。` : legStats.unverifiedLegs ? `${legStats.unverifiedLegs} 段因定位待复核未计算精确转场。` : `已计算 ${legStats.measuredLegs} 段转场，合计约 ${measuredDistanceKm} km。`}`
    },
    {
      id: 'edit-tempo',
      label: '节奏密度',
      state: crowdedDay ? '偏紧' : '可执行',
      detail: crowdedDay ? `${crowdedDay[0]} 有 ${crowdedDay[1]} 站，建议拆分或删减。` : '单日站点密度在 MVP 可执行范围内。'
    },
    {
      id: 'edit-detour',
      label: '绕路风险',
      state: legStats.riskyLegs.length ? '需重排' : legStats.unverifiedLegs ? '待复核' : '可执行',
      detail: legStats.riskyLegs.length
        ? `${legStats.riskyLegs[0].from} → ${legStats.riskyLegs[0].to} 约 ${(legStats.riskyLegs[0].distance / 1000).toFixed(1)} km，建议拆天或替换同区 POI。`
        : legStats.unverifiedLegs
          ? `${legStats.unverifiedLegs} 段缺少高置信坐标，暂不输出精确步行/打车时长。`
          : `最长相邻转场约 ${(legStats.longestMeters / 1000).toFixed(1)} km。`
    },
    buildBudgetValidation(budget, context.constraints, stops),
    buildOpeningHoursValidation(stops, context.city, context.travelDate),
    {
      id: 'edit-geo',
      label: '定位可信',
      state: lowConfidence ? '需复核' : '通过',
      detail: lowConfidence ? `${lowConfidence} 个站点为低置信定位，仅展示街区/城市级范围，不开放一键导航。` : '站点定位置信度满足当前展示要求。'
    }
  ];
  const merged = [...calculated, ...validations.filter((item) => !calculated.some((next) => next.id === item.id))];
  return merged.slice(0, 8);
}

function normalizeRoutebookStop(stop, index, city) {
  const coordinate = normalizeCoordinate(stop, city, index);
  const name = truncateString(stop?.name, 48) || `站点 ${index + 1}`;
  const poiId = resolvePoiId({ ...stop, name }, city);
  const existingId = stop?.id;
  const stableStopId = typeof existingId === 'number' && Number.isFinite(existingId)
    ? existingId
    : sanitizePublicId(existingId) || `stop-${index + 1}`;
  return {
    id: stableStopId,
    poiId,
    day: truncateString(stop?.day, 24) || 'Day 1',
    time: truncateString(stop?.time, 24) || '10:00',
    name,
    area: truncateString(stop?.area, 40) || '待确认',
    stay: truncateString(stop?.stay, 24) || '60 分钟',
    cost: truncateString(stop?.cost, 32) || '待估算',
    verify: truncateString(stop?.verify, 120) || '需通过真实打卡继续验证',
    risk: truncateString(stop?.risk, 120) || '需出发前复核',
    score: clampNumber(stop?.score, 40, 99, 78),
    lat: coordinate.lat,
    lng: coordinate.lng,
    geoConfidence: coordinate.fallback || coordinate.navigationDisabled === true
      ? clampNumber(coordinate.confidence, 20, 59, 45)
      : clampNumber(stop?.geoConfidence, 60, 99, coordinate.confidence ?? 82),
    coordinateSystem: 'WGS84',
    coordinateSource: truncateString(stop?.coordinateSource, 40) || coordinate.source,
    coordinatePrecision: truncateString(stop?.coordinatePrecision, 40) || coordinate.precision,
    coordinateRadiusMeters: coordinate.fallback || coordinate.navigationDisabled === true
      ? clampNumber(coordinate.radiusMeters, 400, 1000000, 1500)
      : clampNumber(stop?.coordinateRadiusMeters, 0, 1000000, coordinate.radiusMeters ?? 0),
    navigationDisabled: stop?.navigationDisabled === true || coordinate.navigationDisabled === true,
    sourceEvidence: normalizeStopEvidence(stop?.sourceEvidence),
    facts: normalizeStopFacts(stop?.facts)
  };
}

function normalizeStopEvidence(items = []) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 5).map((item, index) => ({
    id: sanitizePublicId(item?.id) || `evidence-${index + 1}`,
    type: truncateString(item?.type, 32) || 'source',
    label: truncateString(item?.label, 80) || '来源证据',
    detail: truncateString(item?.detail, 220),
    platform: truncateString(item?.platform, 40),
    trustScore: item?.trustScore == null ? null : clampNumber(item.trustScore, 0, 100, 50),
    url: safeSourceUrl(item?.url),
    checkedAt: truncateString(item?.checkedAt, 60)
  })).filter((item) => item.label || item.detail || item.url);
}

function normalizeStopFacts(items = []) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 8).map((item, index) => ({
    id: sanitizePublicId(item?.id) || `fact-${index + 1}`,
    field: truncateString(item?.field, 40) || '综合信息',
    value: truncateString(item?.value, 180),
    confidence: clampNumber(item?.confidence, 0, 100, 60),
    sourceLabel: truncateString(item?.sourceLabel, 80),
    sourceType: truncateString(item?.sourceType, 32) || 'derived',
    sourceUrl: safeSourceUrl(item?.sourceUrl),
    status: truncateString(item?.status, 24) || '需复核',
    checkedAt: truncateString(item?.checkedAt, 60)
  })).filter((item) => item.field && item.value);
}

function routebookValidationContext(routebook) {
  return {
    city: routebook?.city,
    constraints: routebook?.constraints,
    travelDate: resolveTravelDate(routebook?.travelDate, routebook?.constraints?.date, routebook?.provider?.travelDate)
  };
}

function normalizeRouteVariant(variant, index, city, fallbackStops = [], context = {}) {
  const mode = truncateString(variant?.mode, 24) || '自定义';
  const sourceStops = Array.isArray(variant?.stops) && variant.stops.length ? variant.stops : fallbackStops;
  const stops = sourceStops
    .slice(0, MAX_ROUTEBOOK_STOPS)
    .map((stop, stopIndex) => normalizeRoutebookStop(stop, stopIndex, city));
  if (stops.length < 2) return null;
  const id = sanitizePublicId(variant?.id) || cryptoRandomId();
  const days = [...new Set(stops.map((stop) => stop.day || 'Day 1'))];
  return {
    id,
    mode,
    label: truncateString(variant?.label, 40) || `${mode}版`,
    summary: truncateString(variant?.summary, 160) || `按${mode}偏好重排，并保留原路书的可信校验。`,
    days,
    stops,
    trustScore: calculateRouteTrustScore(stops),
    metrics: buildRoutebookMetrics(stops, variant?.metrics),
    validations: buildRoutebookValidations(stops, variant?.validations, `${mode}变体`, { city, ...(context ?? {}) }),
    createdAt: truncateString(variant?.createdAt, 60) || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function normalizeRouteVariants(variants, city, fallbackStops = [], context = {}) {
  if (!Array.isArray(variants)) return [];
  const latestByKey = new Map();
  variants
    .slice(0, 12)
    .map((variant, index) => normalizeRouteVariant(variant, index, city, fallbackStops, context))
    .filter(Boolean)
    .forEach((variant) => {
      latestByKey.set(variant.id || variant.mode, variant);
    });
  return [...latestByKey.values()].slice(0, 8);
}

function positiveInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeRoutebookActorType(value) {
  const actorType = truncateString(value, 24);
  return ['user', 'admin', 'system', 'migration'].includes(actorType) ? actorType : 'system';
}

function routebookVersionMetadata(input, now, publishStatus) {
  const version = positiveInteger(input?.version, 1);
  const parentVersion = positiveInteger(input?.parentVersion);
  const createdAt = truncateString(input?.createdAt, 60) || now.toISOString();
  const existingPublishedAt = truncateString(input?.publishedAt, 60);
  const existingArchivedAt = truncateString(input?.archivedAt, 60);
  return {
    schemaVersion: positiveInteger(input?.schemaVersion, 2),
    version,
    parentVersion: parentVersion != null && parentVersion < version ? parentVersion : null,
    createdAt,
    updatedAt: now.toISOString(),
    publishedAt: PUBLIC_ROUTE_STATUSES.has(publishStatus) ? (existingPublishedAt || now.toISOString()) : existingPublishedAt,
    archivedAt: publishStatus === 'archived' ? (existingArchivedAt || now.toISOString()) : '',
    changeReason: truncateString(input?.changeReason || input?.editReason, 160) || (version === 1 ? '创建路书' : '更新路书'),
    actorType: normalizeRoutebookActorType(input?.actorType || (input?.profileId ? 'user' : 'system'))
  };
}

function normalizeRoutebookForStorage(input, existingId = '') {
  const city = normalizeCityName(input?.city);
  const now = new Date();
  const stops = (Array.isArray(input?.stops) ? input.stops : [])
    .slice(0, MAX_ROUTEBOOK_STOPS)
    .map((stop, index) => normalizeRoutebookStop(stop, index, city));
  if (stops.length < 2) {
    throw createHttpError('路书至少需要 2 个站点才能保存', 400, 'ROUTEBOOK_TOO_SHORT');
  }
  const id = sanitizePublicId(existingId || input?.id || input?.publicId) || cryptoRandomId();
  const days = Array.isArray(input?.days) && input.days.length
    ? input.days.map((day) => truncateString(day, 24)).filter(Boolean).slice(0, 10)
    : [...new Set(stops.map((stop) => stop.day || 'Day 1'))];
  const sourceSummary = normalizeSourceSummary(input?.sourceSummary, input?.importedSources);
  const validationContext = {
    city,
    constraints: input?.constraints,
    travelDate: resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate)
  };
  const validations = mergeSourceValidations(
    buildRoutebookValidations(stops, input?.validations, input?.editReason || '保存', validationContext),
    sourceSummary
  );
  const metrics = mergeSourceMetrics(buildRoutebookMetrics(stops, input?.metrics), sourceSummary);
  const trustScore = calculateRouteTrustScore(stops);
  const publishStatus = ROUTEBOOK_STATUSES.has(input?.publishStatus) ? input.publishStatus : 'draft';
  const versionMetadata = routebookVersionMetadata(input, now, publishStatus);
  return {
	    id,
	    publicId: id,
	    profileId: normalizeProfileId(input?.profileId),
	    editToken: sanitizeEditToken(input?.editToken),
	    creator: normalizeCreator(input?.creator),
    publishStatus,
    sourceAuthorization: truncateString(input?.sourceAuthorization || input?.creator?.sourceAuthorization, 40) || 'self-owned',
    copyCount: clampNumber(input?.copyCount, 0, 1000000, 0),
    city,
    title: truncateString(input?.title, 80) || `${city} 可信路书`,
    summary: truncateString(input?.summary, 220) || '已保存为可分享、可编辑的可信路书。',
    trustScore,
    days,
    stops,
    assets: Array.isArray(input?.assets) ? input.assets.slice(0, 12).map((item, index) => ({
      label: truncateString(item?.label, 30) || `资产 ${index + 1}`,
      type: truncateString(item?.type, 24) || 'POI',
      confidence: clampNumber(item?.confidence, 0, 99, 72)
    })) : [],
    validations,
    metrics,
    logs: normalizeLogs(input?.logs, now),
    importedSources: normalizeImportedSources(input?.importedSources).slice(0, MAX_IMPORT_URLS),
    sourceSummary,
    constraints: normalizeRouteConstraints(input?.constraints),
    travelDate: resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate),
    variants: normalizeRouteVariants(input?.variants, city, stops, validationContext),
    activeVariantId: sanitizePublicId(input?.activeVariantId),
    provider: normalizeStoredProvider(input?.provider, {
      travelDate: resolveTravelDate(input?.travelDate, input?.constraints?.date, input?.provider?.travelDate),
      savedAt: now.toISOString()
    }),
    ...versionMetadata
  };
}

function normalizeStoredProvider(provider = {}, extra = {}) {
  const source = provider && typeof provider === 'object' ? provider : {};
  const normalized = {
    name: truncateString(source.name, 40),
    model: truncateString(source.model, 80),
    baseUrl: truncateString(source.baseUrl, 180),
    generatedAt: truncateString(source.generatedAt, 60),
    editedAt: truncateString(source.editedAt, 60),
    copiedAt: truncateString(source.copiedAt, 60),
    savedAt: truncateString(extra.savedAt || source.savedAt, 60),
    statusUpdatedAt: truncateString(source.statusUpdatedAt, 60),
    tokenMigratedAt: truncateString(source.tokenMigratedAt, 60),
    userPublishedAt: truncateString(source.userPublishedAt, 60),
    travelDate: normalizeTravelDate(extra.travelDate || source.travelDate)
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== ''));
}

function normalizeRouteConstraints(input = {}) {
  return {
    duration: truncateString(input?.duration, 30),
    budget: truncateString(input?.budget, 30),
    tempo: truncateString(input?.tempo, 30),
    companion: truncateString(input?.companion, 30),
    date: normalizeTravelDate(input?.date),
    base: truncateString(input?.base, 80),
    transport: truncateString(input?.transport, 60),
    theme: truncateString(input?.theme, 120),
    mustGo: truncateString(input?.mustGo, 120),
    avoid: truncateString(input?.avoid, 120)
  };
}

function normalizeTravelDate(value) {
  const text = truncateString(value, 30);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().slice(0, 10) === text ? text : '';
}

function resolveTravelDate(...values) {
  for (const value of values) {
    const normalized = normalizeTravelDate(value);
    if (normalized) return normalized;
  }
  return '';
}

function localDateForTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(
    TRAVEL_DAY_DATE_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return normalizeTravelDate(`${parts.year}-${parts.month}-${parts.day}`);
}

function travelDateOrdinal(value) {
  const date = normalizeTravelDate(value);
  if (!date) return null;
  const epoch = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) return null;
  return Math.floor(epoch / 86400000);
}

function isTravelDateEvent(travelDate, event) {
  const plannedOrdinal = travelDateOrdinal(travelDate);
  const eventOrdinal = travelDateOrdinal(localDateForTimestamp(event?.createdAt));
  if (plannedOrdinal == null || eventOrdinal == null) return false;
  return Math.abs(eventOrdinal - plannedOrdinal) <= TRAVEL_DAY_WINDOW_DAYS;
}

// 打卡行事件时间口径：用户补记的 observedAt 为合法日期且与 createdAt 相差
// ≤ 30 天时采用（离线补传/当晚补录仍归入实际到达日），否则回退提交时间，
// 防止伪造远古/远期时间搅乱行程日与时间吻合统计。
const CHECKIN_OBSERVED_AT_MAX_DRIFT_MS = 30 * 24 * 60 * 60 * 1000;

function checkinEventTime(item = {}) {
  const fallback = item?.createdAt ?? item?.time;
  const observedMs = Date.parse(item?.observedAt ?? '');
  const createdMs = Date.parse(item?.createdAt ?? '');
  if (
    Number.isFinite(observedMs) &&
    Number.isFinite(createdMs) &&
    Math.abs(observedMs - createdMs) <= CHECKIN_OBSERVED_AT_MAX_DRIFT_MS
  ) {
    return item.observedAt;
  }
  return fallback;
}

// 仅用于打卡行的出行日窗口匹配；exposures 等事件仍走 isTravelDateEvent。
function isTravelDateCheckin(travelDate, checkin) {
  const plannedOrdinal = travelDateOrdinal(travelDate);
  const eventOrdinal = travelDateOrdinal(localDateForTimestamp(checkinEventTime(checkin)));
  if (plannedOrdinal == null || eventOrdinal == null) return false;
  return Math.abs(eventOrdinal - plannedOrdinal) <= TRAVEL_DAY_WINDOW_DAYS;
}

async function listSavedRoutebooks(limit = 100) {
  return readLatestUniqueJsonLines(
    ROUTEBOOK_LOG_PATH,
    (row) => sanitizePublicId(row?.id || row?.publicId),
    limit
  );
}

async function getSavedRoutebook(publicId) {
  const id = sanitizePublicId(publicId);
  if (!id) return null;
  // 按 id 查最新快照必须允许扫到文件头：旧路书被全局尾窗挤出后返回 404，
  // 客户端会用同一 ID 重建草稿并把历史版本链打断。反向分块读取内存仍有界。
  return findLatestJsonLine(
    ROUTEBOOK_LOG_PATH,
    (row) => sanitizePublicId(row?.id || row?.publicId) === id,
    Number.POSITIVE_INFINITY
  );
}

async function listRoutebookVersionRows(publicId) {
  const id = sanitizePublicId(publicId);
  if (!id) return [];
  const rows = (await readJsonLines(ROUTEBOOK_LOG_PATH, 50000))
    .filter((row) => sanitizePublicId(row?.id || row?.publicId) === id)
    .reverse();
  let currentVersion = 0;
  const versions = [];
  rows.forEach((row, index) => {
    const explicitVersion = positiveInteger(row?.version);
    const version = explicitVersion ?? (currentVersion + 1);
    currentVersion = Math.max(currentVersion, version);
    const parentVersion = positiveInteger(row?.parentVersion) ?? (version > 1 ? version - 1 : null);
    const normalized = {
      schemaVersion: positiveInteger(row?.schemaVersion, explicitVersion ? 2 : 1),
      version,
      parentVersion: parentVersion != null && parentVersion < version ? parentVersion : null,
      derived: explicitVersion == null,
      snapshotOrdinal: index + 1,
      routebookId: id,
      title: truncateString(row?.title, 80),
      city: row?.city ? normalizeCityName(row.city) : '',
      publishStatus: ROUTEBOOK_STATUSES.has(row?.publishStatus) ? row.publishStatus : 'draft',
      changeReason: truncateString(row?.changeReason || row?.editReason, 160) || (explicitVersion ? '路书快照' : '历史快照'),
      actorType: normalizeRoutebookActorType(row?.actorType || (row?.profileId ? 'user' : 'migration')),
      createdAt: truncateString(row?.createdAt, 60) || truncateString(row?.updatedAt, 60),
      updatedAt: truncateString(row?.updatedAt, 60),
      publishedAt: truncateString(row?.publishedAt, 60),
      archivedAt: truncateString(row?.archivedAt, 60)
    };
    const existingIndex = explicitVersion == null ? -1 : versions.findIndex((item) => item.version === version);
    if (existingIndex >= 0) versions[existingIndex] = normalized;
    else versions.push(normalized);
  });
  return versions.sort((left, right) => left.version - right.version || left.snapshotOrdinal - right.snapshotOrdinal);
}

// rank23③：不再每次保存都扫全窗口重放版本链；用惰性构建的 id -> maxVersion
// 内存 Map 查询，推导规则与 listRoutebookVersionRows 一致（显式 version 优先，
// 缺失时按快照顺序递增）。
async function currentRoutebookVersion(publicId) {
  const id = sanitizePublicId(publicId);
  if (!id) return 0;
  const fingerprint = await jsonlFileFingerprint(ROUTEBOOK_LOG_PATH);
  if (!routebookVersionCache.byId || routebookVersionCache.fingerprint !== fingerprint) {
    const byId = new Map();
    // 全量重建不设行数上限：与 getSavedRoutebook 的全文件口径一致，否则超限后
    // 旧路书能查到快照却拿到 version 0，触发误判的版本冲突/覆盖。
    const chronologicalRows = (await readRecentJsonlRows(ROUTEBOOK_LOG_PATH, Number.POSITIVE_INFINITY)).slice().reverse();
    for (const row of chronologicalRows) applyRoutebookVersionRow(byId, row);
    routebookVersionCache.byId = byId;
    routebookVersionCache.fingerprint = fingerprint;
  }
  return routebookVersionCache.byId.get(id) ?? 0;
}

function expectedVersionWasProvided(input) {
  return input != null && Object.prototype.hasOwnProperty.call(input, 'expectedVersion') && input.expectedVersion !== '' && input.expectedVersion != null;
}

function assertExpectedRoutebookVersion(input, currentVersion, { required = false } = {}) {
  if (!expectedVersionWasProvided(input)) {
    if (required) {
      const error = createHttpError('更新已有路书必须携带 expectedVersion', 409, 'EXPECTED_VERSION_REQUIRED');
      error.currentVersion = currentVersion;
      throw error;
    }
    return;
  }
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw createHttpError('expectedVersion 必须是非负整数', 400, 'EXPECTED_VERSION_INVALID');
  }
  if (expectedVersion !== currentVersion) {
    const error = createHttpError(`路书版本冲突，当前版本为 ${currentVersion}`, 409, 'VERSION_CONFLICT');
    error.currentVersion = currentVersion;
    throw error;
  }
}

async function routebookMutationMetadata(existingRoutebook, input, { changeReason, actorType }) {
  const id = sanitizePublicId(existingRoutebook?.publicId || existingRoutebook?.id);
  const currentVersion = id ? await currentRoutebookVersion(id) : 0;
  assertExpectedRoutebookVersion(input, currentVersion, { required: true });
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    version: currentVersion + 1,
    parentVersion: currentVersion || null,
    createdAt: truncateString(existingRoutebook?.createdAt, 60) || truncateString(existingRoutebook?.updatedAt, 60) || now,
    publishedAt: truncateString(existingRoutebook?.publishedAt, 60),
    archivedAt: truncateString(existingRoutebook?.archivedAt, 60),
    changeReason: truncateString(input?.changeReason || changeReason, 160),
    actorType: normalizeRoutebookActorType(input?.actorType || actorType)
  };
}

function buildRoutebookAudit(routebook, event, details = {}) {
  const routebookId = sanitizePublicId(routebook?.publicId || routebook?.id);
  if (!routebookId) return null;
  return {
    id: cryptoRandomId(),
    routebookId,
    event: truncateString(event, 40),
    version: positiveInteger(routebook?.version, 1),
    parentVersion: positiveInteger(routebook?.parentVersion),
    publishStatus: ROUTEBOOK_STATUSES.has(routebook?.publishStatus) ? routebook.publishStatus : 'draft',
    changeReason: truncateString(routebook?.changeReason, 160),
    actorType: normalizeRoutebookActorType(routebook?.actorType),
    createdAt: new Date().toISOString(),
    ...details
  };
}

async function appendVersionedRoutebook(routebook, event, details = {}) {
  const versionAudit = buildRoutebookAudit(routebook, event, details);
  await appendJsonLine(ROUTEBOOK_LOG_PATH, versionAudit ? { ...routebook, versionAudit } : routebook);
}

async function listRoutebookAudits(publicId) {
  const routebookId = sanitizePublicId(publicId);
  if (!routebookId) return [];
  const snapshots = await readJsonLines(ROUTEBOOK_LOG_PATH, 50000);
  let legacyAudits = [];
  try {
    legacyAudits = await readJsonLines(ROUTEBOOK_AUDIT_LOG_PATH, 50000);
  } catch (error) {
    if (!['ENOENT', 'EISDIR', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
  }
  const auditsByVersionAndEvent = new Map();
  legacyAudits
    .filter((audit) => sanitizePublicId(audit?.routebookId) === routebookId)
    .forEach((audit) => {
      auditsByVersionAndEvent.set(`${positiveInteger(audit?.version, 1)}:${truncateString(audit?.event, 40)}`, audit);
    });
  snapshots
    .filter((snapshot) => sanitizePublicId(snapshot?.id || snapshot?.publicId) === routebookId && snapshot?.versionAudit)
    .forEach((snapshot) => {
      const audit = snapshot.versionAudit;
      if (sanitizePublicId(audit?.routebookId) !== routebookId) return;
      auditsByVersionAndEvent.set(`${positiveInteger(audit?.version, 1)}:${truncateString(audit?.event, 40)}`, audit);
    });
  return [...auditsByVersionAndEvent.values()].sort((left, right) =>
    positiveInteger(left?.version, 1) - positiveInteger(right?.version, 1) ||
    String(left?.createdAt ?? '').localeCompare(String(right?.createdAt ?? ''))
  );
}

function getCuratedRoutebook(publicId) {
  const id = sanitizePublicId(publicId);
  const source = curatedRoutes.find((route) => sanitizePublicId(route.id) === id);
  if (!source) return null;
  const normalized = normalizeRoutebookForStorage({
    ...curatedRouteToRoutebook(source),
    schemaVersion: 2,
    version: 1,
    parentVersion: null,
    createdAt: CURATED_ROUTE_VERSION,
    publishedAt: CURATED_ROUTE_VERSION,
    changeReason: '编辑部精选初始版本',
    actorType: 'admin',
    profileId: 'official-curation',
    publishStatus: 'featured',
    sourceAuthorization: 'self-owned',
    creator: {
      id: 'official-curation',
      name: '可信路书编辑部',
      bio: '首批可信城市路线由编辑样板和真实打卡持续校准。',
      sourceAuthorization: 'self-owned'
    },
    provider: {
      name: 'curation',
      model: 'ops-template',
      generatedAt: CURATED_ROUTE_VERSION
    }
  }, id);
  return {
    ...normalized,
    updatedAt: CURATED_ROUTE_VERSION,
    provider: {
      ...normalized.provider,
      generatedAt: CURATED_ROUTE_VERSION,
      savedAt: CURATED_ROUTE_VERSION
    }
  };
}

async function getResolvableRoutebook(publicId) {
  return (await getSavedRoutebook(publicId)) ?? getCuratedRoutebook(publicId);
}

function isCuratedRouteId(publicId) {
  return CURATED_ROUTE_IDS.has(sanitizePublicId(publicId));
}

async function getSavedProfile(profileId) {
  const id = normalizeProfileId(profileId);
  if (!id || id === 'anonymous') return null;
  // 同 getSavedRoutebook：老 profile 被尾窗挤出会被误判为未注册，扫到文件头。
  return findLatestJsonLine(
    PROFILE_LOG_PATH,
    (row) => normalizeProfileId(row?.id || row?.profileId) === id,
    Number.POSITIVE_INFINITY
  );
}

async function updateRoutebookStatus(publicId, input) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  const publishStatus = truncateString(input?.publishStatus || input?.status, 40);
  if (publishStatus && !ROUTEBOOK_STATUSES.has(publishStatus)) {
    throw createHttpError('发布状态只能是 draft/published/featured/archived', 400, 'BAD_ROUTEBOOK_STATUS');
  }
  const nextStatus = publishStatus || routebook.publishStatus || 'draft';
  const versionMetadata = await routebookMutationMetadata(routebook, input, {
    changeReason: `运营状态变更：${routebook.publishStatus || 'draft'} -> ${nextStatus}`,
    actorType: 'admin'
  });
  const creator = input?.creator ? normalizeCreator(input.creator) : normalizeCreator(routebook.creator);
	  const updated = normalizeRoutebookForStorage({
	    ...routebook,
	    ...versionMetadata,
	    editToken: sanitizeEditToken(routebook.editToken),
	    publishStatus: nextStatus,
    sourceAuthorization: truncateString(input?.sourceAuthorization || creator.sourceAuthorization || routebook.sourceAuthorization, 40),
    creator,
    opsNote: truncateString(input?.opsNote, 400),
    provider: {
      ...(routebook.provider ?? {}),
      statusUpdatedAt: new Date().toISOString()
    }
  }, routebook.publicId || routebook.id);
  const opsNote = truncateString(input?.opsNote, 400);
  await appendVersionedRoutebook(updated, 'status-changed', {
    previousStatus: routebook.publishStatus || 'draft',
    // normalizeRoutebookForStorage 不保留 opsNote 字段，运营备注写入审计明细。
    ...(opsNote ? { opsNote } : {})
  });
  return updated;
}

function isPublicRoutebook(routebook) {
  return PUBLIC_ROUTE_STATUSES.has(routebook?.publishStatus || 'draft');
}

function hasPublicTrustSamples(sampleCount) {
  return clampNumber(sampleCount, 0, 1000000, 0) >= PUBLIC_TRUST_SAMPLE_THRESHOLD;
}

function hasPublicRouteTrustScore(meta = {}) {
  return hasPublicTrustSamples(meta?.sampleCount) &&
    meta?.source === 'verified-feedback' &&
    isValidTrustDisplayScore(meta?.displayScore);
}

function isValidTrustDisplayScore(value) {
  const present = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  if (!present) return false;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100;
}

function publicRoutebookView(routebook) {
  if (!routebook) return null;
  const routeTrustVisible = hasPublicRouteTrustScore(routebook.trustMeta);
  const publicRouteTrustScore = routeTrustVisible
    ? clampNumber(routebook.trustMeta.displayScore, 0, 100, 0)
    : null;
  return {
    id: sanitizePublicId(routebook.id || routebook.publicId),
    publicId: sanitizePublicId(routebook.publicId || routebook.id),
    title: truncateString(routebook.title, 80),
    summary: truncateString(routebook.summary, 220),
    city: routebook.city ? normalizeCityName(routebook.city) : '',
    trustScore: publicRouteTrustScore,
    trustMeta: publicTrustMeta(routebook.trustMeta),
    days: Array.isArray(routebook.days) ? routebook.days.map((day) => truncateString(day, 24)).filter(Boolean).slice(0, 10) : [],
    stops: Array.isArray(routebook.stops) ? routebook.stops.slice(0, MAX_ROUTEBOOK_STOPS).map(publicRoutebookStop) : [],
    assets: Array.isArray(routebook.assets) ? routebook.assets.slice(0, 12).map((item) => ({
      label: truncateString(item?.label, 30),
      type: truncateString(item?.type, 24),
      confidence: item?.confidence == null ? null : clampNumber(item.confidence, 0, 100, 0)
    })) : [],
    validations: Array.isArray(routebook.validations) ? routebook.validations.slice(0, 8).map((item) => ({
      id: sanitizePublicId(item?.id),
      label: truncateString(item?.label, 60),
      state: truncateString(item?.state, 40),
      detail: truncateString(item?.detail, 220)
    })) : [],
    metrics: Array.isArray(routebook.metrics) ? routebook.metrics.slice(0, 10).map((item) => ({
      label: truncateString(item?.label, 60),
      value: !routeTrustVisible && item?.label === '站点均分'
        ? '待验证'
        : truncateString(item?.value, 80)
    })) : [],
    feedbackSummary: publicFeedbackSummary(routebook.feedbackSummary),
    variants: Array.isArray(routebook.variants)
      ? routebook.variants.slice(0, 8).map(publicRouteVariant)
      : [],
    activeVariantId: sanitizePublicId(routebook.activeVariantId),
    creator: publicCreatorView(routebook.creator),
    publishStatus: PUBLIC_ROUTE_STATUSES.has(routebook.publishStatus) ? routebook.publishStatus : 'published',
    sourceAuthorization: truncateString(routebook.sourceAuthorization || routebook.creator?.sourceAuthorization, 40),
    copyCount: clampNumber(routebook.copyCount, 0, 1000000, 0),
    schemaVersion: positiveInteger(routebook.schemaVersion, 1),
    version: positiveInteger(routebook.version, 1),
    parentVersion: positiveInteger(routebook.parentVersion),
    createdAt: truncateString(routebook.createdAt, 60),
    publishedAt: truncateString(routebook.publishedAt, 60),
    archivedAt: truncateString(routebook.archivedAt, 60),
    updatedAt: truncateString(routebook.updatedAt, 60)
  };
}

function publicRoutebookStop(stop = {}) {
  const poiTrust = publicPoiTrust(stop.poiTrust);
  const poiTrustVisible = poiTrust?.score != null;
  return {
    id: typeof stop.id === 'number' ? stop.id : sanitizePublicId(stop.id),
    poiId: sanitizePublicId(stop.poiId),
    day: truncateString(stop.day, 24),
    time: truncateString(stop.time, 24),
    name: truncateString(stop.name, 48),
    area: truncateString(stop.area, 40),
    stay: truncateString(stop.stay, 24),
    cost: truncateString(stop.cost, 32),
    verify: truncateString(stop.verify, 120),
    risk: truncateString(stop.risk, 120),
    score: poiTrustVisible && stop.score != null ? clampNumber(stop.score, 0, 100, 0) : null,
    lat: Number.isFinite(Number(stop.lat)) ? Number(stop.lat) : null,
    lng: Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : null,
    geoConfidence: stop.geoConfidence == null ? null : clampNumber(stop.geoConfidence, 0, 100, 0),
    coordinateSystem: truncateString(stop.coordinateSystem, 20),
    coordinateSource: truncateString(stop.coordinateSource, 40),
    coordinatePrecision: truncateString(stop.coordinatePrecision, 40),
    coordinateRadiusMeters: stop.coordinateRadiusMeters == null ? null : clampNumber(stop.coordinateRadiusMeters, 0, 1000000, 0),
    navigationDisabled: stop.navigationDisabled === true,
    poiTrust,
    sourceEvidence: Array.isArray(stop.sourceEvidence) ? stop.sourceEvidence.slice(0, 5).map((item) => ({
      id: sanitizePublicId(item?.id),
      type: truncateString(item?.type, 32),
      label: truncateString(item?.label, 80),
      platform: truncateString(item?.platform, 40),
      trustScore: item?.trustScore == null ? null : clampNumber(item.trustScore, 0, 100, 0),
      checkedAt: truncateString(item?.checkedAt, 60)
    })) : [],
    facts: Array.isArray(stop.facts) ? stop.facts.slice(0, 8).map((item) => ({
      id: sanitizePublicId(item?.id),
      field: truncateString(item?.field, 40),
      value: truncateString(item?.value, 180),
      confidence: item?.confidence == null ? null : clampNumber(item.confidence, 0, 100, 0),
      sourceLabel: truncateString(item?.sourceLabel, 80),
      sourceType: truncateString(item?.sourceType, 32),
      status: truncateString(item?.status, 24),
      checkedAt: truncateString(item?.checkedAt, 60)
    })) : []
  };
}

function publicRouteVariant(variant = {}) {
  return {
    id: sanitizePublicId(variant.id),
    mode: truncateString(variant.mode, 24),
    label: truncateString(variant.label, 40),
    summary: truncateString(variant.summary, 160),
    days: Array.isArray(variant.days) ? variant.days.map((day) => truncateString(day, 24)).filter(Boolean).slice(0, 10) : [],
    stops: Array.isArray(variant.stops) ? variant.stops.slice(0, MAX_ROUTEBOOK_STOPS).map(publicRoutebookStop) : [],
    trustScore: null,
    metrics: Array.isArray(variant.metrics) ? variant.metrics.slice(0, 10).map((item) => ({
      label: truncateString(item?.label, 60),
      value: item?.label === '站点均分' ? '待验证' : truncateString(item?.value, 80)
    })) : [],
    validations: Array.isArray(variant.validations) ? variant.validations.slice(0, 8).map((item) => ({
      id: sanitizePublicId(item?.id),
      label: truncateString(item?.label, 60),
      state: truncateString(item?.state, 40),
      detail: truncateString(item?.detail, 220)
    })) : [],
    createdAt: truncateString(variant.createdAt, 60),
    updatedAt: truncateString(variant.updatedAt, 60)
  };
}

function publicCreatorView(creator = {}) {
  const normalized = normalizeCreator(creator);
  return {
    id: normalized.id,
    name: normalized.name,
    avatar: normalized.avatar,
    bio: normalized.bio,
    sourceAuthorization: normalized.sourceAuthorization
  };
}

function publicTrustMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return null;
  const scoreVisible = hasPublicRouteTrustScore(meta);
  return {
    predictionScore: scoreVisible && meta.predictionScore != null ? clampNumber(meta.predictionScore, 0, 100, 0) : null,
    feedbackScore: scoreVisible && meta.feedbackScore != null ? clampNumber(meta.feedbackScore, 0, 100, 0) : null,
    displayScore: scoreVisible ? clampNumber(meta.displayScore, 0, 100, 0) : null,
    source: truncateString(meta.source, 24),
    label: truncateString(meta.label, 60),
    sampleCount: clampNumber(meta.sampleCount, 0, 1000000, 0),
    aiWeight: scoreVisible && meta.aiWeight != null ? clampNumber(meta.aiWeight, 0, 1, 0) : null,
    feedbackWeight: scoreVisible && meta.feedbackWeight != null ? clampNumber(meta.feedbackWeight, 0, 1, 0) : null,
    latestVerifiedAt: truncateString(meta.latestVerifiedAt, 60)
  };
}

function publicFeedbackSummary(summary = {}) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    sampleCount: clampNumber(summary.sampleCount, 0, 1000000, 0),
    attestedCheckinCount: clampNumber(summary.attestedCheckinCount, 0, 1000000, 0),
    validArrivalCount: clampNumber(summary.validArrivalCount, 0, 1000000, 0),
    lowConfidenceArrivalCount: clampNumber(summary.lowConfidenceArrivalCount, 0, 1000000, 0),
    feedbackCount: clampNumber(summary.feedbackStopCount ?? summary.feedbackCount, 0, 1000000, 0),
    feedbackStopCount: clampNumber(summary.feedbackStopCount ?? summary.feedbackCount, 0, 1000000, 0),
    pitfallCount: clampNumber(summary.pitfallCount, 0, 1000000, 0),
    pitfallRate: summary.pitfallRate == null ? null : clampNumber(summary.pitfallRate, 0, 100, 0),
    correctionCount: clampNumber(summary.correctionCount, 0, 1000000, 0),
    completionRate: summary.completionRate == null ? null : clampNumber(summary.completionRate, 0, 100, 0),
    // rank20④：旧并集完成率口径（coverageRate）进入公开白名单。
    coverageRate: summary.coverageRate == null ? null : clampNumber(summary.coverageRate, 0, 100, 0),
    latestFeedbackAt: truncateString(summary.latestFeedbackAt, 60)
  };
}

function publicPoiTrust(poiTrust = {}) {
  if (!poiTrust || typeof poiTrust !== 'object') return null;
  const scoreVisible = hasPublicTrustSamples(poiTrust.sampleCount) &&
    poiTrust.score != null &&
    Number.isFinite(Number(poiTrust.score));
  const parsedLatestVerifiedAt = Date.parse(poiTrust.latestVerifiedAt ?? '');
  const derivedFreshnessDays = Number.isFinite(parsedLatestVerifiedAt)
    ? Math.max(0, Math.floor((Date.now() - parsedLatestVerifiedAt) / (24 * 60 * 60 * 1000)))
    : null;
  const sampleCount = clampNumber(poiTrust.sampleCount, 0, 1000000, 0);
  return {
    score: scoreVisible ? clampNumber(poiTrust.score, 0, 100, 0) : null,
    scope: truncateString(poiTrust.scope, 32),
    sampleCount,
    validArrivals: clampNumber(poiTrust.validArrivals, 0, 1000000, 0),
    pitfallRate: poiTrust.pitfallRate == null ? null : clampNumber(poiTrust.pitfallRate, 0, 100, 0),
    // rank20①：打卡反哺的经验聚合字段（人群构成/排队/花费/拥挤/最新反馈）。
    audienceBreakdown: Array.isArray(poiTrust.audienceBreakdown)
      ? poiTrust.audienceBreakdown.slice(0, 6).map((item) => ({
          label: truncateString(item?.label, 80),
          count: clampNumber(item?.count, 0, 1000000, 0),
          share: clampNumber(Math.round(Number(item?.share)), 0, 100, 0)
        })).filter((item) => item.label)
      : [],
    queueMinutesMedian: poiTrust.queueMinutesMedian == null ? null : clampNumber(poiTrust.queueMinutesMedian, 0, 100000, 0),
    costMedian: poiTrust.costMedian == null ? null : clampNumber(poiTrust.costMedian, 0, 10000000, 0),
    crowdLevel: truncateString(poiTrust.crowdLevel, 30),
    latestFeedbackAt: truncateString(poiTrust.latestFeedbackAt || poiTrust.latestVerifiedAt, 60),
    recentCorrectionCount: clampNumber(poiTrust.recentCorrectionCount, 0, 1000000, 0),
    latestVerifiedAt: truncateString(poiTrust.latestVerifiedAt, 60),
    freshnessDays: poiTrust.freshnessDays == null
      ? derivedFreshnessDays
      : clampNumber(poiTrust.freshnessDays, 0, 36500, 0),
    trustState: scoreVisible ? 'verified' : sampleCount > 0 ? 'collecting' : 'pending',
    label: truncateString(poiTrust.label, 60)
  };
}

function publicReviewView(review) {
  if (!review) return null;
  return {
    publicId: sanitizePublicId(review.publicId || review.id),
    routebookId: sanitizePublicId(review.routebookId || review.routebook?.publicId || review.routebook?.id),
    routebook: publicReviewRoutebookView(review.routebook),
    executionStops: Array.isArray(review.executionStops)
      ? review.executionStops.slice(0, MAX_ROUTEBOOK_STOPS).map(publicReviewExecutionStop)
      : [],
    checkins: Array.isArray(review.checkins)
      ? review.checkins.slice(0, MAX_ROUTEBOOK_STOPS).map(publicCheckinForReview)
      : [],
    stats: publicReviewStats(review.stats)
  };
}

function publicReviewRoutebookView(routebook = {}) {
  return {
    id: sanitizePublicId(routebook.id || routebook.publicId),
    publicId: sanitizePublicId(routebook.publicId || routebook.id),
    title: truncateString(routebook.title, 80),
    city: routebook.city ? normalizeCityName(routebook.city) : '',
    stops: Array.isArray(routebook.stops)
      ? routebook.stops.slice(0, MAX_ROUTEBOOK_STOPS).map(publicReviewRouteStop)
      : []
  };
}

function publicReviewRouteStop(stop = {}) {
  return {
    id: typeof stop.id === 'number' ? stop.id : sanitizePublicId(stop.id),
    day: truncateString(stop.day, 24),
    time: truncateString(stop.time, 24),
    name: truncateString(stop.name, 48)
  };
}

function publicReviewExecutionStop(stop = {}) {
  return {
    ...publicReviewRouteStop(stop),
    tripReplacementFor: truncateString(stop.tripReplacementFor, 80),
    tripStatus: ['pending', 'visited', 'skipped'].includes(stop.tripStatus) ? stop.tripStatus : '',
    // rank13④：执行站点也透出照片证据 ID，供回顾页照片墙渲染。
    photoId: normalizeCheckinPhotoId(stop.photoId)
  };
}

function publicReviewStats(stats = {}) {
  return {
    completionRate: clampNumber(stats.completionRate, 0, 100, 0),
    checkinCount: clampNumber(stats.checkinCount, 0, MAX_ROUTEBOOK_STOPS, 0),
    feedbackCount: clampNumber(stats.feedbackCount, 0, MAX_ROUTEBOOK_STOPS, 0),
    validArrivalCount: clampNumber(stats.validArrivalCount, 0, MAX_ROUTEBOOK_STOPS, 0),
    lowConfidenceArrivalCount: clampNumber(stats.lowConfidenceArrivalCount, 0, MAX_ROUTEBOOK_STOPS, 0),
    pitfallCount: clampNumber(stats.pitfallCount, 0, MAX_ROUTEBOOK_STOPS, 0)
  };
}

async function copyRoutebook(publicId, input = {}) {
  const routebook = await getResolvableRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if (!isPublicRoutebook(routebook)) {
    throw createHttpError('路书尚未公开发布或已失效', 404, 'ROUTEBOOK_NOT_FOUND');
  }
  const routeId = sanitizePublicId(routebook.publicId || routebook.id);
  const actorKey = copyActorKey(input);
  const copyEvents = (await readJsonLines(EXPOSURE_LOG_PATH, 50000))
    .filter((event) => isRoutebookCopyExposure(event, routeId));
  const countedActors = new Set(copyEvents.map(copyActorKey).filter(Boolean));
  if (actorKey && !countedActors.has(actorKey)) {
    await appendJsonLine(EXPOSURE_LOG_PATH, {
      ...normalizeExposure({
        ...input,
        surface: input?.surface || 'copy-routebook',
        itemType: 'routebook-copy',
        itemId: routeId,
        routeId,
        routeTitle: routebook.title,
        city: routebook.city,
        creatorId: routebook.creator?.id
      }),
      // 标记服务端复制接口落库的合法来源；/api/exposures 已拒绝客户端直写此类型。
      copyAttribution: 'server-copy-endpoint'
    });
    countedActors.add(actorKey);
  }
  return { ...routebook, copyCount: countedActors.size };
}

function copyActorKey(input = {}) {
  const profileId = normalizeProfileId(input?.profileId);
  if (profileId && profileId !== 'anonymous') return `profile:${profileId}`;
  const sessionId = sanitizePublicId(input?.sessionId);
  return sessionId ? `session:${sessionId}` : '';
}

// 只统计合法来源：内部复制接口落库的行一定带 itemType='routebook-copy'；
// 仅凭 surface='copy-routebook' 的行只可能来自历史客户端伪造直写，不再计入。
function isRoutebookCopyExposure(event, routeId = '') {
  const eventRouteId = sanitizePublicId(event?.routeId || event?.itemId);
  return Boolean(
    event?.itemType === 'routebook-copy' &&
    (!routeId || eventRouteId === routeId)
  );
}

function routebookCopyCount(exposures, routeId) {
  return new Set((exposures ?? [])
    .filter((event) => isRoutebookCopyExposure(event, routeId))
    .map(copyActorKey)
    .filter(Boolean)).size;
}

function totalRoutebookCopyCount(exposures) {
  return new Set((exposures ?? [])
    .filter((event) => isRoutebookCopyExposure(event))
    .map((event) => {
      const routeId = sanitizePublicId(event?.routeId || event?.itemId);
      const actorKey = copyActorKey(event);
      return routeId && actorKey ? `${routeId}::${actorKey}` : '';
    })
    .filter(Boolean)).size;
}

function normalizePoiCorrection(input) {
  const name = truncateString(input?.stopName ?? input?.name, 80);
  if (!name) throw createHttpError('请提供要纠错的 POI 名称', 400, 'POI_NAME_REQUIRED');
  return {
    id: cryptoRandomId(),
    routeTitle: truncateString(input?.routeTitle, 100),
    city: input?.city ? normalizeCityName(input.city) : '',
    stopId: truncateString(input?.stopId, 40),
    stopName: name,
    field: truncateString(input?.field, 40) || '综合信息',
    currentValue: truncateString(input?.currentValue, 300),
    suggestedValue: truncateString(input?.suggestedValue, 500),
    reason: truncateString(input?.reason, 500),
    contact: truncateString(input?.contact, 120),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
}

async function normalizeReviewShare(input, canonicalRoutebook = null, options = {}) {
  const routebook = canonicalRoutebook
    ? normalizeRoutebookForStorage(canonicalRoutebook, canonicalRoutebook.publicId || canonicalRoutebook.id)
    : normalizeRoutebookForStorage(input?.routebook ?? input);
  if (!isPublicRoutebook(routebook)) {
    throw createHttpError('路书公开发布后才能生成回顾分享页', 403, 'REVIEW_ROUTE_NOT_PUBLIC');
  }
  const profileId = normalizeProfileId(options.profileId || input?.profileId || 'anonymous');
  const routeId = sanitizePublicId(routebook.publicId || routebook.id);
  // 按 profile + route 谓词精确反扫，避免全局尾窗把老用户的打卡挤出统计窗口。
  const persistedCheckins = options.includePersistedProfileCheckins && profileId !== 'anonymous'
    ? await readMatchingJsonLines(
        CHECKIN_LOG_PATH,
        (item) => sanitizePublicId(item?.routeId) === routeId && normalizeProfileId(item?.profileId) === profileId,
        5000,
        100000
      )
    : [];
  const verifiedCheckins = persistedCheckins
    .filter((item) => isPublicTrustEligibleCheckin(item))
    .map(publicCheckinForReview);
  const checkins = latestCheckinsByStop(verifiedCheckins);
  const executionStops = normalizeReviewExecutionStops(input?.executionStops, routebook);
  const feedbackCheckins = checkins.filter((item) => item.worth !== '跳过' && item.status !== 'skipped');
  const validCheckins = feedbackCheckins.filter((item) => item.arrival?.valid === true);
  // 完成率分母固定用主线站点数，防止客户端裁剪 executionStops 伪造 100% 完成率。
  const routeStopCount = routebook.stops.length;
  const reviewId = cryptoRandomId();
  return {
    id: reviewId,
    publicId: reviewId,
    routebookId: routeId,
    profileId,
    routebook: publicRoutebookView(routebook),
    executionStops,
    checkins,
    selfReportedCheckinCount: 0,
    stats: {
      completionRate: routeStopCount ? Math.min(100, Math.round((validCheckins.length / routeStopCount) * 100)) : 0,
      checkinCount: checkins.length,
      feedbackCount: feedbackCheckins.length,
      validArrivalCount: validCheckins.length,
      lowConfidenceArrivalCount: feedbackCheckins.filter((item) => ['weak', 'invalid'].includes(item.arrivalConfidence || item.arrival?.confidence)).length,
      pitfallCount: checkins.filter((item) => item.worth === '踩坑' || item.pitfall).length
    },
    createdAt: new Date().toISOString()
  };
}

function normalizeReviewExecutionStops(input, routebook) {
  if (!Array.isArray(input) || !input.length) return [];
  const allowedStops = [
    ...(routebook?.stops ?? []),
    ...(routebook?.variants ?? []).flatMap((variant) => variant?.stops ?? [])
  ];
  const byId = new Map(allowedStops.map((stop) => [String(stop?.id ?? '').trim(), stop]).filter(([key]) => key));
  const byName = new Map(allowedStops.map((stop) => [String(stop?.name ?? '').trim(), stop]).filter(([key]) => key));
  const seen = new Set();
  const output = [];
  for (const candidate of input.slice(0, MAX_ROUTEBOOK_STOPS)) {
    const id = String(candidate?.id ?? '').trim();
    const name = String(candidate?.name ?? '').trim();
    const canonical = byId.get(id) ?? byName.get(name);
    if (!canonical) continue;
    const key = String(canonical.id ?? canonical.name ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({
      ...publicRoutebookStop(canonical),
      day: truncateString(candidate?.day || canonical.day, 24),
      time: truncateString(candidate?.time || canonical.time, 24),
      tripReplacementFor: truncateString(candidate?.tripReplacementFor, 80),
      tripStatus: ['pending', 'visited', 'skipped'].includes(candidate?.tripStatus) ? candidate.tripStatus : '',
      photoId: normalizeCheckinPhotoId(candidate?.photoId)
    });
  }
  return output;
}

// rank13：photoId 只放行 [A-Za-z0-9_-]{1,64}，其余一律置空。
function normalizeCheckinPhotoId(value) {
  const id = String(value ?? '').trim();
  return CHECKIN_PHOTO_ID_PATTERN.test(id) ? id : '';
}

function publicCheckinForReview(item = {}) {
  const arrival = item?.arrival && typeof item.arrival === 'object'
    ? {
        valid: item.arrival.valid === true,
        confidence: truncateString(item.arrival.confidence || item.arrivalConfidence, 24),
        label: truncateString(item.arrival.label, 40)
      }
    : null;
  return {
    localStopKey: truncateString(item?.localStopKey, 120),
    stopId: truncateString(item?.stopId, 80),
    poiId: sanitizePublicId(item?.poiId),
    stopName: truncateString(item?.stopName, 80),
    status: truncateString(item?.status, 24),
    worth: truncateString(item?.worth, 30),
    queue: truncateString(item?.queue, 40),
    cost: truncateString(item?.cost, 40),
    crowd: truncateString(item?.crowd, 30),
    comment: truncateString(item?.comment, 300),
    pitfall: truncateString(item?.pitfall, 240),
    // rank13④：照片证据 ID 随回顾透出（照片本体经 GET /api/checkin-photos/:id 提供）。
    photoId: normalizeCheckinPhotoId(item?.photoId),
    arrivalConfidence: arrival?.confidence || '',
    arrival
  };
}

function latestCheckinsByStop(checkins = []) {
  const latest = new Map();
  for (const item of checkins) {
    const key = checkinStopKey(item);
    if (!key) continue;
    if (!latest.has(key)) latest.set(key, item);
  }
  return [...latest.values()];
}

function checkinStopKey(item = {}) {
  return String(item?.localStopKey || item?.stopId || item?.stopName || '').trim();
}

// A phone/WeChat binding is a weighting signal, not an admission gate: gating public
// samples on it stalls every route at "待验证" until a login backend exists. A
// server-issued profile token is still a durable pseudonymous identity, and samples stay
// deduplicated per profile, so profile-owned check-ins count too.
function isPublicTrustEligibleCheckin(item = {}) {
  return PUBLIC_TRUST_ELIGIBLE_STATES.has(item?.trustState);
}

function isEligibleTrustCheckin(item = {}) {
  const profileId = normalizeProfileId(item?.profileId);
  return item?.status === 'visited' &&
    isPublicTrustEligibleCheckin(item) &&
    item?.arrival?.valid === true &&
    Boolean(profileId && profileId !== 'anonymous');
}

function latestTrustedCheckinsByProfileAndStop(checkins = []) {
  const latest = new Map();
  for (const item of checkins) {
    const profileId = normalizeProfileId(item?.profileId);
    const stopKey = checkinStopKey(item);
    if (!profileId || profileId === 'anonymous' || !stopKey) continue;
    const key = `${profileId}:${stopKey}`;
    if (!latest.has(key)) latest.set(key, item);
  }
  return [...latest.values()];
}

function latestTrustedCheckinsByProfileAndPoi(checkins = []) {
  const latest = new Map();
  for (const item of checkins) {
    const profileId = normalizeProfileId(item?.profileId);
    const poiId = poiCheckinKey(item);
    if (!profileId || profileId === 'anonymous' || !poiId) continue;
    const key = `${profileId}:${poiId}`;
    if (!latest.has(key)) latest.set(key, item);
  }
  return [...latest.values()];
}

function poiCheckinKey(item = {}) {
  return resolvePoiId(item, item?.city);
}

async function getSavedReview(publicId) {
  const id = sanitizePublicId(publicId);
  if (!id) return null;
  return findLatestJsonLine(
    REVIEW_LOG_PATH,
    (row) => sanitizePublicId(row?.id || row?.publicId) === id,
    Number.POSITIVE_INFINITY
  );
}

async function reviewIsStillPublic(review) {
  const routeId = sanitizePublicId(review?.routebookId || review?.routebook?.publicId || review?.routebook?.id);
  if (!routeId) return isPublicRoutebook(review?.routebook);
  const currentRoutebook = await getResolvableRoutebook(routeId);
  return isPublicRoutebook(currentRoutebook);
}

function normalizeRoutebookDraftForStorage(input, existingRoutebook = null) {
  const profileId = normalizeProfileId(input?.profileId || existingRoutebook?.profileId);
  const hardenedInput = hardenDraftCoordinateProvenance(input, existingRoutebook);
  return normalizeRoutebookForStorage({
    ...hardenedInput,
    profileId,
    creator: normalizeUserRouteCreator(hardenedInput, profileId),
    sourceAuthorization: 'user-generated',
    editToken: sanitizeEditToken(hardenedInput?.editToken) || sanitizeEditToken(existingRoutebook?.editToken) || createRouteEditToken(),
    publishStatus: 'draft',
    copyCount: existingRoutebook ? (existingRoutebook.copyCount ?? hardenedInput?.copyCount ?? 0) : 0
  }, existingRoutebook ? (existingRoutebook.publicId || existingRoutebook.id) : '');
}

function hardenDraftCoordinateProvenance(input = {}, existingRoutebook = null) {
  const city = normalizeCityName(input?.city || existingRoutebook?.city);
  const existingStops = Array.isArray(existingRoutebook?.stops) ? existingRoutebook.stops : [];
  const variantsById = new Map((existingRoutebook?.variants ?? []).map((variant) => [String(variant?.id || variant?.mode || ''), variant]));
  return {
    ...input,
    stops: hardenDraftStops(input?.stops, existingStops, city),
    variants: Array.isArray(input?.variants)
      ? input.variants.map((variant) => {
          const existingVariant = variantsById.get(String(variant?.id || variant?.mode || ''));
          return {
            ...variant,
            stops: hardenDraftStops(variant?.stops, existingVariant?.stops ?? existingStops, city)
          };
        })
      : input?.variants
  };
}

function hardenDraftStops(stops, existingStops, city) {
  if (!Array.isArray(stops)) return stops;
  const existingById = new Map((existingStops ?? []).map((stop) => [String(stop?.id ?? ''), stop]).filter(([key]) => key));
  const existingByName = new Map((existingStops ?? []).map((stop) => [String(stop?.name ?? '').trim(), stop]).filter(([key]) => key));
  return stops.map((stop) => {
    const name = truncateString(stop?.name, 48);
    const canonical = coordinateForName(name, city);
    if (canonical) {
      return {
        ...stop,
        lat: canonical.lat,
        lng: canonical.lng,
        geoConfidence: canonical.confidence,
        coordinateSource: canonical.source,
        coordinatePrecision: canonical.precision,
        coordinateRadiusMeters: canonical.radiusMeters,
        navigationDisabled: canonical.navigationDisabled
      };
    }
    const existing = existingById.get(String(stop?.id ?? '')) ?? existingByName.get(name);
    // 站点改名后不回填旧 provenance：按 id+坐标命中但名称已变的站点，旧
    // geoConfidence/coordinateSource 描述的是旧 POI。新名字已在上方走过
    // coordinateForName（可信 POI 匹配），未命中则落入下方低置信降级分支。
    const existingNameMatches = existing
      ? normalizePoiName(existing?.name) === normalizePoiName(name) && Boolean(normalizePoiName(name))
      : false;
    if (existing && existingNameMatches && coordinatesMatch(stop, existing)) {
      return {
        ...stop,
        geoConfidence: existing.geoConfidence,
        coordinateSource: existing.coordinateSource,
        coordinatePrecision: existing.coordinatePrecision,
        coordinateRadiusMeters: existing.coordinateRadiusMeters,
        navigationDisabled: existing.navigationDisabled === true
      };
    }
    if (!isValidCoordinate(Number(stop?.lat), Number(stop?.lng))) return stop;
    return {
      ...stop,
      geoConfidence: 45,
      coordinateSource: 'user-edit',
      coordinatePrecision: 'approximate',
      coordinateRadiusMeters: Math.max(1000, clampNumber(stop?.coordinateRadiusMeters, 1000, 100000, 1500)),
      navigationDisabled: true
    };
  });
}

function coordinatesMatch(left, right) {
  const leftLat = Number(left?.lat);
  const leftLng = Number(left?.lng);
  const rightLat = Number(right?.lat);
  const rightLng = Number(right?.lng);
  return isValidCoordinate(leftLat, leftLng) &&
    isValidCoordinate(rightLat, rightLng) &&
    Math.abs(leftLat - rightLat) < 0.000001 &&
    Math.abs(leftLng - rightLng) < 0.000001;
}

function normalizeUserRouteCreator(input = {}, profileId = '') {
  const creator = normalizeCreator(input?.creator);
  const id = normalizeProfileId(profileId || input?.profileId || creator.id);
  return {
    ...creator,
    id,
    name: creator.name === '可信路书编辑部' ? '匿名旅行者' : creator.name,
    sourceAuthorization: 'user-generated'
  };
}

function canOverwriteRoutebook(existingRoutebook, input) {
  if (!existingRoutebook) return true;
  const existingToken = sanitizeEditToken(existingRoutebook.editToken);
  if (existingToken) return sanitizeEditToken(input?.editToken) === existingToken;
  return false;
}

async function ensureDraftEditToken(routebook) {
  if (!routebook || sanitizeEditToken(routebook.editToken) || (routebook.publishStatus || 'draft') !== 'draft') {
    return routebook;
  }
  const id = sanitizePublicId(routebook.publicId || routebook.id);
  if (!id) return routebook;
  // 并发读同一份无令牌历史草稿会补发多个不同 token：加互斥锁并在锁内重读
  // 最新快照，只有确认仍缺 token 时才补发一次。
  return withSingleProcessKeyLock(routebookMutationLocks, id, async () => {
    const latest = (await getSavedRoutebook(id)) ?? routebook;
    if (sanitizeEditToken(latest.editToken) || (latest.publishStatus || 'draft') !== 'draft') {
      return latest;
    }
    const currentVersion = await currentRoutebookVersion(id);
    const updated = normalizeRoutebookDraftForStorage({
      ...latest,
      schemaVersion: positiveInteger(latest.schemaVersion, currentVersion ? 2 : 1),
      version: currentVersion || 1,
      parentVersion: positiveInteger(latest.parentVersion),
      editToken: createRouteEditToken(),
      editReason: '补发历史草稿编辑令牌',
      provider: {
        ...(latest.provider ?? {}),
        tokenMigratedAt: new Date().toISOString()
      }
    }, latest);
    await appendJsonLine(ROUTEBOOK_LOG_PATH, updated);
    return updated;
  });
}

async function saveDraftRoutebook(input) {
  const requestedId = sanitizePublicId(input?.id || input?.publicId);
  if (requestedId && isCuratedRouteId(requestedId)) {
    throw createHttpError('精选路书 ID 为只读保留标识，请先复制为新的个人草稿', 403, 'CURATED_ROUTE_ID_RESERVED');
  }
  const existing = requestedId ? await getSavedRoutebook(requestedId) : null;
  if (existing) {
    if ((existing.publishStatus || 'draft') !== 'draft') {
      throw createHttpError('公开、精选或归档路书不能通过普通保存接口覆盖', 403, 'ROUTEBOOK_PUBLISHED_OVERWRITE_FORBIDDEN');
    }
    if (!canOverwriteRoutebook(existing, input)) {
      throw createHttpError('不能覆盖其他用户或公开来源的路书', 403, 'ROUTEBOOK_OVERWRITE_FORBIDDEN');
    }
  }
  const versionMetadata = existing
    ? await routebookMutationMetadata(existing, input, {
        changeReason: truncateString(input?.editReason, 120) || '保存草稿',
        actorType: 'user'
      })
    : {
        schemaVersion: 2,
        version: 1,
        parentVersion: null,
        changeReason: truncateString(input?.changeReason || input?.editReason, 160) || '创建草稿',
        actorType: 'user'
      };
  if (!existing) assertExpectedRoutebookVersion(input, 0);
  return normalizeRoutebookDraftForStorage({ ...input, ...versionMetadata }, existing);
}

async function publishOwnRoutebook(publicId, input = {}) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if ((routebook.publishStatus || 'draft') === 'archived') {
    throw createHttpError('归档路书不能直接发布，请在运营台恢复状态', 403, 'ROUTEBOOK_ARCHIVED');
  }
  if (!canOverwriteRoutebook(routebook, input)) {
    throw createHttpError('只能发布当前用户保存的路书', 403, 'ROUTEBOOK_OWNER_REQUIRED');
  }
  const versionMetadata = await routebookMutationMetadata(routebook, input, {
    changeReason: '用户发布路书',
    actorType: 'user'
  });
  if (routebook.publishStatus === 'published' || routebook.publishStatus === 'featured') {
    return routebook;
  }
  const profileId = normalizeProfileId(routebook.profileId || input?.profileId);
  const creator = normalizeUserRouteCreator(routebook, profileId);
	  const updated = normalizeRoutebookForStorage({
	    ...routebook,
	    ...versionMetadata,
	    profileId,
	    editToken: sanitizeEditToken(routebook.editToken),
	    publishStatus: 'published',
    sourceAuthorization: 'user-generated',
    creator,
    provider: {
      ...(routebook.provider ?? {}),
      userPublishedAt: new Date().toISOString()
    }
  }, routebook.publicId || routebook.id);
  await appendVersionedRoutebook(updated, 'published', {
    previousStatus: routebook.publishStatus || 'draft'
  });
  return updated;
}

async function listPoiCorrections(limit = 50, { status = '' } = {}) {
  const safeLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 50);
  const statusFilter = truncateString(status, 24);
  // 按 id 去重取最新一行；带状态过滤时放宽去重窗口，再按最新状态筛选。
  const rows = await readLatestUniqueJsonLines(
    POI_CORRECTION_LOG_PATH,
    (row) => sanitizePublicId(row?.id),
    statusFilter ? Math.max(safeLimit * 4, 200) : safeLimit,
    100000
  );
  const filtered = statusFilter ? rows.filter((row) => String(row?.status ?? '') === statusFilter) : rows;
  return filtered.slice(0, safeLimit);
}

async function updatePoiCorrectionStatus(id, input) {
  const correctionId = sanitizePublicId(id);
  const action = String(input?.action ?? '').trim();
  if (!['approved', 'rejected'].includes(action)) {
    throw createHttpError('纠错状态只能是 approved 或 rejected', 400, 'BAD_CORRECTION_STATUS');
  }
  if (!correctionId) throw createHttpError('纠错记录不存在', 404, 'CORRECTION_NOT_FOUND');
  // 按 id 全文件倒扫最新一行，避免旧纠错被尾窗挤出后无法审核。
  const existing = await findLatestJsonLine(
    POI_CORRECTION_LOG_PATH,
    (row) => sanitizePublicId(row?.id) === correctionId,
    Number.POSITIVE_INFINITY
  );
  if (!existing) throw createHttpError('纠错记录不存在', 404, 'CORRECTION_NOT_FOUND');
  const updated = {
    ...existing,
    status: action,
    reviewerNote: truncateString(input?.reviewerNote, 400),
    reviewedAt: new Date().toISOString()
  };
  await appendJsonLine(POI_CORRECTION_LOG_PATH, updated);
  if (action === 'approved') {
    await appendJsonLine(POI_KNOWLEDGE_LOG_PATH, normalizePoiKnowledgeFromCorrection(updated));
  }
  return updated;
}

function poiKnowledgeKey(city, stopName, field = '') {
  return [normalizeCityName(city || '未知'), truncateString(stopName, 80), truncateString(field, 40)]
    .map((item) => String(item ?? '').trim())
    .join('::');
}

function normalizePoiKnowledgeFromCorrection(correction) {
  const city = correction?.city ? normalizeCityName(correction.city) : '';
  const stopName = truncateString(correction?.stopName, 80);
  return {
    id: sanitizePublicId(correction?.id) || cryptoRandomId(),
    correctionId: sanitizePublicId(correction?.id),
    city,
    stopName,
    field: truncateString(correction?.field, 40) || '综合信息',
    value: truncateString(correction?.suggestedValue, 500),
    reason: truncateString(correction?.reason, 500),
    routeTitle: truncateString(correction?.routeTitle, 100),
    reviewerNote: truncateString(correction?.reviewerNote, 400),
    status: 'approved',
    trustDelta: 3,
    createdAt: correction?.reviewedAt || new Date().toISOString()
  };
}

async function listPoiKnowledge({ city = '', stopName = '', limit = 80 } = {}) {
  const rows = await readJsonLines(POI_KNOWLEDGE_LOG_PATH, Math.max(limit * 4, 200));
  const latestByKey = new Map();
  for (const row of rows) {
    const rowCity = row?.city ? normalizeCityName(row.city) : '';
    const rowStopName = String(row?.stopName ?? '');
    const cityMatched = !city || rowCity === city;
    const stopMatched = !stopName || rowStopName === stopName || rowStopName.includes(stopName) || stopName.includes(rowStopName);
    if (!cityMatched || !stopMatched) continue;
    const key = poiKnowledgeKey(rowCity, rowStopName, row?.field);
    if (key && !latestByKey.has(key)) latestByKey.set(key, row);
  }
  return [...latestByKey.values()].slice(0, limit);
}

async function saveRoutebookVariant(publicId, input) {
  const routebook = await getSavedRoutebook(publicId);
  if (!routebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
  if ((routebook.publishStatus || 'draft') !== 'draft') {
    throw createHttpError('公开、精选或归档路书不能通过变体接口修改，请先定制为个人草稿', 403, 'ROUTEBOOK_VARIANT_FORBIDDEN');
  }
  if (!canOverwriteRoutebook(routebook, input)) {
    throw createHttpError('只能修改当前用户保存的草稿变体', 403, 'ROUTEBOOK_OWNER_REQUIRED');
  }
  const versionMetadata = await routebookMutationMetadata(routebook, input, {
    changeReason: '保存路线变体',
    actorType: 'user'
  });
  // 变体链复用草稿保存同款坐标溯源硬化：客户端声明的 geoConfidence /
  // coordinateSource / navigationDisabled 不再原样落库，按「可信 POI 命中 >
  // 服务端已存快照（同名同坐标）> 低置信降级」重新推导，堵住变体绕过缺口。
  const variantInput = input?.variant ?? input;
  const existingVariantsByKey = new Map(
    (routebook.variants ?? []).map((item) => [String(item?.id || item?.mode || ''), item])
  );
  const existingVariant = existingVariantsByKey.get(String(variantInput?.id || variantInput?.mode || ''));
  const hardenedVariantInput = Array.isArray(variantInput?.stops)
    ? {
        ...variantInput,
        stops: hardenDraftStops(
          variantInput.stops,
          existingVariant?.stops ?? routebook.stops ?? [],
          normalizeCityName(routebook.city)
        )
      }
    : variantInput;
  const variant = normalizeRouteVariant(hardenedVariantInput, 0, routebook.city, routebook.stops ?? [], routebookValidationContext(routebook));
  if (!variant) throw createHttpError('路线变体至少需要 2 个站点', 400, 'VARIANT_TOO_SHORT');
  const existingVariants = normalizeRouteVariants(routebook.variants, routebook.city, routebook.stops ?? [], routebookValidationContext(routebook))
    .filter((item) => item.id !== variant.id && item.mode !== variant.mode);
	  const updatedRoutebook = normalizeRoutebookForStorage({
	    ...routebook,
	    ...versionMetadata,
	    editToken: sanitizeEditToken(routebook.editToken),
	    variants: [variant, ...existingVariants].slice(0, 8),
    activeVariantId: variant.id,
    editReason: `${variant.mode}变体`
  }, routebook.publicId || routebook.id);
  await appendVersionedRoutebook(updatedRoutebook, 'variant-saved', {
    variantId: variant.id,
    variantMode: variant.mode
  });
  return { routebook: updatedRoutebook, variant };
}

// rank23①：GET /api/routebooks 列表等批量路径可先 buildRouteFeedbackContext() 一次性
// 读齐 5 份 JSONL，再把同一份行数组传给每次 buildFeedbackSummary 复用，避免逐路书重扫。
const FEEDBACK_SCAN_MATCH_LIMIT = 5000;
const FEEDBACK_SCAN_WINDOW = 100000;

async function buildRouteFeedbackContext() {
  const [checkins, corrections, reviews, routebookHistory, exposures] = await Promise.all([
    readRecentJsonlRows(CHECKIN_LOG_PATH, FEEDBACK_SCAN_WINDOW),
    readRecentJsonlRows(POI_CORRECTION_LOG_PATH, FEEDBACK_SCAN_WINDOW),
    readRecentJsonlRows(REVIEW_LOG_PATH, FEEDBACK_SCAN_WINDOW),
    readRecentJsonlRows(ROUTEBOOK_LOG_PATH, FEEDBACK_SCAN_WINDOW),
    readRecentJsonlRows(EXPOSURE_LOG_PATH, FEEDBACK_SCAN_WINDOW)
  ]);
  return { checkins, corrections, reviews, routebookHistory, exposures };
}

async function buildFeedbackSummary(routebook, feedbackContext = null) {
  const routeTitle = String(routebook?.title ?? '');
  const city = String(routebook?.city ?? '');
  const routeId = sanitizePublicId(routebook?.publicId || routebook?.id);
  const matchesRouteCheckin = (item) =>
    routeId
      ? sanitizePublicId(item?.routeId) === routeId
      : (!routeTitle || item?.routeTitle === routeTitle) && (!city || item?.city === city) && !item?.routeId;
  const globalEligiblePredicate = (item) => isEligibleTrustCheckin(item) && item?.serverResolvedStop === true;
  const correctionPredicate = (item) => (!routeTitle || item?.routeTitle === routeTitle) && (!city || item?.city === city);
  const reviewPredicate = (item) => routeId
    ? sanitizePublicId(item?.routebookId || item?.routebook?.publicId || item?.routebook?.id) === routeId
    : item?.routebook?.title === routeTitle && (!city || item?.routebook?.city === city);
  const historyPredicate = (item) => (routeId && sanitizePublicId(item?.publicId || item?.id) === routeId) ||
    (!routeId && item?.title === routeTitle && item?.city === city);
  const exposurePredicate = (item) => (routeId && sanitizePublicId(item?.routeId || item?.itemId) === routeId) ||
    (!routeId && item?.routeTitle === routeTitle);
  // 按 routeId/routeTitle 谓词精确反扫（匹配窗口 5000 行），替代全局尾窗 + filter：
  // 旧路径下热门路线会把冷路线的历史反馈挤出统计窗口。传入共享上下文时改为
  // 对同一份内存行数组过滤，谓词与窗口口径不变。
  const [matchedCheckins, globalEligibleCheckins, corrections, matchedReviews, matchedHistory, matchedExposures] = feedbackContext
    ? [
        collectMatchingRows(feedbackContext.checkins, matchesRouteCheckin, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.checkins, globalEligiblePredicate, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.corrections, correctionPredicate, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.reviews, reviewPredicate, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.routebookHistory, historyPredicate, FEEDBACK_SCAN_MATCH_LIMIT),
        collectMatchingRows(feedbackContext.exposures, exposurePredicate, FEEDBACK_SCAN_MATCH_LIMIT)
      ]
    : await Promise.all([
        readMatchingJsonLines(CHECKIN_LOG_PATH, matchesRouteCheckin, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW),
        readMatchingJsonLines(CHECKIN_LOG_PATH, globalEligiblePredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW),
        readMatchingJsonLines(POI_CORRECTION_LOG_PATH, correctionPredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW),
        readMatchingJsonLines(REVIEW_LOG_PATH, reviewPredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW),
        readMatchingJsonLines(ROUTEBOOK_LOG_PATH, historyPredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW),
        readMatchingJsonLines(EXPOSURE_LOG_PATH, exposurePredicate, FEEDBACK_SCAN_MATCH_LIMIT, FEEDBACK_SCAN_WINDOW)
      ]);
  const trustedRouteStops = [
    ...(routebook?.stops ?? []),
    ...(routebook?.variants ?? []).flatMap((variant) => variant?.stops ?? [])
  ];
  const profileAttestedCheckins = matchedCheckins.filter((item) =>
    isPublicTrustEligibleCheckin(item) &&
    trustedRouteStops.some((stop) => isSameCheckinStop(stop, item))
  );
  const attestedCheckins = latestTrustedCheckinsByProfileAndStop(profileAttestedCheckins);
  const eligibleTrustCheckins = latestTrustedCheckinsByProfileAndStop(
    profileAttestedCheckins.filter(isEligibleTrustCheckin)
  );
  const globalPoiCheckins = latestTrustedCheckinsByProfileAndPoi(globalEligibleCheckins);
  const verifiedArrivalCheckins = eligibleTrustCheckins;
  const verifiedProfileCount = new Set(verifiedArrivalCheckins.map((item) => normalizeProfileId(item.profileId)).filter((id) => id && id !== 'anonymous')).size;
  const attestedProfileCount = new Set(
    verifiedArrivalCheckins
      .filter((item) => item.trustState === 'profile-attested')
      .map((item) => normalizeProfileId(item.profileId))
      .filter((id) => id && id !== 'anonymous')
  ).size;
  const matchedCorrections = corrections;
  const shareExposureCount = matchedExposures.filter((item) => item.itemType === 'routebook' || item.surface === 'public-share').length;
  const editCount = matchedHistory.filter((item) => item.provider?.editedAt || item.activeVariantId).length;
  const latestVerifiedAt = verifiedArrivalCheckins
    .map((item) => item.createdAt ?? item.time)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const validArrivalCount = verifiedArrivalCheckins.length;
	  const lowConfidenceArrivalCount = attestedCheckins.filter((item) => ['weak', 'invalid'].includes(item.arrival?.confidence)).length;
	  const uniqueVisitedStops = new Set(eligibleTrustCheckins
	    .map(checkinStopKey)
	    .filter(Boolean));
	  // rank27：与 uniqueVisitedStops 完全同口径，复用同一个 Set 不再重复计算。
	  const feedbackStopCount = uniqueVisitedStops.size;
	  const pitfallCount = eligibleTrustCheckins.filter((item) => item.worth === '踩坑' || item.pitfall).length;
	  const positiveCount = eligibleTrustCheckins.filter((item) => item.worth === '值得').length;
	  // skip/replaced 计数不能基于 eligibleTrustCheckins（其要求 status==='visited'，
	  // 结构上恒为 0）；改按 profile+stop 最新态（attestedCheckins）统计终态。
	  const skipCount = attestedCheckins.filter((item) => item?.status === 'skipped').length;
	  const replacedCount = attestedCheckins.filter((item) => item?.status === 'replaced').length;
	  const completeFeedbackCount = eligibleTrustCheckins.filter((item) =>
	    item.worth && item.queue && item.cost && item.crowd && (item.comment || item.pitfall || item.arrival?.valid)
	  ).length;
  const routeStopCount = Array.isArray(routebook?.stops) ? routebook.stops.length : 0;
  // 完成率改为按 profile 个体完成率取平均：跨用户站点并集会把 3 个各走 1 站的
  // 用户算成 3/N 的「共同完成」，高估执行率。原并集口径保留为 coverageRate。
  const visitedStopsByProfile = new Map();
  for (const item of eligibleTrustCheckins) {
    const itemProfileId = normalizeProfileId(item?.profileId);
    const stopKey = checkinStopKey(item);
    if (!itemProfileId || itemProfileId === 'anonymous' || !stopKey) continue;
    const visited = visitedStopsByProfile.get(itemProfileId) ?? new Set();
    visited.add(stopKey);
    visitedStopsByProfile.set(itemProfileId, visited);
  }
  const perProfileCompletion = [...visitedStopsByProfile.values()]
    .map((visited) => (routeStopCount ? Math.min(1, visited.size / routeStopCount) : 0));
  const completionRate = routeStopCount && perProfileCompletion.length
    ? Math.min(100, Math.round((perProfileCompletion.reduce((sum, ratio) => sum + ratio, 0) / perProfileCompletion.length) * 100))
    : 0;
  const coverageRate = routeStopCount
    ? Math.min(100, Math.round((uniqueVisitedStops.size / routeStopCount) * 100))
    : 0;
	  const pitfallRate = eligibleTrustCheckins.length ? Math.round((pitfallCount / eligibleTrustCheckins.length) * 1000) / 10 : 0;
	  const positiveRate = eligibleTrustCheckins.length ? Math.round((positiveCount / eligibleTrustCheckins.length) * 1000) / 10 : 0;
  // 跳过率通道：按 profile + 出行日（本函数已按路线过滤）分组成「行程」，行程内
  // 有 isEligibleTrustCheckin 的有效到达锚定才计入；统计该行程内最终状态为
  // skipped/replaced 的站点占比后取行程平均。跳过打卡本身不要求 GPS。
  const journeyStops = new Map();
  for (const item of profileAttestedCheckins) {
    const itemProfileId = normalizeProfileId(item?.profileId);
    const stopKey = checkinStopKey(item);
    if (!itemProfileId || itemProfileId === 'anonymous' || !stopKey) continue;
    const journeyDay = localDateForTimestamp(checkinEventTime(item)) || 'unknown-day';
    const journeyId = `${itemProfileId}::${journeyDay}`;
    const stopsInJourney = journeyStops.get(journeyId) ?? new Map();
    // 行按最新在前排序，同一站点保留最终状态（跳过后又实地到达按到达计）。
    if (!stopsInJourney.has(stopKey)) stopsInJourney.set(stopKey, item);
    journeyStops.set(journeyId, stopsInJourney);
  }
  const anchoredJourneySkipShares = [];
  for (const stopsInJourney of journeyStops.values()) {
    const journeyRows = [...stopsInJourney.values()];
    if (!journeyRows.some(isEligibleTrustCheckin)) continue;
    const skippedOrReplaced = journeyRows.filter((item) => item?.status === 'skipped' || item?.status === 'replaced').length;
    anchoredJourneySkipShares.push(journeyRows.length ? skippedOrReplaced / journeyRows.length : 0);
  }
  const skipRate = anchoredJourneySkipShares.length
    ? Math.round((anchoredJourneySkipShares.reduce((sum, share) => sum + share, 0) / anchoredJourneySkipShares.length) * 1000) / 10
    : 0;
	  const completeFeedbackRate = eligibleTrustCheckins.length ? Math.round((completeFeedbackCount / eligibleTrustCheckins.length) * 1000) / 10 : 0;
  const editRate = matchedHistory.length > 1 ? Math.round((editCount / Math.max(1, matchedHistory.length - 1)) * 1000) / 10 : 0;
  const copyCount = routebookCopyCount(matchedExposures, routeId);
  const copyConversionRate = shareExposureCount ? Math.round((copyCount / shareExposureCount) * 1000) / 10 : 0;
  const editPenalty = editRate > 60 && validArrivalCount < 2 ? 2 : editRate > 30 && validArrivalCount < 1 ? 1 : 0;
  // rank20②：已审核纠错进入路线级扣分与 POI 级降权（营业时间/关闭类）。
  const approvedCorrections = matchedCorrections.filter((item) => String(item?.status ?? '') === 'approved');
  const approvedCorrectionCount = approvedCorrections.length;
  const approvedHourCorrections = approvedCorrections.filter(isHoursOrClosureCorrection);
  // rank20③：用打卡时间与站点计划时间/停留时长比对，得到粗粒度时间吻合率。
  const timeMatchRate = calculateTimeMatchRate(trustedRouteStops, eligibleTrustCheckins);
  const feedbackScore = calculateFeedbackTrustScore({
    completionRate,
    positiveRate,
    editRate,
    completeFeedbackRate,
    skipRate,
    pitfallRate,
    lowConfidenceArrivalCount,
    approvedCorrectionCount,
    sampleCount: verifiedArrivalCheckins.length
	  });
  const aiPredictionScore = clampNumber(routebook?.trustScore, 45, 96, calculateRouteTrustScore(routebook?.stops ?? []));
  const trustBlend = blendRouteTrustScore(aiPredictionScore, feedbackScore, verifiedProfileCount);
  const poiTrust = buildPoiTrustByStop(routebook, globalPoiCheckins, approvedHourCorrections);
  return {
	    checkinCount: matchedCheckins.length,
	    attestedCheckinCount: eligibleTrustCheckins.length,
	    ordinaryAttestedFeedbackCount: Math.max(0, attestedCheckins.length - eligibleTrustCheckins.length),
	    untrustedCheckinCount: matchedCheckins.length - profileAttestedCheckins.length,
    visitedStopCount: uniqueVisitedStops.size,
    feedbackStopCount,
    completionRate,
    coverageRate,
    editCount,
    editRate,
    pitfallCount,
    pitfallRate,
    positiveCount,
    positiveRate,
    skipCount,
    skipRate,
    replacedCount,
    completeFeedbackCount,
    completeFeedbackRate,
    correctionCount: matchedCorrections.length,
    approvedCorrectionCount,
    ...(timeMatchRate == null ? {} : { timeMatchRate }),
    reviewCount: matchedReviews.length,
    saveVersionCount: matchedHistory.length || 1,
    shareExposureCount,
    copyCount,
    copyConversionRate,
    validArrivalCount,
    sampleCount: verifiedProfileCount,
    verifiedArrivalSampleCount: verifiedArrivalCheckins.length,
    verifiedProfileCount,
    attestedProfileCount,
    lowConfidenceArrivalCount,
	    latestFeedbackAt: latestVerifiedAt,
    feedbackScore,
    aiPredictionScore,
    blendedTrustScore: trustBlend.score,
    aiWeight: trustBlend.aiWeight,
    feedbackWeight: trustBlend.feedbackWeight,
    trustScoreSource: trustBlend.source,
    trustCoverage: trustBlend.coverage,
    displayTrustScore: trustBlend.displayScore,
    poiTrust,
	    trustDelta: Math.max(-12, Math.min(12, Math.round((completionRate - pitfallRate) / 12) + Math.min(4, validArrivalCount) - editPenalty))
  };
}

async function enrichRoutebook(routebook, feedbackContext = null) {
  if (!routebook) return null;
  const [feedbackSummary, poiKnowledge] = await Promise.all([
    buildFeedbackSummary(routebook, feedbackContext),
    listPoiKnowledge({ city: routebook.city, limit: 500 })
  ]);
  const stops = enrichStopsWithEvidence(routebook, routebook.stops ?? [], poiKnowledge, feedbackSummary);
  const variants = (routebook.variants ?? []).map((variant) => ({
    ...variant,
    stops: enrichStopsWithEvidence(routebook, variant.stops ?? [], poiKnowledge, feedbackSummary)
  }));
  const dynamicTrustScore = feedbackSummary.blendedTrustScore ?? routebook.trustScore ?? 78;
  return {
    ...routebook,
    stops,
    variants,
    copyCount: feedbackSummary.copyCount,
    trustScore: dynamicTrustScore,
    trustMeta: {
      predictionScore: feedbackSummary.aiPredictionScore,
      feedbackScore: feedbackSummary.feedbackScore,
      score: dynamicTrustScore,
      displayScore: feedbackSummary.displayTrustScore,
      source: feedbackSummary.trustScoreSource,
      label: trustProgressLabel(feedbackSummary),
      sampleTarget: PUBLIC_TRUST_SAMPLE_THRESHOLD,
      sampleCount: feedbackSummary.verifiedProfileCount,
      aiWeight: feedbackSummary.aiWeight,
      feedbackWeight: feedbackSummary.feedbackWeight,
      coverage: feedbackSummary.trustCoverage,
      latestVerifiedAt: feedbackSummary.latestFeedbackAt
    },
    feedbackSummary,
    metrics: mergeFeedbackMetrics(routebook.metrics ?? [], feedbackSummary)
  };
}

function calculateFeedbackTrustScore(summary) {
  const completion = clampNumber(summary.completionRate, 0, 100, 0);
  const satisfaction = clampNumber(summary.positiveRate, 0, 100, 50);
  const lowEdit = 100 - clampNumber(summary.editRate, 0, 100, 0);
  const completeFeedback = clampNumber(summary.completeFeedbackRate, 0, 100, 0);
  const lowSkip = 100 - clampNumber(summary.skipRate, 0, 100, 0);
  const lowPitfall = 100 - clampNumber(summary.pitfallRate, 0, 100, 0);
  const confidenceBonus = Math.min(8, Math.floor(clampNumber(summary.sampleCount, 0, 1000, 0) / 3) * 2);
  const lowConfidencePenalty = Math.min(10, clampNumber(summary.lowConfidenceArrivalCount, 0, 100, 0) * 2);
  // rank20②：路线被审核通过的纠错越多，说明既有事实越不可靠，小幅扣分（上限 6）。
  const correctionPenalty = Math.min(6, clampNumber(summary.approvedCorrectionCount, 0, 1000, 0) * 2);
  return Math.round(clampNumber(
    completion * 0.32 +
      satisfaction * 0.22 +
      lowEdit * 0.14 +
      completeFeedback * 0.14 +
      lowSkip * 0.08 +
      lowPitfall * 0.10 +
      confidenceBonus -
      lowConfidencePenalty -
      correctionPenalty,
    35,
    98,
    60
  ));
}

// rank20②：营业时间/关闭类字段的已审核纠错，用于 POI 降权标记。
function isHoursOrClosureCorrection(correction) {
  const field = String(correction?.field ?? '');
  return /营业|开放|闭馆|闭园|闭店|关闭|停业|歇业|休息|暂停/.test(field);
}

const TIME_OF_DAY_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: TRAVEL_DAY_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function minutesOfDayInTravelTimezone(value) {
  const timestamp = Date.parse(value ?? '');
  if (!Number.isFinite(timestamp)) return null;
  const match = TIME_OF_DAY_FORMATTER.format(new Date(timestamp)).match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseStayMinutes(value) {
  const text = String(value ?? '');
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:小时|h)/i);
  const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min)/i);
  if (!hourMatch && !minuteMatch) return null;
  return Math.round((hourMatch ? Number(hourMatch[1]) * 60 : 0) + (minuteMatch ? Number(minuteMatch[1]) : 0));
}

function stopPlannedTimeWindow(stop) {
  const timeMatch = String(stop?.time ?? '').match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;
  const start = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
  if (!Number.isFinite(start) || start >= 24 * 60) return null;
  const stay = parseStayMinutes(stop?.stay) ?? 60;
  return { start, end: start + Math.max(0, Math.min(12 * 60, stay)) };
}

// rank20③：粗粒度时间吻合率——打卡时刻（Asia/Shanghai）落在
// [计划到达-60min, 计划离开+60min] 记为吻合；无可比样本时返回 null。
function calculateTimeMatchRate(routeStops, checkins) {
  const samples = [];
  for (const item of checkins ?? []) {
    const checkinMinutes = minutesOfDayInTravelTimezone(checkinEventTime(item));
    if (checkinMinutes == null) continue;
    const stop = (routeStops ?? []).find((routeStop) => isSameCheckinStop(routeStop, item));
    const window = stopPlannedTimeWindow(stop);
    if (!window) continue;
    samples.push(checkinMinutes >= window.start - 60 && checkinMinutes <= window.end + 60);
  }
  if (!samples.length) return null;
  return Math.round((samples.filter(Boolean).length / samples.length) * 100);
}

function parseQueueMinutes(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/无需|不用|免排|没排|无排队|不排队/.test(text)) return 0;
  return parseStayMinutes(text);
}

function parseCostYuan(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/免费|免票/.test(text)) return 0;
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function medianOf(values) {
  const sorted = (values ?? []).filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(median * 10) / 10;
}

function modeOf(values) {
  const counts = new Map();
  for (const value of values ?? []) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  let winner = '';
  let winnerCount = 0;
  for (const [value, count] of counts) {
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
    }
  }
  return winner;
}

// "待真实验证" reads as broken to users and hides progress from ops; show how far the
// route is from the sample threshold instead.
function trustProgressLabel(feedbackSummary) {
  if (feedbackSummary.trustScoreSource === 'verified-feedback') {
    const attested = clampNumber(feedbackSummary.attestedProfileCount, 0, 1000000, 0);
    return attested ? '真实打卡验证可信分' : '独立身份打卡验证可信分';
  }
  const samples = clampNumber(feedbackSummary.verifiedProfileCount, 0, 1000000, 0);
  return samples
    ? `预测可信度 · 已收集 ${samples}/${PUBLIC_TRUST_SAMPLE_THRESHOLD} 份真实验证`
    : '预测可信度 · 待首份真实打卡';
}

function blendRouteTrustScore(aiPredictionScore, feedbackScore, sampleCount) {
  const samples = clampNumber(sampleCount, 0, 100000, 0);
  const coverage = Math.min(1, samples / Math.max(1, TRUST_FEEDBACK_SAMPLE_TARGET));
  const feedbackWeight = Math.round((coverage * 0.75) * 100) / 100;
  const aiWeight = Math.round((1 - feedbackWeight) * 100) / 100;
  const score = Math.round(clampNumber(aiPredictionScore * aiWeight + feedbackScore * feedbackWeight, 40, 98, aiPredictionScore));
  return {
    score,
    displayScore: samples >= PUBLIC_TRUST_SAMPLE_THRESHOLD ? score : null,
    aiWeight,
    feedbackWeight,
    coverage: Math.round(coverage * 100),
    source: samples >= PUBLIC_TRUST_SAMPLE_THRESHOLD ? 'verified-feedback' : 'prediction'
  };
}

function buildPoiTrustByStop(routebook, attestedCheckins = [], approvedHourCorrections = []) {
  // 键改用 resolvePoiId：stop.id（如 stop-1）会在主线与变体之间撞库，把别的
  // POI 的可信分挂错；同时覆盖变体站点，让变体也能继承跨路线 POI 反馈。
  const stops = [
    ...(routebook?.stops ?? []),
    ...(routebook?.variants ?? []).flatMap((variant) => variant?.stops ?? [])
  ];
  const sinceMs = Date.now() - POI_FEEDBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentRows = attestedCheckins.filter((item) => {
    const time = Date.parse(item.createdAt ?? item.time ?? '');
    return Number.isFinite(time) && time >= sinceMs;
  });
  const recentHourCorrections = (approvedHourCorrections ?? []).filter((item) => {
    const time = Date.parse(item?.reviewedAt ?? item?.createdAt ?? '');
    return Number.isFinite(time) && time >= sinceMs;
  });
  const map = new Map();
  for (const stop of stops) {
    const stopPoiId = resolvePoiId(stop, routebook?.city);
    if (!stopPoiId || map.has(stopPoiId)) continue;
    const rows = recentRows.filter((item) => poiCheckinKey(item) === stopPoiId && isEligibleTrustCheckin(item));
    const independentProfileCount = new Set(
      rows.map((item) => normalizeProfileId(item.profileId)).filter((id) => id && id !== 'anonymous')
    ).size;
    const validRows = rows;
    const positiveRows = validRows.filter((item) => item.worth === '值得');
    const pitfallRows = validRows.filter((item) => item.worth === '踩坑' || item.pitfall);
    const skippedRows = validRows.filter((item) => item.worth === '跳过');
    const latestVerifiedAt = validRows.map((item) => item.createdAt ?? item.time).filter(Boolean).sort().at(-1) ?? null;
    const freshnessDays = latestVerifiedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(latestVerifiedAt)) / (24 * 60 * 60 * 1000)))
      : null;
    const positiveRate = validRows.length ? Math.round((positiveRows.length / validRows.length) * 1000) / 10 : 0;
    const pitfallRate = validRows.length ? Math.round((pitfallRows.length / validRows.length) * 1000) / 10 : 0;
    const skipRate = validRows.length ? Math.round((skippedRows.length / validRows.length) * 1000) / 10 : 0;
    const freshnessScore = latestVerifiedAt ? Math.max(0, 100 - Math.floor((Date.now() - Date.parse(latestVerifiedAt)) / (24 * 60 * 60 * 1000)) * 3) : 0;
    // rank20②：近 30 天营业时间/关闭类已审核纠错对该 POI 施加降权（每条 -4，上限 -12）。
    const recentCorrectionCount = recentHourCorrections
      .filter((item) => isSamePoi({ ...stop, city: routebook?.city }, item)).length;
    const correctionPenalty = Math.min(12, recentCorrectionCount * 4);
    const score = independentProfileCount ? Math.round(clampNumber(
      42 +
        Math.min(24, independentProfileCount * 4) +
        positiveRate * 0.14 +
        freshnessScore * 0.12 -
        pitfallRate * 0.22 -
        skipRate * 0.12 -
        correctionPenalty,
      30,
      96,
      50
    )) : null;
    // rank20①：近 30 天有效样本的经验聚合（人群/排队/花费/拥挤/最新反馈时间）。
    const audienceCounts = new Map();
    for (const item of validRows) {
      const label = truncateString(item?.audience, 80);
      if (label) audienceCounts.set(label, (audienceCounts.get(label) ?? 0) + 1);
    }
    const audienceTotal = [...audienceCounts.values()].reduce((sum, count) => sum + count, 0);
    const audienceBreakdown = audienceTotal >= 2
      ? [...audienceCounts.entries()]
          .map(([label, count]) => ({ label, count, share: Math.round((count / audienceTotal) * 100) }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 6)
      : [];
    const queueMinutesMedian = medianOf(validRows.map((item) => parseQueueMinutes(item?.queue)));
    const costMedian = medianOf(validRows.map((item) => parseCostYuan(item?.cost)));
    const crowdLevel = modeOf(validRows.map((item) => item?.crowd));
    map.set(stopPoiId, {
      score,
      scope: 'cross-route-poi',
      sampleCount: independentProfileCount,
      recentCheckins: validRows.length,
      validArrivals: validRows.length,
      positiveRate,
      pitfallRate,
      skipRate,
      audienceBreakdown,
      queueMinutesMedian,
      costMedian,
      crowdLevel,
      latestVerifiedAt,
      latestFeedbackAt: latestVerifiedAt,
      freshnessDays,
      recentCorrectionCount,
      trustState: independentProfileCount >= PUBLIC_TRUST_SAMPLE_THRESHOLD ? 'verified' : independentProfileCount > 0 ? 'collecting' : 'pending',
      freshnessLabel: latestVerifiedAt ? `${daysAgoLabel(latestVerifiedAt)}有人验证` : '待真实验证',
      label: independentProfileCount ? `近 ${POI_FEEDBACK_WINDOW_DAYS} 天 ${independentProfileCount} 位独立身份跨路线有效到达` : '待真实打卡'
    });
  }
  return Object.fromEntries(map);
}

function stopTrustKey(stop) {
  return String(stop?.id || stop?.name || '').trim();
}

function isSameCheckinStop(stop, checkin) {
  const stopPoiId = sanitizePublicId(stop?.poiId);
  const checkinPoiId = sanitizePublicId(checkin?.poiId);
  const stopId = String(stop?.id ?? '');
  const localStopKey = String(checkin?.localStopKey ?? '');
  const checkinStopId = String(checkin?.stopId ?? '');
  const stopName = String(stop?.name ?? '');
  const checkinStopName = String(checkin?.stopName ?? '');
  return Boolean(
    (stopPoiId && checkinPoiId && stopPoiId === checkinPoiId) ||
    (stopId && localStopKey && stopId === localStopKey) ||
    (stopId && checkinStopId && stopId === checkinStopId) ||
    (stopName && checkinStopName && normalizePoiName(stopName) === normalizePoiName(checkinStopName)) ||
    resolvePoiId(stop, checkin?.city) === resolvePoiId(checkin, checkin?.city)
  );
}

function daysAgoLabel(isoValue) {
  const timestamp = Date.parse(isoValue ?? '');
  if (!Number.isFinite(timestamp)) return '近期';
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000)));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

function enrichStopsWithEvidence(routebook, stops, poiKnowledge, feedbackSummary = null) {
  return stops.map((stop) => {
    const corrections = poiKnowledge
      .filter((item) => isSamePoi(stop, item))
      .slice(0, 5);
    // 新口径按 resolvePoiId 取 POI 可信分；stopTrustKey 仅作为读取历史
    // 已落盘 feedbackSummary（旧键）的兼容回退。
    const poiKey = resolvePoiId(stop, routebook?.city);
    const legacyKey = stopTrustKey(stop);
    const poiTrust = feedbackSummary?.poiTrust?.[poiKey] ??
      feedbackSummary?.poiTrust?.[legacyKey] ??
      routebook?.feedbackSummary?.poiTrust?.[poiKey] ??
      routebook?.feedbackSummary?.poiTrust?.[legacyKey] ??
      routebook?.poiTrust?.[poiKey] ??
      routebook?.poiTrust?.[legacyKey] ??
      null;
    const evidence = normalizeStopEvidence([
      ...(stop.sourceEvidence ?? []),
      ...buildSourceEvidenceForStop(routebook, stop),
      ...corrections.map((item) => ({
        id: item.correctionId || item.id,
        type: 'approved-correction',
        label: `已审核纠错｜${item.field}`,
        detail: [item.value, item.reason ? `依据：${item.reason}` : '', item.reviewerNote ? `审核：${item.reviewerNote}` : ''].filter(Boolean).join('；'),
        trustScore: null,
        checkedAt: item.createdAt
      }))
    ]);
    return {
      ...stop,
      poiTrust,
      approvedCorrections: corrections,
      sourceEvidence: evidence,
      facts: buildStopFacts(routebook, stop, corrections, evidence)
    };
  });
}

function buildStopFacts(routebook, stop, corrections, evidence) {
  const sourceFacts = buildFactsFromSources(routebook, stop, evidence);
  const correctionFacts = corrections.map((item) => ({
    id: `correction-${item.correctionId || item.id}`,
    field: item.field || '综合信息',
    value: item.value,
    confidence: 88,
    sourceLabel: '运营已审纠错',
    sourceType: 'approved-correction',
    sourceUrl: '',
    status: '已审核',
    checkedAt: item.createdAt
  }));
  const fallbackFacts = [
    { id: 'fact-stay', field: '建议停留', value: stop.stay, confidence: 66, sourceLabel: 'AI 路线校验', sourceType: 'routebook', status: '需实地校准' },
    { id: 'fact-cost', field: '费用', value: stop.cost, confidence: /\d/.test(String(stop.cost ?? '')) ? 64 : 45, sourceLabel: 'AI 预算估算', sourceType: 'routebook', status: '需出发前复核' },
    { id: 'fact-risk', field: '风险', value: stop.risk, confidence: 68, sourceLabel: 'AI 风险摘要', sourceType: 'routebook', status: '需复核' }
  ];
  const merged = [...normalizeStopFacts(stop.facts), ...correctionFacts, ...sourceFacts, ...fallbackFacts];
  const latestByField = new Map();
  for (const fact of normalizeStopFacts(merged)) {
    const key = `${fact.field}:${fact.value}`;
    if (!latestByField.has(key)) latestByField.set(key, fact);
  }
  return [...latestByField.values()].slice(0, 8);
}

function buildFactsFromSources(routebook, stop, evidence = []) {
  const stopName = String(stop?.name ?? '');
  const relevant = evidence.filter((item) => item.type === 'matched-source' || String(item.detail ?? '').includes(stopName));
  return relevant.slice(0, 3).flatMap((item) => {
    const facts = [];
    const text = `${item.label ?? ''} ${item.detail ?? ''}`;
    if (/开放|营业|闭店|暂停|预约|限流/.test(text)) {
      facts.push({ field: '开放时间', value: item.detail, status: '来源提示' });
    }
    if (/票|门票|元|人均|价格|涨价/.test(text)) {
      facts.push({ field: '费用', value: item.detail, status: '来源提示' });
    }
    if (/排队|拥挤|人多|避开|高峰/.test(text)) {
      facts.push({ field: '拥挤风险', value: item.detail, status: '来源提示' });
    }
    if (!facts.length && item.detail) {
      facts.push({ field: '来源摘要', value: item.detail, status: '来源提示' });
    }
    return facts.map((fact, index) => ({
      id: `source-fact-${sanitizePublicId(item.id)}-${index + 1}`,
      ...fact,
      confidence: item.trustScore == null ? 58 : clampNumber(item.trustScore, 0, 100, 58),
      sourceLabel: item.label,
      sourceType: item.type,
      sourceUrl: item.url,
      checkedAt: item.checkedAt
    }));
  });
}

async function findStopForCheckin(body) {
  const routeId = sanitizePublicId(body?.routeId || body?.publicId);
  const routeTitle = truncateString(body?.routeTitle, 100);
  const city = body?.city ? normalizeCityName(body.city) : '';
  let routebook = routeId ? await getResolvableRoutebook(routeId) : null;
  if (!routebook) {
    const routebooks = await listSavedRoutebooks(500);
    routebook = routebooks.find((item) => {
      const titleMatched = !routeTitle || item.title === routeTitle;
      const cityMatched = !city || item.city === city;
      return titleMatched && cityMatched;
    }) ?? null;
  }
  const target = body?.target && typeof body.target === 'object' ? body.target : null;
  const fallbackTarget = isValidCoordinate(Number(target?.lat), Number(target?.lng))
    ? {
        id: truncateString(body?.stopId, 80),
        localStopKey: truncateString(body?.localStopKey || body?.stopId, 120),
        poiId: resolvePoiId({ name: body?.stopName }, city),
        name: truncateString(body?.stopName, 80),
        lat: Number(target.lat),
        lng: Number(target.lng)
      }
    : null;
  if (!routebook?.stops?.length) return fallbackTarget;
  const resolvedStop = (stop) => ({
    ...stop,
    city: routebook.city,
    serverResolved: true
  });
  const stopId = String(body?.stopId ?? '');
  const stopName = String(body?.stopName ?? '');
  const routeStops = [
    ...(routebook.stops ?? []),
    ...(routebook.variants ?? []).flatMap((variant) => variant?.stops ?? [])
  ];
  const byId = routeStops.find((stop) => stopId && String(stop.id) === stopId);
  if (byId) return resolvedStop(byId);
  const normalizedName = normalizePoiName(stopName);
  const byName = routeStops.find((stop) => normalizedName && normalizePoiName(stop.name) === normalizedName);
  if (byName) return resolvedStop(byName);
  const requestedPoiId = resolvePoiId({ name: stopName }, city || routebook.city);
  const byPoiId = routeStops.find((stop) => resolvePoiId(stop, routebook.city) === requestedPoiId);
  return byPoiId ? resolvedStop(byPoiId) : fallbackTarget;
}

function buildArrivalEvidence(body, targetStop) {
  const gps = body?.gps && typeof body.gps === 'object' ? {
    lat: clampNumber(body.gps.lat, -90, 90, 0),
    lng: clampNumber(body.gps.lng, -180, 180, 0),
    accuracy: clampNumber(body.gps.accuracy, 0, 10000, 0)
  } : null;
  if (!gps || !isValidCoordinate(gps.lat, gps.lng)) {
    return {
      valid: false,
      confidence: 'unverified',
      label: '未定位',
      detail: '未提供有效 GPS，只能作为普通体验反馈，暂不计入有效到达。',
      distanceMeters: null,
      accuracy: gps?.accuracy ?? null,
      thresholdMeters: null
    };
  }
  if (!targetStop || !isValidCoordinate(Number(targetStop.lat), Number(targetStop.lng))) {
    return {
      valid: false,
      confidence: 'unverified',
      label: '缺少目标坐标',
      detail: '已记录 GPS，但未找到可比对的路书站点坐标。',
      distanceMeters: null,
      accuracy: gps.accuracy,
      thresholdMeters: null
    };
  }
  if (!hasPreciseCoordinate(targetStop)) {
    return {
      valid: false,
      confidence: 'unverified',
      label: '目标定位待复核',
      detail: '该站点不是高置信坐标，只记录体验反馈，暂不计入有效到达。',
      distanceMeters: null,
      accuracy: gps.accuracy,
      thresholdMeters: null,
      targetStopId: truncateString(targetStop.id, 80),
      targetStopName: truncateString(targetStop.name, 80)
    };
  }
  const reportedDistance = distanceMeters(gps, targetStop);
  // rank18②：国内浏览器可能返回 GCJ02 坐标。当按 WGS84 直算的距离落在
  // 250-800m 灰区且客户端未声明 wgs84 时，把上报坐标视作 GCJ02 纠偏后重算，
  // 取更小者作为判定距离；纠偏后仍超阈值则维持原判定。
  const coordinateSystem = normalizeCheckinCoordinateSystem(body?.gps?.coordinateSystem);
  let distance = reportedDistance;
  let correctedDistance = null;
  let usedCoordinateCorrection = false;
  if (coordinateSystem !== 'wgs84' &&
    Number.isFinite(reportedDistance) &&
    reportedDistance >= CHECKIN_GCJ_CORRECTION_MIN_METERS &&
    reportedDistance <= CHECKIN_GCJ_CORRECTION_MAX_METERS) {
    const corrected = gcj02ToWgs84(gps.lat, gps.lng);
    correctedDistance = distanceMeters(corrected, targetStop);
    if (Number.isFinite(correctedDistance) && correctedDistance < reportedDistance) {
      distance = correctedDistance;
      usedCoordinateCorrection = true;
    }
  }
  // accuracy is self-reported, so it can only widen the radius up to a plausible GPS
  // error. A wildly large value now reads as a bad fix instead of buying 900m of slack.
  const reportedAccuracy = gps.accuracy || 0;
  const threshold = Math.max(250, Math.round(Math.min(reportedAccuracy, CHECKIN_TRUSTED_ACCURACY_METERS) + 180));
  const accuracyImplausible = reportedAccuracy > CHECKIN_MAX_REPORTED_ACCURACY_METERS;
  const distanceConfidence = distance <= threshold
    ? 'valid'
    : distance <= Math.max(1000, threshold * 2)
      ? 'weak'
      : 'invalid';
  const confidence = accuracyImplausible && distanceConfidence === 'valid' ? 'weak' : distanceConfidence;
  return {
    valid: confidence === 'valid',
    confidence,
    label: confidence === 'valid' ? '有效到达' : confidence === 'weak' ? '弱定位' : '疑似偏离',
    detail: confidence === 'valid'
      ? `GPS 距目标约 ${distance}m，已计入有效到达。${usedCoordinateCorrection ? '（已按 GCJ02 纠偏取更近距离）' : ''}`
      : accuracyImplausible
        ? `GPS 距目标约 ${distance}m，但上报定位误差 ${Math.round(reportedAccuracy)}m 过大，不计入高置信到达。`
        : confidence === 'weak'
          ? `GPS 距目标约 ${distance}m，位置接近但不计入高置信到达。`
          : `GPS 距目标约 ${distance}m，偏离过大，不计入完成率。`,
    distanceMeters: distance,
    ...(usedCoordinateCorrection
      ? {
          usedCoordinateCorrection: true,
          reportedDistanceMeters: reportedDistance,
          correctedDistanceMeters: correctedDistance
        }
      : {}),
    accuracy: gps.accuracy,
    thresholdMeters: threshold,
    targetStopId: truncateString(targetStop.id, 80),
    targetStopName: truncateString(targetStop.name, 80)
  };
}

// rank18①：打卡坐标系白名单（unknown/wgs84/gcj02），未知一律记 unknown。
function normalizeCheckinCoordinateSystem(value) {
  const system = String(value ?? '').trim().toLowerCase();
  return CHECKIN_COORDINATE_SYSTEMS.has(system) ? system : 'unknown';
}

// With the identity gate relaxed, an implausible jump between consecutive check-ins is
// the main remaining signal that a profile is fabricating arrivals. Downgrade instead of
// rejecting: a legitimate traveller with a bad fix should still keep their feedback.
function applyTravelPlausibility(arrival, gps, previousCheckin) {
  if (!arrival?.valid || !gps || !previousCheckin?.gps) return arrival;
  const previousAt = Date.parse(previousCheckin.createdAt ?? previousCheckin.time ?? '');
  if (!Number.isFinite(previousAt)) return arrival;
  const elapsedHours = (Date.now() - previousAt) / 3600000;
  if (elapsedHours <= 0 || elapsedHours > CHECKIN_PLAUSIBILITY_WINDOW_HOURS) return arrival;
  const jumpMeters = distanceMeters(gps, previousCheckin.gps);
  if (!Number.isFinite(jumpMeters)) return arrival;
  const impliedKmh = jumpMeters / 1000 / elapsedHours;
  if (impliedKmh <= CHECKIN_MAX_PLAUSIBLE_KMH) return arrival;
  return {
    ...arrival,
    valid: false,
    confidence: 'weak',
    label: '移动速度异常',
    detail: `距上一次打卡 ${Math.round(jumpMeters / 1000)}km、间隔 ${elapsedHours.toFixed(1)} 小时，隐含时速约 ${Math.round(impliedKmh)}km/h，暂不计入有效到达。`,
    fraudSignal: 'implausible-speed',
    impliedKmh: Math.round(impliedKmh)
  };
}

async function buildProductAnalytics(limit = 500, profileId = '') {
  const clicks = await readJsonLines(CLICK_LOG_PATH, Math.max(limit, 50));
  const exposures = await readJsonLines(EXPOSURE_LOG_PATH, Math.max(limit * 2, 100));
  const scopedClicks = profileId ? clicks.filter((click) => normalizeProfileId(click.profileId) === profileId) : clicks;
  const scopedExposures = profileId ? exposures.filter((item) => normalizeProfileId(item.profileId) === profileId) : exposures;
  const productExposures = scopedExposures.filter((item) => item.itemType === 'product' || item.productId);
  const aggregate = (keyFn, labelFn) => {
    const map = new Map();
    for (const click of scopedClicks) {
      const key = keyFn(click);
      if (!key) continue;
      const item = map.get(key) ?? { key, label: labelFn(click), count: 0 };
      item.count += 1;
      item.lastClickedAt = maxIso(item.lastClickedAt, click.createdAt);
      map.set(key, item);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || String(b.lastClickedAt ?? '').localeCompare(String(a.lastClickedAt ?? ''))).slice(0, 12);
  };
  const exposureByProduct = countBy(productExposures, (item) => item.productId || item.itemId);
  const clickByProduct = countBy(scopedClicks, (item) => item.productId || item.productTitle);
  const ctrByProduct = [...exposureByProduct.entries()].map(([key, exposureCount]) => ({
    key,
    label: scopedExposures.find((item) => (item.productId || item.itemId) === key)?.productTitle ||
      scopedClicks.find((item) => (item.productId || item.productTitle) === key)?.productTitle ||
      key,
    exposureCount,
    clickCount: clickByProduct.get(key) ?? 0,
    ctr: exposureCount ? Math.round(((clickByProduct.get(key) ?? 0) / exposureCount) * 1000) / 10 : 0
  })).sort((a, b) => b.clickCount - a.clickCount || b.exposureCount - a.exposureCount).slice(0, 12);
  return {
    totalExposures: productExposures.length,
    totalClicks: scopedClicks.length,
    overallCtr: productExposures.length ? Math.round((scopedClicks.length / productExposures.length) * 1000) / 10 : null,
    topProducts: aggregate((click) => click.productId || click.productTitle, (click) => click.productTitle || '未知商品'),
    ctrByProduct,
    byProvider: aggregate((click) => click.provider, (click) => click.provider || '未知供应商'),
    byType: aggregate((click) => click.type, (click) => click.type || '未知类型'),
    byPoi: aggregate((click) => click.poi || click.stopName, (click) => click.poi || click.stopName || '未知 POI'),
    byRoute: aggregate((click) => click.routeId || click.routeTitle, (click) => click.routeTitle || click.routeId || '未知路书'),
    byProfile: aggregate((click) => click.profileId && click.profileId !== 'anonymous' ? click.profileId : '', (click) => click.profileId),
    recentClicks: scopedClicks.slice(0, 20)
  };
}

function maxIso(a, b) {
  return String(a ?? '').localeCompare(String(b ?? '')) >= 0 ? a : b;
}

function countBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows ?? []) {
    const key = keyFn(row);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function percent(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function journeyKey(row = {}) {
  const profileId = normalizeProfileId(row?.profileId);
  const routeId = sanitizePublicId(row?.routeId || row?.publicId || row?.itemId);
  if (!routeId || !profileId || profileId === 'anonymous') return '';
  return `${profileId}::${routeId}`;
}

function journeyRouteId(key) {
  return String(key ?? '').split('::')[1] || '';
}

function journeyDateKey(row = {}) {
  const baseKey = journeyKey(row);
  const travelDate = normalizeTravelDate(row?.travelDate);
  return baseKey && travelDate ? `${baseKey}::${travelDate}` : '';
}

function journeyBaseKeyFromDateKey(key) {
  return String(key ?? '').split('::').slice(0, 2).join('::');
}

function journeyTravelDateFromKey(key) {
  return normalizeTravelDate(String(key ?? '').split('::')[2]);
}

function distinctJourneyKeys(rows) {
  return new Set((rows ?? []).map(journeyKey).filter(Boolean));
}

function distinctJourneyDateKeys(rows) {
  return new Set((rows ?? []).map(journeyDateKey).filter(Boolean));
}

function indexJourneyDatesByBase(dateKeys) {
  const datesByBase = new Map();
  for (const dateKey of dateKeys ?? []) {
    const baseKey = journeyBaseKeyFromDateKey(dateKey);
    if (!baseKey) continue;
    const keys = datesByBase.get(baseKey) ?? [];
    keys.push(dateKey);
    datesByBase.set(baseKey, keys);
  }
  return datesByBase;
}

function intersectSets(left, right) {
  return new Set([...left].filter((key) => right.has(key)));
}

async function buildPlatformDashboard(limit = 1000) {
  const [aiLogs, routebooks, checkins, favorites, reviews, imports, clicks, exposures] = await Promise.all([
    readJsonLines(AI_LOG_PATH, limit),
    listSavedRoutebooks(Math.min(limit, 500)),
    readJsonLines(CHECKIN_LOG_PATH, limit),
    readJsonLines(FAVORITE_LOG_PATH, limit),
    readJsonLines(REVIEW_LOG_PATH, limit),
    readJsonLines(IMPORT_LOG_PATH, limit),
    readJsonLines(CLICK_LOG_PATH, limit),
    readJsonLines(EXPOSURE_LOG_PATH, limit)
  ]);
  const generatedOk = aiLogs.filter((item) => item.kind === 'generate-routebook' && item.status === 'ok').length;
  const generateAttempts = aiLogs.filter((item) => item.kind === 'generate-routebook').length;
  const generatedRouteIds = new Set(aiLogs
    .filter((item) => item.kind === 'generate-routebook' && item.status === 'ok')
    .map((item) => sanitizePublicId(item.publicId))
    .filter(Boolean));
  const routebooksById = new Map(routebooks.map((item) => [sanitizePublicId(item.publicId || item.id), item]));
  const journeyEvents = exposures.filter((item) => item.itemType === 'journey-event');
  const saveJourneyEvents = journeyEvents.filter((item) => item.surface === 'routebook-save');
  const savedJourneyKeys = distinctJourneyKeys(saveJourneyEvents);
  const savedDatedJourneyKeys = distinctJourneyDateKeys(saveJourneyEvents);
  const savedJourneyDatesByBase = indexJourneyDatesByBase(savedDatedJourneyKeys);
  const tripOpenEvents = journeyEvents.filter((item) => item.surface === 'trip-open');
  const tripOpenJourneyKeys = distinctJourneyKeys(tripOpenEvents);
  const validCheckinDatedJourneyKeys = new Set();
  const eligibleExecutionCheckins = checkins.filter((item) => {
    if (!isEligibleTrustCheckin(item)) return false;
    const datedKeys = savedJourneyDatesByBase.get(journeyKey(item)) ?? [];
    let matched = false;
    for (const datedKey of datedKeys) {
      // 打卡行按 checkinEventTime（observedAt 优先）对齐出行日；exposures 不变。
      if (!isTravelDateCheckin(journeyTravelDateFromKey(datedKey), item)) continue;
      validCheckinDatedJourneyKeys.add(datedKey);
      matched = true;
    }
    return matched;
  });
  const validCheckinKeys = distinctJourneyKeys(eligibleExecutionCheckins);
  const travelDayOpenedJourneyKeys = distinctJourneyDateKeys(tripOpenEvents.filter((event) => {
    const dateKey = journeyDateKey(event);
    return Boolean(
      dateKey &&
      savedDatedJourneyKeys.has(dateKey) &&
      isTravelDateEvent(journeyTravelDateFromKey(dateKey), event)
    );
  }));
  const effectiveExecutedJourneyKeys = intersectSets(travelDayOpenedJourneyKeys, validCheckinDatedJourneyKeys);
  const openedJourneyKeys = new Set([...tripOpenJourneyKeys, ...validCheckinKeys]);
  const savedOpenedJourneyKeys = intersectSets(openedJourneyKeys, savedJourneyKeys);
  const sharedJourneyKeys = distinctJourneyKeys(journeyEvents.filter((item) => item.surface === 'routebook-share'));
  const savedSharedJourneyKeys = intersectSets(sharedJourneyKeys, savedJourneyKeys);
  const savedGeneratedRouteIds = new Set([...savedJourneyKeys]
    .map(journeyRouteId)
    .filter((routeId) => generatedRouteIds.has(routeId)));
  const editedJourneyKeys = new Set([...savedJourneyKeys].filter((key) => {
    const routebook = routebooksById.get(journeyRouteId(key));
    return Boolean(routebook?.provider?.editedAt || routebook?.provider?.statusUpdatedAt || routebook?.activeVariantId);
  }));
  const recordedImportSources = imports
    .flatMap((item) => Array.isArray(item?.sources) ? item.sources : [])
    .filter((source) => ['fetched', 'metadata-only', 'failed'].includes(source?.status));
  const importAnalysisSucceeded = recordedImportSources.filter((source) => source.status === 'fetched').length;
  const importAnalysisFailed = recordedImportSources.length - importAnalysisSucceeded;
  const savedRoutebooks = savedJourneyKeys.size;
  const validCheckins = eligibleExecutionCheckins.length;
  const sharedRoutebooks = savedSharedJourneyKeys.size;
  const editedRoutebooks = editedJourneyKeys.size;
  const legacyJourneyEventsMissingTravelDate = journeyEvents.filter((item) => !normalizeTravelDate(item?.travelDate)).length;
  const copiedCount = totalRoutebookCopyCount(exposures);
  const productAnalytics = await buildProductAnalytics(limit);
  const funnel = {
    generateAttempts,
    generatedOk,
    generatedRoutes: generatedRouteIds.size,
    generationSuccessRate: percent(generatedOk, generateAttempts),
    storedRoutebooks: routebooks.length,
    savedRoutebooks,
    // saveRate 的分子口径单独透出，便于运营台核对「AI 生成且被保存」的数量。
    savedGeneratedRoutebooks: savedGeneratedRouteIds.size,
    saveRate: percent(savedGeneratedRouteIds.size, generatedRouteIds.size),
    editedRoutebooks,
    editRate: percent(editedRoutebooks, savedRoutebooks),
    explicitTripOpenedJourneys: tripOpenJourneyKeys.size,
    tripOpenedJourneys: openedJourneyKeys.size,
    savedAnyTripOpenedJourneys: savedOpenedJourneyKeys.size,
    travelDateSavedRoutebooks: savedDatedJourneyKeys.size,
    savedTripOpenedJourneys: travelDayOpenedJourneyKeys.size,
    tripDayOpenRate: percent(travelDayOpenedJourneyKeys.size, savedDatedJourneyKeys.size),
    effectiveExecutedRoutebooks: effectiveExecutedJourneyKeys.size,
    effectiveExecutionRate: percent(effectiveExecutedJourneyKeys.size, savedDatedJourneyKeys.size),
    validCheckins,
    validCheckinJourneys: validCheckinKeys.size,
    checkinRate: percent(validCheckinKeys.size, openedJourneyKeys.size),
    travelDayCheckinRate: percent(effectiveExecutedJourneyKeys.size, travelDayOpenedJourneyKeys.size),
    sharedRoutebooks,
    shareRate: percent(sharedRoutebooks, savedRoutebooks),
    copiedCount,
    favoriteCount: favorites.length,
    reviewCount: reviews.length,
    importCount: imports.length,
    importAnalysisAttempts: recordedImportSources.length,
    importAnalysisSucceeded,
    importAnalysisFailed,
    importAnalysisSuccessRate: percent(importAnalysisSucceeded, recordedImportSources.length),
    legacyJourneyEventsMissingTravelDate,
    exposureCount: exposures.length,
    clickCount: clicks.length,
    clickThroughRate: productAnalytics.overallCtr
  };
  return {
    funnel,
    metricDefinitions: {
      tripDayOpen: {
        numerator: '保存事件冻结的 profileId + routeId + travelDate，与同日期快照的 trip-open 关联，且打开时间在该日期前后 1 天',
        denominator: '保存事件中带有效 travelDate 快照的 profileId + routeId + travelDate 组合；缺失快照的历史事件不回填',
        timezone: TRAVEL_DAY_TIME_ZONE,
        windowDaysBefore: TRAVEL_DAY_WINDOW_DAYS,
        windowDaysAfter: TRAVEL_DAY_WINDOW_DAYS
      },
      effectiveExecution: {
	        numerator: '已保存且同日期快照在出行日前后 1 天打开，并由同一绑定身份与路书在该日期前后 1 天产生 visited + 有效 GPS 到达的 profileId + routeId + travelDate 组合',
	        denominator: '保存事件中带有效 travelDate 快照的 profileId + routeId + travelDate 组合；缺失快照的历史事件不回填',
	        timezone: TRAVEL_DAY_TIME_ZONE,
	        windowDaysBefore: TRAVEL_DAY_WINDOW_DAYS,
	        windowDaysAfter: TRAVEL_DAY_WINDOW_DAYS
      },
      importAnalysis: {
        numerator: '状态为 fetched 的已记录来源',
        denominator: '明确记录为 fetched、metadata-only 或 failed 的来源'
      }
    },
    byCity: aggregateRoutebooksByCity(routebooks, checkins),
    topCreators: aggregateCreators(routebooks, checkins, favorites, clicks, exposures),
    productAnalytics,
    recentActivity: buildRecentActivity({ aiLogs, routebooks, checkins, favorites, reviews, imports, clicks, exposures })
  };
}

function aggregateRoutebooksByCity(routebooks, checkins) {
  const checkinsByCity = countBy(checkins, (item) => item.city);
  const map = new Map();
  for (const routebook of routebooks) {
    const city = routebook.city || '未知城市';
    const item = map.get(city) ?? { city, routebookCount: 0, featuredCount: 0, predictionScoreTotal: 0, validCheckins: checkinsByCity.get(city) ?? 0 };
    item.routebookCount += 1;
    if (routebook.publishStatus === 'featured') item.featuredCount += 1;
    item.predictionScoreTotal += Number(routebook.trustScore ?? 0);
    map.set(city, item);
  }
  return [...map.values()].map(({ predictionScoreTotal, ...item }) => ({
    ...item,
    avgPredictionScore: item.routebookCount ? Math.round(predictionScoreTotal / item.routebookCount) : null
  })).sort((a, b) => b.routebookCount - a.routebookCount).slice(0, 12);
}

function aggregateCreators(routebooks, checkins = [], favorites = [], clicks = [], exposures = []) {
  const validCheckinsByRoute = countBy(checkins.filter((item) => item.arrival?.valid), (item) => item.routeId || item.routeTitle);
  const favoritesByRoute = countBy(favorites, (item) => item.routeId || item.routeTitle);
  const clicksByCreator = countBy(clicks, (item) => item.creatorId);
  const map = new Map();
  for (const routebook of routebooks) {
    const creator = normalizeCreator(routebook.creator);
    const item = map.get(creator.id) ?? {
      creator,
      routebookCount: 0,
      copyCount: 0,
      validCheckins: 0,
      favoriteCount: 0,
      clickCount: clicksByCreator.get(creator.id) ?? 0,
      predictionScoreTotal: 0
    };
    item.routebookCount += 1;
    item.copyCount += routebookCopyCount(exposures, routebook.publicId || routebook.id);
    item.validCheckins += validCheckinsByRoute.get(routebook.publicId || routebook.title) ?? validCheckinsByRoute.get(routebook.title) ?? 0;
    item.favoriteCount += favoritesByRoute.get(routebook.publicId || routebook.title) ?? favoritesByRoute.get(routebook.title) ?? 0;
    item.predictionScoreTotal += Number(routebook.trustScore ?? 0);
    map.set(creator.id, item);
  }
  return [...map.values()].map(({ predictionScoreTotal, ...item }) => ({
    ...item,
    avgPredictionScore: item.routebookCount ? Math.round(predictionScoreTotal / item.routebookCount) : null
  })).sort((a, b) => (b.copyCount + b.validCheckins + b.favoriteCount + b.clickCount) - (a.copyCount + a.validCheckins + a.favoriteCount + a.clickCount)).slice(0, 12);
}

function buildRecentActivity(groups) {
  const rows = [
    ...groups.aiLogs.map((item) => ({ type: 'AI 生成', title: item.outputTitle || item.city, detail: item.status, createdAt: item.createdAt })),
    ...groups.routebooks.map((item) => ({ type: '路书', title: item.title, detail: `${item.city} · ${item.publishStatus || 'draft'}`, createdAt: item.updatedAt })),
    ...groups.checkins.map((item) => ({ type: '打卡', title: item.stopName, detail: item.arrival?.label || item.worth, createdAt: item.createdAt })),
    ...groups.imports.map((item) => ({ type: '导入', title: item.platforms?.join('、') || '攻略来源', detail: `均分 ${item.averageTrust}`, createdAt: item.createdAt })),
    ...groups.clicks.map((item) => ({ type: '点击', title: item.productTitle, detail: item.provider, createdAt: item.createdAt })),
    ...groups.exposures.map((item) => ({ type: '曝光', title: item.routeTitle || item.productTitle || item.itemId, detail: item.surface, createdAt: item.createdAt }))
  ];
  return rows
    .filter((item) => item.createdAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 20);
}

async function buildCreatorProfile(creatorId) {
  const id = sanitizePublicId(creatorId);
  const [routebooks, checkins, favorites, clicks, exposures] = await Promise.all([
    listSavedRoutebooks(500),
    readJsonLines(CHECKIN_LOG_PATH, 1000),
    readJsonLines(FAVORITE_LOG_PATH, 1000),
    readJsonLines(CLICK_LOG_PATH, 1000),
    readJsonLines(EXPOSURE_LOG_PATH, 50000)
  ]);
  const owned = routebooks.filter((routebook) =>
    normalizeCreator(routebook.creator).id === id &&
    PUBLIC_ROUTE_STATUSES.has(routebook.publishStatus || 'draft')
  );
  const creator = owned[0]?.creator ? normalizeCreator(owned[0].creator) : normalizeCreator({ id, name: id });
  const stats = aggregateCreators(owned, checkins, favorites, clicks, exposures)[0] ?? {
    creator,
    routebookCount: owned.length,
    copyCount: 0,
    validCheckins: 0,
    favoriteCount: 0,
    clickCount: 0,
    avgPredictionScore: null
  };
  // rank23①：达人主页多本路书共用同一份反馈上下文，避免逐本重扫 JSONL。
  const feedbackContext = owned.length ? await buildRouteFeedbackContext() : null;
  return {
    creator,
    stats,
    routebooks: (await Promise.all(owned.map((routebook) => enrichRoutebook(routebook, feedbackContext)))).map(publicRoutebookView)
  };
}

// 判同收紧为 resolvePoiId 相等或规范化名称完全相等；子串包含（如「柳浪闻莺」
// 与「柳浪闻莺东门」）只能作为低置信提示，不再直接判定为同一 POI。
function isSamePoi(stop, item) {
  const stopName = String(stop?.name ?? '');
  const itemName = String(item?.stopName ?? '');
  if (!stopName || !itemName) return false;
  const city = stop?.city || item?.city || '';
  if (resolvePoiId({ name: stopName }, city) === resolvePoiId({ name: itemName }, item?.city || city)) return true;
  const normalizedStopName = normalizePoiName(stopName);
  const normalizedItemName = normalizePoiName(itemName);
  return Boolean(normalizedStopName) && normalizedStopName === normalizedItemName;
}

// 子串包含降级为提示信号，供需要「疑似同一 POI」场景使用。
function isLowConfidenceSamePoiHint(stop, item) {
  const stopName = normalizePoiName(String(stop?.name ?? ''));
  const itemName = normalizePoiName(String(item?.stopName ?? ''));
  if (!stopName || !itemName || stopName === itemName) return false;
  return stopName.includes(itemName) || itemName.includes(stopName);
}

function buildSourceEvidenceForStop(routebook, stop) {
  const sources = normalizeImportedSources(routebook?.importedSources);
  if (!sources.length) return [];
  const stopName = String(stop?.name ?? '');
  const area = String(stop?.area ?? '');
  const matched = sources.filter((source) => {
    const haystack = `${source.title} ${source.description} ${source.excerpt}`;
    return (stopName && haystack.includes(stopName)) || (area && haystack.includes(area));
  });
  const selected = matched.length ? matched : sources.slice(0, 1);
  return selected.slice(0, 3).map((source, index) => ({
    id: `source-${index + 1}-${String(source.platformId ?? source.platform ?? 'web').replace(/[^A-Za-z0-9_-]/g, '')}`,
    type: matched.length ? 'matched-source' : 'route-source',
    label: `${source.platform || '导入来源'}｜可信 ${source.trustScore}`,
    detail: matched.length
      ? truncateString(source.title || source.description || source.excerpt || '来源命中该站点，需要出发前复核。', 220)
      : truncateString(`路线级来源，未在公开摘要中逐点命中「${stopName}」。${source.title || source.description || ''}`, 220),
    platform: source.platform,
    trustScore: source.trustScore,
    url: source.url,
    checkedAt: source.fetchedAt
  }));
}

function mergeFeedbackMetrics(metrics, feedbackSummary) {
  const trustedFeedbackCount = feedbackSummary.attestedCheckinCount ?? 0;
  const feedbackMetrics = [
    { label: '认证打卡', value: trustedFeedbackCount ? `${trustedFeedbackCount} 次` : '待验证' },
    { label: '有效到达', value: trustedFeedbackCount ? `${feedbackSummary.completionRate}%` : '待验证' },
    { label: '踩坑率', value: trustedFeedbackCount ? `${feedbackSummary.pitfallRate}%` : '待验证' },
    { label: '平均修改', value: feedbackSummary.saveVersionCount > 1 ? `${feedbackSummary.editRate}%` : '待验证' },
    { label: '最近验证', value: feedbackSummary.latestFeedbackAt ? new Date(feedbackSummary.latestFeedbackAt).toLocaleDateString('zh-CN') : '待验证' },
    { label: '复制转化', value: feedbackSummary.shareExposureCount ? `${feedbackSummary.copyConversionRate}%` : `${feedbackSummary.copyCount} 次` },
    { label: '纠错反馈', value: `${feedbackSummary.correctionCount} 条` }
  ];
  const replacedLabels = new Set(['真实打卡', ...feedbackMetrics.map((item) => item.label)]);
  return [...feedbackMetrics, ...metrics.filter((item) => !replacedLabels.has(item.label))].slice(0, 8);
}

async function readCmsConfig() {
  if (!existsSync(CMS_CONFIG_PATH)) {
    return {
      defaultCity: '杭州',
      heroTitle: '把分散攻略，变成能照着走的可信路书',
      featuredCities: ['杭州', '上海', '苏州', '成都', '北京', '广州'],
      announcements: [],
      updatedAt: null
    };
  }
  try {
    return JSON.parse(await readFile(CMS_CONFIG_PATH, 'utf8'));
  } catch {
    return {
      defaultCity: '杭州',
      heroTitle: '把分散攻略，变成能照着走的可信路书',
      featuredCities: ['杭州', '上海', '苏州'],
      announcements: ['CMS 配置文件损坏，已回退默认配置'],
      updatedAt: null
    };
  }
}

function normalizeCmsConfig(input) {
  return {
    defaultCity: normalizeCityName(input?.defaultCity ?? '杭州'),
    heroTitle: truncateString(input?.heroTitle, 80) || '把分散攻略，变成能照着走的可信路书',
    featuredCities: Array.isArray(input?.featuredCities)
      ? input.featuredCities.map((city) => normalizeCityName(city)).slice(0, 18)
      : ['杭州', '上海', '苏州'],
    announcements: Array.isArray(input?.announcements)
      ? input.announcements.map((item) => truncateString(item, 120)).filter(Boolean).slice(0, 8)
      : [],
    updatedAt: new Date().toISOString()
  };
}

function normalizeExternalUrl(value, { allowHttp = false } = {}) {
  const raw = truncateString(value, 500);
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw createHttpError('外链 URL 不合法', 400, 'BAD_EXTERNAL_URL');
  }
  const allowedProtocols = allowHttp ? ['http:', 'https:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol) || url.username || url.password) {
    throw createHttpError('外链只允许安全的 http/https 地址且不能包含认证信息', 400, 'UNSAFE_EXTERNAL_URL');
  }
  return url.toString();
}

function safeExternalUrl(value) {
  try {
    return normalizeExternalUrl(value, { allowHttp: false });
  } catch {
    return '';
  }
}

function safeSourceUrl(value) {
  try {
    return normalizeExternalUrl(value, { allowHttp: true });
  } catch {
    return '';
  }
}

function normalizeProductCard(input = {}, index = 0, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const preserveTimestamps = options.preserveTimestamps === true;
  const strictUrl = options.strictUrl === true;
  const title = truncateString(input?.title, 100);
  if (!title) return null;
  const poi = truncateString(input?.poi, 80) || '目的地';
  const provider = truncateString(input?.provider, 60) || '运营配置';
  // 跨区契约：白名单透传外链落地信息，前端据此显示「外部搜索入口」等标签。
  // linkType 仅收枚举值，非法值直接丢弃而不是落库脏数据。
  const targetPoi = truncateString(input?.targetPoi, 80);
  const linkType = ['deep-link', 'seed-search', 'search'].includes(input?.linkType) ? input.linkType : '';
  const deepLinkStatus = truncateString(input?.deepLinkStatus, 40);
  return {
    id: stablePublicId(input?.id || `${provider}-${title}-${poi}`, 'product'),
    type: truncateString(input?.type, 30) || '本地玩乐',
    title,
    poi,
    city: input?.city ? normalizeCityName(input.city) : '',
    price: truncateString(input?.price, 40) || '查看详情',
    provider,
    url: strictUrl ? normalizeExternalUrl(input?.url) : safeExternalUrl(input?.url),
    status: ['active', 'paused'].includes(input?.status) ? input.status : 'active',
    sourceAuthorization: truncateString(input?.sourceAuthorization, 40) || 'affiliate-link',
    priority: clampNumber(input?.priority, 0, 1000, 100 - index),
    ...(targetPoi ? { targetPoi } : {}),
    ...(linkType ? { linkType } : {}),
    ...(deepLinkStatus ? { deepLinkStatus } : {}),
    ...(typeof input?.analyticsReady === 'boolean' ? { analyticsReady: input.analyticsReady } : {}),
    updatedAt: preserveTimestamps ? (truncateString(input?.updatedAt, 60) || now) : now
  };
}

function normalizeProductConfig(input = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const preserveTimestamps = options.preserveTimestamps === true;
  const strictUrl = options.strictUrl === true;
  const products = Array.isArray(input?.products)
    ? input.products.map((item, index) => normalizeProductCard(item, index, { now, preserveTimestamps, strictUrl })).filter(Boolean).slice(0, 120)
    : [];
  return {
    products,
    updatedAt: preserveTimestamps ? (truncateString(input?.updatedAt, 60) || null) : now
  };
}

function seedProductConfig() {
  return normalizeProductConfig({ products: seedProductCards }, { preserveTimestamps: true });
}

async function readProductConfig() {
  if (!existsSync(PRODUCT_CONFIG_PATH)) {
    return seedProductConfig();
  }
  try {
    const config = normalizeProductConfig(JSON.parse(await readFile(PRODUCT_CONFIG_PATH, 'utf8')), { preserveTimestamps: true });
    return config.products.length ? config : seedProductConfig();
  } catch {
    return seedProductConfig();
  }
}

// rank-seed：种子/兜底商品卡（linkType:'seed-search'，或带 seed 标记但不在运营
// 配置里）不再 400 UNKNOWN_PRODUCT，而是以 provider:'seed' 规范化落库并单独归组
// （analyticsSource:'seed-fallback'），保证兜底外链点击也能进归因漏斗。
function hasSeedProductMarker(input = {}) {
  if (truncateString(input?.linkType, 40) === 'seed-search') return true;
  if (truncateString(input?.analyticsStatus, 40) === 'not_collected') return true;
  return /^seed-/.test(String(input?.productId ?? input?.id ?? ''));
}

async function resolveProductAttribution(input = {}) {
  const config = await readProductConfig();
  const requestedId = stablePublicId(input?.productId || input?.id || input?.title, 'product');
  const requestedTitle = truncateString(input?.title || input?.productTitle || input?.product, 100);
  const configProduct = config.products.find((item) =>
    item.status !== 'paused' &&
    (item.id === requestedId || (requestedTitle && item.title === requestedTitle))
  );
  if (!configProduct && !hasSeedProductMarker(input)) {
    throw createHttpError('商品归因不存在或已暂停', 400, 'UNKNOWN_PRODUCT');
  }
  const seedFallback = !configProduct;
  const product = configProduct ?? {
    id: requestedId,
    type: truncateString(input?.type, 30) || '种子推荐',
    title: requestedTitle || '种子商品卡',
    poi: truncateString(input?.poi || input?.targetPoi || input?.stopName, 80) || '目的地',
    city: input?.city ? normalizeCityName(input.city) : '',
    price: truncateString(input?.price, 40) || '查看详情',
    provider: 'seed',
    url: safeExternalUrl(input?.url),
    status: 'active'
  };
  const routeId = sanitizePublicId(input?.routeId || input?.publicId);
  const routebook = routeId ? await getResolvableRoutebook(routeId) : null;
  return {
    product,
    routebook,
    seedFallback,
    derived: {
      itemType: 'product',
      itemId: product.id,
      productId: product.id,
      productTitle: product.title,
      routeId: routebook?.publicId || routebook?.id || routeId,
      routeTitle: routebook?.title || truncateString(input?.routeTitle, 100),
      city: routebook?.city || product.city || (input?.city ? normalizeCityName(input.city) : ''),
      creatorId: routebook?.creator?.id || sanitizePublicId(input?.creatorId)
    }
  };
}

function normalizeOcrImage(image, index) {
  const name = truncateString(image?.name, 120) || `截图 ${index + 1}`;
  const mimeType = truncateString(image?.mimeType || image?.type, 80) || 'image/png';
  const data = String(image?.data ?? image?.base64 ?? '').trim();
  const base64 = data.includes(',') ? data.split(',').pop() : data;
  if (!/^image\/(png|jpe?g|webp)$/i.test(mimeType)) {
    throw createHttpError(`${name} 不是支持的图片格式`, 415, 'OCR_UNSUPPORTED_IMAGE');
  }
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw createHttpError(`${name} 图片内容为空或不是 base64`, 400, 'OCR_BAD_IMAGE');
  }
  const bytes = Buffer.byteLength(base64, 'base64');
  if (bytes > MAX_OCR_IMAGE_BYTES) {
    throw createHttpError(`${name} 超过 OCR 图片大小限制`, 413, 'OCR_IMAGE_TOO_LARGE');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!hasImageMagicBytes(buffer, mimeType)) {
    throw createHttpError(`${name} 图片文件头与格式不匹配`, 415, 'OCR_BAD_IMAGE_SIGNATURE');
  }
  return {
    name,
    mimeType,
    dataUrl: `data:${mimeType};base64,${base64}`,
    bytes
  };
}

function hasImageMagicBytes(buffer, mimeType) {
  const type = String(mimeType ?? '').toLowerCase();
  if (type === 'image/png') {
    return buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;
  }
  if (type === 'image/jpeg' || type === 'image/jpg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (type === 'image/webp') {
    return buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

// rank13①：不信客户端 mimeType，按魔数探测真实图片类型。
function detectImageMimeType(buffer) {
  for (const [mimeType] of CHECKIN_PHOTO_EXTENSIONS) {
    if (hasImageMagicBytes(buffer, mimeType)) return mimeType;
  }
  return '';
}

function checkinPhotoExtension(mimeType) {
  return CHECKIN_PHOTO_EXTENSIONS.find(([type]) => type === mimeType)?.[1] ?? '';
}

// rank13①：紧凑 APP1/TIFF 解析，仅提取 DateTimeOriginal 与 GPS 经纬度；
// 任何结构异常都静默返回 null，不阻断上传。
function extractJpegExif(buffer) {
  try {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) return null;
      const marker = buffer[offset + 1];
      if (marker === 0xd8) {
        offset += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return null;
      const segmentSize = buffer.readUInt16BE(offset + 2);
      if (segmentSize < 2 || offset + 2 + segmentSize > buffer.length) return null;
      if (marker === 0xe1 && buffer.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0') {
        return parseExifTiff(buffer.subarray(offset + 10, offset + 2 + segmentSize));
      }
      offset += 2 + segmentSize;
    }
  } catch {
    // EXIF 解析失败静默继续。
  }
  return null;
}

function parseExifTiff(tiff) {
  if (tiff.length < 8) return null;
  const endianTag = tiff.toString('latin1', 0, 2);
  const littleEndian = endianTag === 'II';
  if (!littleEndian && endianTag !== 'MM') return null;
  const readUInt16 = (at) => (littleEndian ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const readUInt32 = (at) => (littleEndian ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (readUInt16(2) !== 42) return null;

  const readIfdEntries = (ifdOffset) => {
    const entries = new Map();
    if (ifdOffset + 2 > tiff.length) return entries;
    const count = readUInt16(ifdOffset);
    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      if (entryOffset + 12 > tiff.length) break;
      entries.set(readUInt16(entryOffset), entryOffset);
    }
    return entries;
  };
  const entryValueOffset = (entryOffset, byteLength) =>
    (byteLength <= 4 ? entryOffset + 8 : readUInt32(entryOffset + 8));
  const readAscii = (entryOffset) => {
    const count = readUInt32(entryOffset + 4);
    const valueOffset = entryValueOffset(entryOffset, count);
    if (!Number.isFinite(valueOffset) || valueOffset + count > tiff.length) return '';
    return tiff.toString('latin1', valueOffset, valueOffset + count).replace(/\0+$/, '').trim();
  };
  const readRationals = (entryOffset, expected) => {
    const count = readUInt32(entryOffset + 4);
    if (count < expected) return null;
    const valueOffset = readUInt32(entryOffset + 8);
    if (!Number.isFinite(valueOffset) || valueOffset + expected * 8 > tiff.length) return null;
    const values = [];
    for (let index = 0; index < expected; index += 1) {
      const numerator = readUInt32(valueOffset + index * 8);
      const denominator = readUInt32(valueOffset + index * 8 + 4);
      if (!denominator) return null;
      values.push(numerator / denominator);
    }
    return values;
  };

  const ifd0 = readIfdEntries(readUInt32(4));
  const exifIfd = ifd0.has(0x8769) ? readIfdEntries(readUInt32(ifd0.get(0x8769) + 8)) : new Map();
  const gpsIfd = ifd0.has(0x8825) ? readIfdEntries(readUInt32(ifd0.get(0x8825) + 8)) : new Map();

  let takenAt = '';
  const dateEntry = exifIfd.get(0x9003) ?? ifd0.get(0x0132);
  if (dateEntry != null) {
    const match = readAscii(dateEntry).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
    if (match) takenAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
  }

  let lat = null;
  let lng = null;
  if (gpsIfd.has(1) && gpsIfd.has(2) && gpsIfd.has(3) && gpsIfd.has(4)) {
    const latRef = readAscii(gpsIfd.get(1)).toUpperCase();
    const lngRef = readAscii(gpsIfd.get(3)).toUpperCase();
    const latDms = readRationals(gpsIfd.get(2), 3);
    const lngDms = readRationals(gpsIfd.get(4), 3);
    if (latDms && lngDms && /^[NS]/.test(latRef) && /^[EW]/.test(lngRef)) {
      const latValue = (latDms[0] + latDms[1] / 60 + latDms[2] / 3600) * (latRef.startsWith('S') ? -1 : 1);
      const lngValue = (lngDms[0] + lngDms[1] / 60 + lngDms[2] / 3600) * (lngRef.startsWith('W') ? -1 : 1);
      if (isValidCoordinate(latValue, lngValue)) {
        lat = Number(latValue.toFixed(6));
        lng = Number(lngValue.toFixed(6));
      }
    }
  }
  if (!takenAt && lat == null && lng == null) return null;
  return {
    takenAt,
    lat,
    lng
  };
}

// rank13①：剥离 JPEG 的 APP1-APP15 元数据段与 COM 注释段（保留 APP0/JFIF），
// 从 SOS 起原样保留。结构异常一律返回 null（fail-closed），由调用方拒收：
// 返回原图的旧兜底会把未知结构的元数据原样落盘。
function stripJpegMetadata(buffer) {
  try {
    const parts = [buffer.subarray(0, 2)];
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) return null;
      const marker = buffer[offset + 1];
      // 段间 0xFF 填充字节：跳过而不误读为段头。
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xda) {
        parts.push(buffer.subarray(offset));
        return Buffer.concat(parts);
      }
      // SOS 之前不应出现独立标记或 EOI；出现即视为结构异常。
      if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return null;
      const segmentSize = buffer.readUInt16BE(offset + 2);
      if (segmentSize < 2 || offset + 2 + segmentSize > buffer.length) return null;
      if (!(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe) {
        parts.push(buffer.subarray(offset, offset + 2 + segmentSize));
      }
      offset += 2 + segmentSize;
    }
    // 扫不到 SOS 说明不是可渲染 JPEG。
    return null;
  } catch {
    return null;
  }
}

// rank13①-A：PNG 按 chunk 流重组，丢弃 eXIf/tEXt/zTXt/iTXt 元数据 chunk，
// 其余原样保留；IEND 之后的尾部字节（常见 polyglot 藏匿点）一并丢弃。
// 任何结构异常返回 null（fail-closed）。
const PNG_METADATA_CHUNK_TYPES = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

function stripPngMetadata(buffer) {
  try {
    if (buffer.length < 8 + 12) return null;
    const parts = [buffer.subarray(0, 8)];
    let offset = 8;
    let sawIend = false;
    while (offset + 12 <= buffer.length) {
      const dataLength = buffer.readUInt32BE(offset);
      if (dataLength > 0x7fffffff) return null;
      const chunkEnd = offset + 12 + dataLength;
      if (chunkEnd > buffer.length) return null;
      const type = buffer.toString('latin1', offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(type)) return null;
      if (offset === 8 && type !== 'IHDR') return null;
      if (!PNG_METADATA_CHUNK_TYPES.has(type)) {
        parts.push(buffer.subarray(offset, chunkEnd));
      }
      offset = chunkEnd;
      if (type === 'IEND') {
        sawIend = true;
        break;
      }
    }
    if (!sawIend) return null;
    return Buffer.concat(parts);
  } catch {
    return null;
  }
}

// rank13①-A：WebP 按 RIFF chunk 重组，丢弃 EXIF/XMP chunk、清 VP8X 头对应
// 标志位（E=0x08 / X=0x04）并修正 RIFF size。任何结构异常返回 null（fail-closed）。
function stripWebpMetadata(buffer) {
  try {
    if (buffer.length < 12 + 8) return null;
    if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null;
    const firstFourcc = buffer.toString('latin1', 12, 16);
    if (!['VP8 ', 'VP8L', 'VP8X'].includes(firstFourcc)) return null;
    const parts = [];
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const fourcc = buffer.toString('latin1', offset, offset + 4);
      if (!/^[ -~]{4}$/.test(fourcc)) return null;
      const dataLength = buffer.readUInt32LE(offset + 4);
      const dataEnd = offset + 8 + dataLength;
      if (dataEnd > buffer.length) return null;
      const pad = dataLength % 2;
      // 末尾 chunk 允许缺 padding 字节；重组时统一补齐偶数对齐。
      const hasPadByte = pad === 1 && dataEnd + 1 <= buffer.length;
      const nextOffset = dataEnd + (hasPadByte ? 1 : 0);
      if (fourcc === 'EXIF' || fourcc === 'XMP ') {
        offset = nextOffset;
        continue;
      }
      let chunk = buffer.subarray(offset, dataEnd + (hasPadByte ? 1 : 0));
      if (pad === 1 && !hasPadByte) chunk = Buffer.concat([chunk, Buffer.alloc(1)]);
      if (fourcc === 'VP8X' && dataLength >= 1) {
        chunk = Buffer.from(chunk);
        chunk[8] &= ~0x0c;
      }
      parts.push(chunk);
      offset = nextOffset;
    }
    // 尾部残留不足一个 chunk 头：视为损坏或 polyglot，fail-closed。
    if (offset !== buffer.length || !parts.length) return null;
    const payloadLength = parts.reduce((sum, part) => sum + part.length, 0);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(payloadLength + 4, 4);
    header.write('WEBP', 8, 'latin1');
    return Buffer.concat([header, ...parts]);
  } catch {
    return null;
  }
}

// 三种格式统一入口：解析失败返回 null，由 storeCheckinPhoto fail-closed 拒收。
function stripImageMetadata(buffer, mimeType) {
  if (mimeType === 'image/jpeg') return stripJpegMetadata(buffer);
  if (mimeType === 'image/png') return stripPngMetadata(buffer);
  if (mimeType === 'image/webp') return stripWebpMetadata(buffer);
  return null;
}

function createCheckinPhotoId() {
  // 24 个 base64url 字符（randomBytes(18)），天然满足 [A-Za-z0-9_-]{1,64}。
  return randomBytes(18).toString('base64url');
}

async function findRouteStopForPhoto(routeId, stopId) {
  if (!routeId) return null;
  const routebook = await getResolvableRoutebook(routeId).catch(() => null);
  if (!routebook?.stops?.length) return null;
  const routeStops = [
    ...(routebook.stops ?? []),
    ...(routebook.variants ?? []).flatMap((variant) => variant?.stops ?? [])
  ];
  const requestedStopId = String(stopId ?? '').trim();
  if (!requestedStopId) return null;
  return routeStops.find((stop) => String(stop?.id ?? '') === requestedStopId) ?? null;
}

// 照片 EXIF GPS 与站点坐标比对；无可比数据返回 null。
async function checkinPhotoExifMatchesStop(exif, routeId, stopId) {
  if (!exif || !isValidCoordinate(Number(exif.lat), Number(exif.lng))) return null;
  const stop = await findRouteStopForPhoto(routeId, stopId).catch(() => null);
  const distance = stop && isValidCoordinate(Number(stop.lat), Number(stop.lng))
    ? distanceMeters({ lat: Number(exif.lat), lng: Number(exif.lng) }, stop)
    : null;
  return Number.isFinite(distance) ? distance <= CHECKIN_PHOTO_GPS_MATCH_METERS : null;
}

async function checkinPhotoResponse(row, deduplicated) {
  const exif = row?.exif && typeof row.exif === 'object' ? row.exif : null;
  return {
    photo: {
      id: row.id,
      url: `/api/checkin-photos/${row.id}`,
      exifTakenAt: exif?.takenAt ?? '',
      exifMatchesStop: await checkinPhotoExifMatchesStop(exif, sanitizePublicId(row?.routeId), truncateString(row?.stopId, 80))
    },
    deduplicated
  };
}

// rank13①：解码校验（大小/魔数）→ (profileId, routeId, clientLocalId) 幂等反扫
// → 24 小时配额 → JPEG 提取 EXIF → 三格式元数据剥离（失败拒收）→ 落盘 + JSONL。
async function storeCheckinPhoto(body, actor) {
  const routeId = sanitizePublicId(body?.routeId || body?.publicId);
  const stopId = truncateString(body?.stopId, 80);
  const clientLocalId = truncateString(body?.clientLocalId, 120);
  // 幂等：多标签页重复上传同一 clientLocalId 时直接返回既有照片。
  if (clientLocalId) {
    const existing = await findLatestJsonLine(
      CHECKIN_PHOTO_LOG_PATH,
      (item) => normalizeProfileId(item?.profileId) === actor.profileId &&
        sanitizePublicId(item?.routeId) === routeId &&
        item?.clientLocalId === clientLocalId
    ).catch(() => null);
    if (existing) return checkinPhotoResponse(existing, true);
  }
  // 简单配额：同一 profile 24 小时内最多 CHECKIN_PHOTO_QUOTA_MAX 张。
  const quotaWindowStartMs = Date.now() - CHECKIN_PHOTO_QUOTA_WINDOW_MS;
  const recentUploads = await readMatchingJsonLines(
    CHECKIN_PHOTO_LOG_PATH,
    (item) => normalizeProfileId(item?.profileId) === actor.profileId &&
      Date.parse(item?.createdAt ?? '') >= quotaWindowStartMs,
    CHECKIN_PHOTO_QUOTA_MAX,
    100000
  );
  if (recentUploads.length >= CHECKIN_PHOTO_QUOTA_MAX) {
    throw createHttpError('24 小时内上传的打卡照片过多，请稍后再试', 429, 'PHOTO_QUOTA_EXCEEDED');
  }
  const rawImage = String(body?.imageBase64 ?? body?.data ?? '').trim();
  const base64 = (rawImage.includes(',') ? rawImage.split(',').pop() : rawImage).replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw createHttpError('照片内容为空或不是合法 base64', 400, 'PHOTO_INVALID');
  }
  if (Buffer.byteLength(base64, 'base64') > MAX_CHECKIN_PHOTO_BYTES) {
    throw createHttpError('照片超过大小限制', 413, 'PHOTO_TOO_LARGE');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw createHttpError('照片内容为空或不是合法 base64', 400, 'PHOTO_INVALID');
  if (buffer.length > MAX_CHECKIN_PHOTO_BYTES) {
    throw createHttpError('照片超过大小限制', 413, 'PHOTO_TOO_LARGE');
  }
  const mimeType = detectImageMimeType(buffer);
  if (!mimeType) {
    throw createHttpError('仅支持 JPEG/PNG/WebP 图片，且文件头必须与格式匹配', 400, 'PHOTO_INVALID');
  }
  const exif = mimeType === 'image/jpeg' ? extractJpegExif(buffer) : null;
  // fail-closed：任一格式解析/剥离失败即拒收，不再落存可能携带元数据的原图。
  const stored = stripImageMetadata(buffer, mimeType);
  if (!stored || !stored.length) {
    throw createHttpError('照片结构异常，无法安全剥离元数据，已拒绝存储', 400, 'PHOTO_INVALID');
  }
  const id = createCheckinPhotoId();
  await mkdir(CHECKIN_PHOTO_DIR, { recursive: true });
  await writeFile(join(CHECKIN_PHOTO_DIR, `${id}${checkinPhotoExtension(mimeType)}`), stored);
  const row = {
    id,
    profileId: actor.profileId,
    routeId,
    stopId,
    clientLocalId,
    mimeType,
    bytes: stored.length,
    exif: exif ? { takenAt: exif.takenAt || '', lat: exif.lat, lng: exif.lng } : null,
    createdAt: new Date().toISOString()
  };
  await appendJsonLine(CHECKIN_PHOTO_LOG_PATH, row);
  return checkinPhotoResponse(row, false);
}

async function sendCheckinPhotoFile(res, photoId) {
  for (const [mimeType, extension] of CHECKIN_PHOTO_EXTENSIONS) {
    const filePath = join(CHECKIN_PHOTO_DIR, `${photoId}${extension}`);
    if (!existsSync(filePath)) continue;
    const bodyBuffer = await readFile(filePath);
    res.writeHead(200, {
      ...securityHeaders(),
      ...requestIdHeaders(res),
      'content-type': mimeType,
      'content-length': bodyBuffer.length,
      'cache-control': 'public, max-age=31536000, immutable'
    });
    res.end(bodyBuffer);
    return true;
  }
  return false;
}

function normalizeOcrResult(result, images, runtime) {
  const places = Array.isArray(result?.places) ? result.places : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  return {
    ok: true,
    imageCount: images.length,
    places: places.slice(0, 24).map((place, index) => ({
      name: truncateString(place?.name, 48) || `候选地点 ${index + 1}`,
      time: truncateString(place?.time, 40),
      price: truncateString(place?.price, 40),
      note: truncateString(place?.note, 120),
      confidence: clampNumber(place?.confidence, 0, 99, 58)
    })),
    guideText: truncateString(result?.guideText, 4000),
    warnings: warnings.map((item) => truncateString(item, 120)).slice(0, 12),
    provider: {
      name: runtime.providerName,
      model: runtime.model,
      baseUrl: redactBaseUrl(runtime.baseUrl),
      generatedAt: new Date().toISOString()
    }
  };
}

const CITY_CENTERS = {
  北京: { lat: 39.9042, lng: 116.4074 },
  上海: { lat: 31.2304, lng: 121.4737 },
  广州: { lat: 23.1291, lng: 113.2644 },
  深圳: { lat: 22.5431, lng: 114.0579 },
  杭州: { lat: 30.2487, lng: 120.1551 },
  苏州: { lat: 31.2989, lng: 120.5853 },
  南京: { lat: 32.0603, lng: 118.7969 },
  宁波: { lat: 29.8683, lng: 121.544 },
  无锡: { lat: 31.4912, lng: 120.3119 },
  厦门: { lat: 24.4798, lng: 118.0894 },
  福州: { lat: 26.0745, lng: 119.2965 },
  青岛: { lat: 36.0671, lng: 120.3826 },
  济南: { lat: 36.6512, lng: 117.1201 },
  黄山: { lat: 29.7147, lng: 118.3376 },
  天津: { lat: 39.3434, lng: 117.3616 },
  秦皇岛: { lat: 39.9354, lng: 119.5996 },
  大同: { lat: 40.0768, lng: 113.3001 },
  太原: { lat: 37.8706, lng: 112.5489 },
  呼和浩特: { lat: 40.8426, lng: 111.7492 },
  成都: { lat: 30.5728, lng: 104.0668 },
  重庆: { lat: 29.563, lng: 106.5516 },
  昆明: { lat: 25.0389, lng: 102.7183 },
  大理: { lat: 25.6065, lng: 100.2676 },
  丽江: { lat: 26.855, lng: 100.2278 },
  贵阳: { lat: 26.647, lng: 106.6302 },
  西双版纳: { lat: 22.0094, lng: 100.7974 },
  拉萨: { lat: 29.652, lng: 91.1721 },
  西安: { lat: 34.3416, lng: 108.9398 },
  兰州: { lat: 36.0611, lng: 103.8343 },
  敦煌: { lat: 40.1421, lng: 94.6619 },
  银川: { lat: 38.4872, lng: 106.2309 },
  乌鲁木齐: { lat: 43.8256, lng: 87.6168 },
  喀什: { lat: 39.4704, lng: 75.9898 },
  武汉: { lat: 30.5928, lng: 114.3055 },
  长沙: { lat: 28.2282, lng: 112.9388 },
  张家界: { lat: 29.1167, lng: 110.4792 },
  郑州: { lat: 34.7466, lng: 113.6254 },
  洛阳: { lat: 34.6197, lng: 112.454 },
  南昌: { lat: 28.6829, lng: 115.8582 },
  沈阳: { lat: 41.8057, lng: 123.4315 },
  大连: { lat: 38.914, lng: 121.6147 },
  长春: { lat: 43.8171, lng: 125.3235 },
  哈尔滨: { lat: 45.8038, lng: 126.5349 },
  延吉: { lat: 42.8913, lng: 129.5089 },
  桂林: { lat: 25.2736, lng: 110.2902 },
  三亚: { lat: 18.2528, lng: 109.5119 },
  海口: { lat: 20.044, lng: 110.1999 },
  珠海: { lat: 22.2711, lng: 113.5767 },
  佛山: { lat: 23.0215, lng: 113.1214 }
};
const CHINA_CENTER = { lat: 35.8617, lng: 104.1954 };

// openHours is only filled where the pattern is structural and stable (always-open
// streets and stations, museum rest days). Anything time-sensitive stays absent so the
// validator reports "无营业时间数据" instead of inventing a schedule; ops fills the rest
// through the POI fact pipeline, where each entry carries evidence and a review date.
// closedWeekdays uses 0=周日 .. 6=周六.
const ALWAYS_OPEN_HOURS = { alwaysOpen: true, closedWeekdays: [] };
const TRUSTED_POI_CATALOG = [
  { poiId: 'poi-hz-hangzhou-east', city: '杭州', name: '杭州东站', aliases: [], lat: 30.2936, lng: 120.2154, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-liulang-wenying', city: '杭州', name: '柳浪闻莺', aliases: ['柳浪闻莺公园'], lat: 30.242, lng: 120.1617, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-southern-song-street', city: '杭州', name: '南宋御街', aliases: [], lat: 30.2432, lng: 120.1696, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-beishan-street', city: '杭州', name: '北山街', aliases: ['北山街日落线'], lat: 30.2596, lng: 120.1472, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-faxi-temple', city: '杭州', name: '法喜寺', aliases: ['上天竺法喜讲寺'], lat: 30.2366, lng: 120.0954 },
  { poiId: 'poi-hz-longjing-tea', city: '杭州', name: '龙井茶园', aliases: ['龙井村茶园'], lat: 30.2248, lng: 120.1032 },
  { poiId: 'poi-hz-maojiabu', city: '杭州', name: '茅家埠', aliases: [], lat: 30.2468, lng: 120.1139, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-caa-xiangshan', city: '杭州', name: '中国美院象山', aliases: ['中国美术学院象山校区'], lat: 30.1679, lng: 120.078 },
  { poiId: 'poi-hz-zhejiang-art-museum', city: '杭州', name: '浙江美术馆', aliases: [], lat: 30.2443, lng: 120.1591, openHours: { closedWeekdays: [1], note: '周一闭馆（法定节假日另行公告）' } },
  { poiId: 'poi-hz-hubin-intime', city: '杭州', name: '湖滨银泰', aliases: ['湖滨银泰in77'], lat: 30.2583, lng: 120.1641 },
  { poiId: 'poi-sh-wukang-road', city: '上海', name: '武康路', aliases: ['武康路历史文化名街'], lat: 31.2123, lng: 121.4382, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-sh-anfu-road', city: '上海', name: '安福路', aliases: [], lat: 31.217, lng: 121.4431, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-sh-exhibition-center', city: '上海', name: '上海展览中心', aliases: ['上海展览馆'], lat: 31.2264, lng: 121.4512 },
  { poiId: 'poi-sz-humble-admin-garden', city: '苏州', name: '拙政园', aliases: [], lat: 31.3243, lng: 120.6252 },
  { poiId: 'poi-sz-pingjiang-road', city: '苏州', name: '平江路', aliases: ['平江历史文化街区'], lat: 31.3156, lng: 120.6314, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-sz-shantang-street', city: '苏州', name: '山塘街', aliases: ['七里山塘'], lat: 31.3267, lng: 120.6004, openHours: ALWAYS_OPEN_HOURS }
];

const OPERATIONAL_POI_CITIES = ['杭州', '上海', '苏州'];
const OPERATIONAL_POI_CITY_SET = new Set(OPERATIONAL_POI_CITIES);
const POI_REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);
const POI_SOURCE_TYPES = new Set(['official', 'first-party', 'editorial', 'field-check', 'user-report', 'derived', 'ai', 'fallback']);
const POI_EVIDENCE_TYPES = new Set(['web', 'document', 'photo', 'receipt', 'field-note', 'api', 'other']);
const POI_FACT_EXPIRING_SOON_DAYS = 30;

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalizeJsonValue(value[key])])
    );
  }
  return value;
}

function stableJsonStringify(value) {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function fullContentHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function stablePoiChildId(prefix, poiId, value) {
  return `${prefix}-${fullContentHash(`${poiId}:${stableJsonStringify(value)}`).slice(0, 20)}`;
}

function poiValidationIssue(code, path, message) {
  return { code, path, message };
}

function normalizePoiDateValue(value) {
  const text = truncateString(value, 60);
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const timestamp = Date.parse(`${text}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text ? text : null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parsePoiBatchRows(input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, 'rows')) {
    if (!Array.isArray(input.rows)) {
      return {
        hashSource: stableJsonStringify(input.rows),
        parsedRows: [{ line: 1, raw: null, parseError: poiValidationIssue('ROWS_NOT_ARRAY', 'rows', 'rows 必须是数组') }]
      };
    }
    return {
      hashSource: stableJsonStringify(input.rows),
      parsedRows: input.rows.map((raw, index) => ({ line: index + 1, raw }))
    };
  }

  const content = String(input?.content ?? '');
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      hashSource: content,
      parsedRows: [{ line: 1, raw: null, parseError: poiValidationIssue('CONTENT_REQUIRED', 'content', 'content 或 rows 不能为空') }]
    };
  }
  try {
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : [parsed];
    return {
      hashSource: content,
      parsedRows: rows.map((raw, index) => ({ line: index + 1, raw }))
    };
  } catch {
    const parsedRows = [];
    content.split(/\r?\n/).forEach((lineText, index) => {
      if (!lineText.trim()) return;
      try {
        parsedRows.push({ line: index + 1, raw: JSON.parse(lineText) });
      } catch {
        parsedRows.push({
          line: index + 1,
          raw: null,
          parseError: poiValidationIssue('INVALID_JSON', `line[${index + 1}]`, '该行不是合法 JSON')
        });
      }
    });
    return { hashSource: content, parsedRows };
  }
}

function normalizePoiEvidence(raw, poiId, index, errors) {
  const path = `evidence[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(poiValidationIssue('EVIDENCE_NOT_OBJECT', path, '证据必须是对象'));
    return null;
  }
  const inputStatus = truncateString(raw.reviewStatus || raw.status, 24) || 'pending';
  if (!POI_REVIEW_STATUSES.has(inputStatus)) {
    errors.push(poiValidationIssue('INVALID_EVIDENCE_STATUS', `${path}.reviewStatus`, '证据状态只能是 pending/approved/rejected'));
  }
  const inputType = truncateString(raw.type, 24) || 'web';
  if (!POI_EVIDENCE_TYPES.has(inputType)) {
    errors.push(poiValidationIssue('INVALID_EVIDENCE_TYPE', `${path}.type`, '证据类型不在允许范围内'));
  }
  const sourceType = truncateString(raw.sourceType, 24) || 'editorial';
  if (!POI_SOURCE_TYPES.has(sourceType)) {
    errors.push(poiValidationIssue('INVALID_SOURCE_TYPE', `${path}.sourceType`, '证据来源类型不在允许范围内'));
  }
  const url = truncateString(raw.url || raw.sourceUrl, 500);
  if (url && !isHttpUrl(url)) {
    errors.push(poiValidationIssue('INVALID_HTTP_URL', `${path}.url`, '证据 URL 必须使用 http 或 https'));
  }
  const documentId = truncateString(raw.documentId || raw.controlledDocumentId || raw.sourceDocumentId, 160);
  const capturedAt = normalizePoiDateValue(raw.capturedAt || raw.observedAt || raw.verifiedAt);
  const publishedAt = normalizePoiDateValue(raw.publishedAt);
  if (capturedAt === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.capturedAt`, 'capturedAt 不是合法日期'));
  if (publishedAt === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.publishedAt`, 'publishedAt 不是合法日期'));
  if (inputStatus === 'approved' && !url && !documentId) {
    errors.push(poiValidationIssue('AUDITABLE_EVIDENCE_SOURCE_REQUIRED', path, '通过审核的证据必须包含 URL 或受控文档 ID'));
  }
  if (inputStatus === 'approved' && !capturedAt) {
    errors.push(poiValidationIssue('EVIDENCE_CAPTURED_AT_REQUIRED', `${path}.capturedAt`, '通过审核的证据必须记录采集时间'));
  }
  const identity = {
    type: inputType,
    sourceType,
    url,
    documentId,
    title: truncateString(raw.title || raw.label, 160),
    capturedAt: capturedAt || '',
    publishedAt: publishedAt || ''
  };
  return {
    id: sanitizePublicId(raw.id || raw.evidenceId) || stablePoiChildId('evidence', poiId, identity),
    ...identity,
    publisher: truncateString(raw.publisher || raw.sourceName, 100),
    note: truncateString(raw.note || raw.summary, 500),
    reviewStatus: POI_REVIEW_STATUSES.has(inputStatus) ? inputStatus : 'pending'
  };
}

function normalizePoiFact(raw, poiId, index, errors) {
  const path = `facts[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(poiValidationIssue('FACT_NOT_OBJECT', path, '事实必须是对象'));
    return null;
  }
  const field = truncateString(raw.field || raw.type || raw.key, 80);
  const value = truncateString(raw.value, 1000);
  if (!field) errors.push(poiValidationIssue('FACT_FIELD_REQUIRED', `${path}.field`, '事实字段不能为空'));
  if (!value) errors.push(poiValidationIssue('FACT_VALUE_REQUIRED', `${path}.value`, '事实值不能为空'));
  const inputStatus = truncateString(raw.reviewStatus || raw.status, 24) || 'pending';
  if (!POI_REVIEW_STATUSES.has(inputStatus)) {
    errors.push(poiValidationIssue('INVALID_FACT_STATUS', `${path}.reviewStatus`, '事实状态只能是 pending/approved/rejected'));
  }
  const sourceType = truncateString(raw.sourceType, 24) || 'editorial';
  if (!POI_SOURCE_TYPES.has(sourceType)) {
    errors.push(poiValidationIssue('INVALID_SOURCE_TYPE', `${path}.sourceType`, '事实来源类型不在允许范围内'));
  }
  const validFrom = normalizePoiDateValue(raw.validFrom || raw.effectiveAt);
  const validUntil = normalizePoiDateValue(raw.validUntil || raw.expiresAt);
  const verifiedAt = normalizePoiDateValue(raw.verifiedAt);
  if (validFrom === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.validFrom`, 'validFrom 不是合法日期'));
  if (validUntil === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.validUntil`, 'validUntil 不是合法日期'));
  if (verifiedAt === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.verifiedAt`, 'verifiedAt 不是合法日期'));
  if (validFrom && validUntil && Date.parse(validFrom) > Date.parse(validUntil)) {
    errors.push(poiValidationIssue('INVALID_DATE_RANGE', `${path}.validUntil`, 'validUntil 不能早于 validFrom'));
  }
  const evidenceIds = Array.isArray(raw.evidenceIds)
    ? [...new Set(raw.evidenceIds.map((id) => sanitizePublicId(id)).filter(Boolean))]
    : raw.evidenceId
      ? [sanitizePublicId(raw.evidenceId)].filter(Boolean)
      : [];
  const identity = { field, value, sourceType, evidenceIds };
  return {
    id: sanitizePublicId(raw.id || raw.factId) || stablePoiChildId('fact', poiId, identity),
    field,
    value,
    sourceType: POI_SOURCE_TYPES.has(sourceType) ? sourceType : 'editorial',
    reviewStatus: POI_REVIEW_STATUSES.has(inputStatus) ? inputStatus : 'pending',
    validFrom: validFrom || '',
    validUntil: validUntil || '',
    verifiedAt: verifiedAt || '',
    evidenceIds,
    note: truncateString(raw.note, 500)
  };
}

function normalizePoiAudit(raw, poiId, index, errors) {
  const path = `audits[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(poiValidationIssue('AUDIT_NOT_OBJECT', path, '审核记录必须是对象'));
    return null;
  }
  const status = truncateString(raw.reviewStatus || raw.status, 24);
  if (status && !POI_REVIEW_STATUSES.has(status)) {
    errors.push(poiValidationIssue('INVALID_AUDIT_STATUS', `${path}.reviewStatus`, '审核状态只能是 pending/approved/rejected'));
  }
  const createdAt = normalizePoiDateValue(raw.createdAt || raw.reviewedAt);
  if (createdAt === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.createdAt`, '审核时间不是合法日期'));
  const identity = {
    action: truncateString(raw.action, 40) || 'review',
    reviewStatus: POI_REVIEW_STATUSES.has(status) ? status : '',
    note: truncateString(raw.note || raw.reason, 500),
    createdAt: createdAt || ''
  };
  return {
    id: sanitizePublicId(raw.id || raw.auditId) || stablePoiChildId('audit', poiId, identity),
    ...identity,
    actorType: normalizeRoutebookActorType(raw.actorType || 'admin'),
    source: truncateString(raw.source, 40) || 'import'
  };
}

function validateUniquePoiChildren(items, kind, errors) {
  const seen = new Set();
  items.forEach((item, index) => {
    if (!item?.id) return;
    if (seen.has(item.id)) {
      errors.push(poiValidationIssue(`DUPLICATE_${kind}_ID`, `${kind.toLowerCase()}[${index}].id`, `${kind} ID 在同一 POI 中重复`));
    }
    seen.add(item.id);
  });
}

function normalizeOperationalPoiRow(raw, line = 1) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      line,
      status: 'error',
      errors: [poiValidationIssue('POI_NOT_OBJECT', `line[${line}]`, 'POI 行必须是对象')],
      warnings,
      normalized: null
    };
  }
  const cityText = truncateString(raw.city, 40).replace(/市$/u, '');
  if (!cityText) errors.push(poiValidationIssue('CITY_REQUIRED', 'city', '城市不能为空'));
  if (cityText && !OPERATIONAL_POI_CITY_SET.has(cityText)) {
    errors.push(poiValidationIssue('UNSUPPORTED_OPERATIONAL_CITY', 'city', '运营内容当前只支持杭州、上海、苏州'));
  }
  const name = truncateString(raw.name || raw.poiName, 120);
  if (!name) errors.push(poiValidationIssue('POI_NAME_REQUIRED', 'name', 'POI 名称不能为空'));
  const lat = Number(raw.location?.lat ?? raw.lat);
  const lng = Number(raw.location?.lng ?? raw.lng);
  if (!isValidCoordinate(lat, lng)) {
    errors.push(poiValidationIssue('INVALID_LOCATION', 'location', 'location.lat/lng 必须是合法经纬度'));
  } else if (cityText && OPERATIONAL_POI_CITY_SET.has(cityText)) {
    const distanceWarning = coordinateDistanceWarning(lat, lng, cityText);
    if (distanceWarning) {
      errors.push(poiValidationIssue('LOCATION_CITY_MISMATCH', 'location', `坐标不在${cityText}可接受范围内`));
    }
  }
  const reviewStatusInput = truncateString(raw.reviewStatus || raw.status, 24) || 'pending';
  if (!POI_REVIEW_STATUSES.has(reviewStatusInput)) {
    errors.push(poiValidationIssue('INVALID_POI_STATUS', 'reviewStatus', 'POI 状态只能是 pending/approved/rejected'));
  }
  const sourceType = truncateString(raw.sourceType, 24) || 'editorial';
  if (!POI_SOURCE_TYPES.has(sourceType)) {
    errors.push(poiValidationIssue('INVALID_SOURCE_TYPE', 'sourceType', 'POI 来源类型不在允许范围内'));
  }
  const fallbackPoiId = cityText && name ? `poi-${fullContentHash(`${cityText}:${normalizePoiName(name)}`).slice(0, 20)}` : '';
  const poiId = sanitizePublicId(raw.poiId || raw.id) || fallbackPoiId;
  if (!poiId) errors.push(poiValidationIssue('POI_ID_REQUIRED', 'poiId', '无法生成 POI ID'));
  const aliases = Array.isArray(raw.aliases)
    ? [...new Set(raw.aliases.map((alias) => truncateString(alias, 120)).filter(Boolean))].slice(0, 20)
    : [];
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .map((item, index) => normalizePoiEvidence(item, poiId, index, errors))
    .filter(Boolean);
  const facts = (Array.isArray(raw.facts) ? raw.facts : [])
    .map((item, index) => normalizePoiFact(item, poiId, index, errors))
    .filter(Boolean);
  const audits = (Array.isArray(raw.audits) ? raw.audits : [])
    .map((item, index) => normalizePoiAudit(item, poiId, index, errors))
    .filter(Boolean);
  validateUniquePoiChildren(evidence, 'EVIDENCE', errors);
  validateUniquePoiChildren(facts, 'FACT', errors);
  validateUniquePoiChildren(audits, 'AUDIT', errors);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  facts.forEach((fact, factIndex) => {
    fact.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!evidenceIds.has(evidenceId)) {
        errors.push(poiValidationIssue('UNKNOWN_EVIDENCE_REFERENCE', `facts[${factIndex}].evidenceIds[${evidenceIndex}]`, `事实引用了不存在的证据 ${evidenceId}`));
      }
    });
  });
  if (!facts.length) warnings.push(poiValidationIssue('NO_FACTS', 'facts', 'POI 尚未录入可审核事实'));
  if (reviewStatusInput === 'pending') warnings.push(poiValidationIssue('POI_PENDING_REVIEW', 'reviewStatus', 'POI 仍处于待审核状态'));
  if (reviewStatusInput === 'approved' && !facts.some((fact) => fact.reviewStatus === 'approved' && fact.evidenceIds.length)) {
    warnings.push(poiValidationIssue('APPROVED_WITHOUT_EVIDENCE_BACKED_FACT', 'facts', '已审核 POI 尚无通过审核且关联证据的事实'));
  }
  const createdAt = normalizePoiDateValue(raw.createdAt);
  if (createdAt === null) errors.push(poiValidationIssue('INVALID_DATE', 'createdAt', 'createdAt 不是合法日期'));
  return {
    line,
    status: errors.length ? 'error' : 'new',
    errors,
    warnings,
    normalized: {
      schemaVersion: 1,
      poiId,
      city: cityText,
      name,
      aliases,
      category: truncateString(raw.category, 80),
      location: {
        lat: isValidCoordinate(lat, lng) ? lat : null,
        lng: isValidCoordinate(lat, lng) ? lng : null,
        address: truncateString(raw.location?.address || raw.address, 240)
      },
      sourceKind: 'operational',
      sourceType: POI_SOURCE_TYPES.has(sourceType) ? sourceType : 'editorial',
      reviewStatus: POI_REVIEW_STATUSES.has(reviewStatusInput) ? reviewStatusInput : 'pending',
      facts,
      evidence,
      audits,
      createdAt: createdAt || ''
    }
  };
}

function latestItemsById(existingItems = [], incomingItems = []) {
  const map = new Map();
  for (const item of [...existingItems, ...incomingItems]) {
    const id = sanitizePublicId(item?.id);
    if (id) map.set(id, item);
  }
  return [...map.values()];
}

function mergeOperationalPoiSnapshot(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    facts: latestItemsById(existing.facts, incoming.facts),
    evidence: latestItemsById(existing.evidence, incoming.evidence),
    audits: latestItemsById(existing.audits, incoming.audits),
    createdAt: existing.createdAt || incoming.createdAt
  };
}

function comparablePoiSnapshot(row) {
  if (!row) return null;
  const audits = (row.audits ?? []).filter((audit) => audit?.source !== 'batch-commit');
  return canonicalizeJsonValue({
    schemaVersion: positiveInteger(row.schemaVersion, 1),
    poiId: row.poiId,
    city: row.city,
    name: row.name,
    aliases: row.aliases ?? [],
    category: row.category ?? '',
    location: row.location,
    sourceKind: 'operational',
    sourceType: row.sourceType,
    reviewStatus: row.reviewStatus,
    facts: row.facts ?? [],
    evidence: row.evidence ?? [],
    audits,
    createdAt: row.createdAt ?? ''
  });
}

function poiBatchPayloadHash(rows) {
  return fullContentHash(stableJsonStringify(rows.map((row) => ({
    normalized: row.normalized,
    errors: row.errors
      .filter((error) => error.code !== 'POI_IDENTITY_CONFLICT')
      .map((error) => ({ code: error.code, path: error.path }))
  }))));
}

function poiBatchTargetHash(value) {
  return fullContentHash(stableJsonStringify(value)).slice(0, 32);
}

function poiBatchScalarValues(row) {
  return {
    schemaVersion: positiveInteger(row?.schemaVersion, 1),
    city: row?.city ?? '',
    name: row?.name ?? '',
    aliases: row?.aliases ?? [],
    category: row?.category ?? '',
    location: row?.location ?? null,
    sourceKind: row?.sourceKind ?? '',
    sourceType: row?.sourceType ?? '',
    reviewStatus: row?.reviewStatus ?? ''
  };
}

function poiBatchChildScope(existingItems, incomingItems) {
  const existingById = new Map((existingItems ?? []).map((item) => [sanitizePublicId(item?.id), item]));
  return (incomingItems ?? [])
    .map((item) => sanitizePublicId(item?.id))
    .filter(Boolean)
    .sort()
    .map((id) => [id, poiBatchTargetHash(existingById.has(id) ? existingById.get(id) : null)]);
}

function poiBatchScopedBaseline(rows, existingById) {
  return rows.map((row, index) => {
    const incoming = row.normalized;
    if (!incoming) return { index, poiId: '', scalars: [], facts: [], evidence: [], audits: [] };
    const existing = existingById.get(incoming.poiId);
    const existingScalars = existing ? poiBatchScalarValues(existing) : {};
    const scalarNames = Object.keys(poiBatchScalarValues(incoming)).sort();
    return {
      index,
      poiId: incoming.poiId,
      scalars: scalarNames.map((name) => [name, poiBatchTargetHash(existing ? existingScalars[name] : null)]),
      facts: poiBatchChildScope(existing?.facts, incoming.facts),
      evidence: poiBatchChildScope(existing?.evidence, incoming.evidence),
      audits: poiBatchChildScope(existing?.audits, incoming.audits)
    };
  });
}

function poiBatchIncomingScope(rows) {
  const incomingById = new Map(rows
    .map((row) => row.normalized)
    .filter(Boolean)
    .map((row) => [row.poiId, row]));
  return poiBatchScopedBaseline(rows, incomingById);
}

function flattenPoiBatchScope(scope) {
  const targets = new Map();
  for (const row of scope ?? []) {
    const prefix = `${row.index}:${row.poiId}`;
    for (const [name, hash] of row.scalars ?? []) targets.set(`${prefix}:scalar:${name}`, hash);
    for (const type of ['facts', 'evidence', 'audits']) {
      for (const [id, hash] of row[type] ?? []) targets.set(`${prefix}:${type}:${id}`, hash);
    }
  }
  return targets;
}

function poiBatchBaselineIsStale(baselineScope, currentScope, incomingScope) {
  const baseline = flattenPoiBatchScope(baselineScope);
  const current = flattenPoiBatchScope(currentScope);
  const incoming = flattenPoiBatchScope(incomingScope);
  for (const [target, baselineHash] of baseline) {
    const currentHash = current.get(target);
    if (!currentHash || (currentHash !== baselineHash && currentHash !== incoming.get(target))) return true;
  }
  return false;
}

function buildPoiBatchId(payloadHash, baselineHash) {
  return `poi-batch-v2-${payloadHash.slice(0, 16)}-${baselineHash.slice(0, 16)}`;
}

function buildPoiCommitToken(payloadHash, baselineHash, baselineScope) {
  const encoded = Buffer.from(JSON.stringify({ v: 2, p: payloadHash, h: baselineHash, b: baselineScope })).toString('base64url');
  const signature = createHmac('sha256', PROFILE_ID_SECRET).update(`poi-commit-v2:${encoded}`).digest('hex');
  return `poi-commit-v2.${encoded}.${signature}`;
}

function parsePoiCommitToken(commitToken) {
  const match = /^poi-commit-v2\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(String(commitToken ?? ''));
  if (!match) return null;
  const expectedSignature = createHmac('sha256', PROFILE_ID_SECRET).update(`poi-commit-v2:${match[1]}`).digest('hex');
  if (!safeTokenEqual(match[2], expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (payload?.v !== 2 || !/^[a-f0-9]{64}$/.test(payload?.p) || !/^[a-f0-9]{64}$/.test(payload?.h) || !Array.isArray(payload?.b)) return null;
    if (fullContentHash(stableJsonStringify(payload.b)) !== payload.h) return null;
    return { payloadHash: payload.p, baselineHash: payload.h, baselineScope: payload.b };
  } catch {
    return null;
  }
}

async function listPoiBatchEnvelopes(limit = 50000) {
  return (await readJsonLines(POI_LOG_PATH, limit)).filter((row) => row?.kind === 'poi-batch' && Array.isArray(row.rows));
}

async function listOperationalPoiSnapshots() {
  const envelopes = (await listPoiBatchEnvelopes()).reverse();
  const latestById = new Map();
  for (const envelope of envelopes) {
    for (const row of envelope.rows) {
      const poiId = sanitizePublicId(row?.poiId || row?.id);
      if (poiId) latestById.set(poiId, row);
    }
  }
  return [...latestById.values()];
}

function seedPoiSnapshot(seed) {
  return {
    schemaVersion: 1,
    poiId: seed.poiId,
    city: seed.city,
    name: seed.name,
    aliases: seed.aliases ?? [],
    category: '',
    location: { lat: seed.lat, lng: seed.lng, address: '' },
    sourceKind: 'seed',
    sourceType: 'fallback',
    reviewStatus: 'pending',
    facts: [],
    evidence: [],
    audits: [],
    createdAt: '',
    updatedAt: '',
    batchId: ''
  };
}

// rank12②：seed + 运营合并 POI 目录的进程内缓存。以 pois.jsonl 的 (mtimeMs, size)
// 指纹失效；本进程 appendJsonLine 落 POI 批次时主动失效，外部直写靠指纹兜底。
// 同步加载（readFileSync）是为了让 findTrustedPoi/resolvePoiId 等同步调用链
// 也能读到运营 POI；文件仅在批次提交时增长，重建频率低。
const mergedPoiCache = { fingerprint: null, pois: null, trustedLookup: null, checkedAtMs: 0 };
const MERGED_POI_FINGERPRINT_TTL_MS = 2000;

function invalidateMergedPoiCache() {
  mergedPoiCache.fingerprint = null;
  mergedPoiCache.pois = null;
  mergedPoiCache.trustedLookup = null;
  mergedPoiCache.checkedAtMs = 0;
}

function poiLogFingerprintSync() {
  try {
    const stats = statSync(POI_LOG_PATH);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

function refreshMergedPoiCatalog() {
  const now = Date.now();
  if (mergedPoiCache.pois && now - mergedPoiCache.checkedAtMs < MERGED_POI_FINGERPRINT_TTL_MS) {
    return mergedPoiCache;
  }
  const fingerprint = poiLogFingerprintSync();
  mergedPoiCache.checkedAtMs = now;
  if (mergedPoiCache.pois && mergedPoiCache.fingerprint === fingerprint) return mergedPoiCache;
  const merged = new Map(TRUSTED_POI_CATALOG.map((seed) => [seed.poiId, seedPoiSnapshot(seed)]));
  if (existsSync(POI_LOG_PATH)) {
    let text = '';
    try {
      text = readFileSync(POI_LOG_PATH, 'utf8');
    } catch {
      text = '';
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const envelope = JSON.parse(line);
        if (envelope?.kind !== 'poi-batch' || !Array.isArray(envelope.rows)) continue;
        for (const row of envelope.rows) {
          const poiId = sanitizePublicId(row?.poiId || row?.id);
          if (poiId) merged.set(poiId, row);
        }
      } catch {
        // Skip corrupted historical JSONL rows.
      }
    }
  }
  mergedPoiCache.pois = [...merged.values()];
  mergedPoiCache.trustedLookup = buildTrustedPoiLookup(mergedPoiCache.pois);
  mergedPoiCache.fingerprint = fingerprint;
  return mergedPoiCache;
}

async function listMergedPois() {
  return refreshMergedPoiCatalog().pois;
}

// rank12①：把「运营已审核 POI」映射为 findTrustedPoi 可用的可信条目：
// location 事实映射为坐标，营业时间事实映射为 openHours。种子目录先建索引，
// 同名（同城规范化名称）时运营 approved 数据覆盖种子。
function buildTrustedPoiLookup(pois) {
  const lookup = new Map();
  const seedsById = new Map(TRUSTED_POI_CATALOG.map((seed) => [seed.poiId, seed]));
  const register = (entry) => {
    for (const name of [entry.name, ...(entry.aliases ?? [])]) {
      const normalizedName = normalizePoiName(name);
      if (normalizedName) lookup.set(`${entry.city}::${normalizedName}`, entry);
    }
  };
  for (const poi of pois ?? []) {
    if (poi?.sourceKind !== 'seed') continue;
    const seed = seedsById.get(poi.poiId);
    if (!seed) continue;
    register({
      poiId: seed.poiId,
      city: seed.city,
      name: seed.name,
      aliases: seed.aliases ?? [],
      lat: seed.lat,
      lng: seed.lng,
      openHours: seed.openHours,
      sourceKind: 'seed'
    });
  }
  for (const poi of pois ?? []) {
    if (poi?.sourceKind === 'seed' || poi?.reviewStatus !== 'approved') continue;
    register({
      poiId: poi.poiId,
      city: poi.city,
      name: poi.name,
      aliases: poi.aliases ?? [],
      lat: Number(poi?.location?.lat),
      lng: Number(poi?.location?.lng),
      openHours: operationalOpenHoursFromFacts(poi),
      sourceKind: 'operational'
    });
  }
  return lookup;
}

const POI_WEEKDAY_CHAR_MAP = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

// 只有能确定闭馆日（或明确全天开放）时才产出 openHours；无法判定时返回 undefined，
// 让营业时间校验如实报告「无数据」而不是虚构班表。
function operationalOpenHoursFromFacts(poi) {
  const facts = Array.isArray(poi?.facts) ? poi.facts : [];
  const fact = facts.find((item) =>
    item?.reviewStatus === 'approved' &&
    /开放时间|营业时间/.test(String(item?.field ?? '')) &&
    String(item?.value ?? '').trim()
  );
  if (!fact) return undefined;
  const value = String(fact.value);
  if (/全天|24\s*小时|不打烊|全年无休/.test(value)) {
    return { alwaysOpen: true, closedWeekdays: [], note: truncateString(value, 60) };
  }
  const closedWeekdays = new Set();
  const closurePattern = /(?:周|星期|礼拜)([日天一二三四五六])(?:\s*[至到~-]\s*(?:周|星期|礼拜)?([日天一二三四五六]))?\s*(?:闭馆|闭园|闭店|关闭|停业|歇业|休息|休馆|不开放)/g;
  let match;
  while ((match = closurePattern.exec(value)) !== null) {
    const start = POI_WEEKDAY_CHAR_MAP[match[1]];
    const end = match[2] != null ? POI_WEEKDAY_CHAR_MAP[match[2]] : start;
    if (start == null || end == null) continue;
    let day = start;
    for (let step = 0; step < 7; step += 1) {
      closedWeekdays.add(day);
      if (day === end) break;
      day = (day + 1) % 7;
    }
  }
  if (!closedWeekdays.size) return undefined;
  return { closedWeekdays: [...closedWeekdays].sort(), note: truncateString(value, 60) };
}

function summarizePoiValidationRows(rows) {
  const summary = { total: rows.length, new: 0, update: 0, unchanged: 0, conflict: 0, error: 0 };
  for (const row of rows) summary[row.status] = (summary[row.status] ?? 0) + 1;
  return summary;
}

async function validatePoiBatch(input = {}, { includeBaselineScope = false } = {}) {
  const { parsedRows } = parsePoiBatchRows(input);
  const existingById = new Map((await listMergedPois()).map((row) => [row.poiId, row]));
  const rows = parsedRows.map((parsed) => {
    if (parsed.parseError) {
      return { line: parsed.line, status: 'error', errors: [parsed.parseError], warnings: [], normalized: null };
    }
    const result = normalizeOperationalPoiRow(parsed.raw, parsed.line);
    if (result.errors.length || !result.normalized) return result;
    const existing = existingById.get(result.normalized.poiId);
    if (existing && (existing.city !== result.normalized.city || normalizePoiName(existing.name) !== normalizePoiName(result.normalized.name))) {
      result.status = 'conflict';
      result.errors.push(poiValidationIssue('POI_IDENTITY_CONFLICT', 'poiId', '该 POI ID 已绑定到不同城市或名称'));
      return result;
    }
    if (!existing) {
      result.status = 'new';
      return result;
    }
    const merged = mergeOperationalPoiSnapshot(existing, result.normalized);
    result.status = stableJsonStringify(comparablePoiSnapshot(merged)) === stableJsonStringify(comparablePoiSnapshot(existing))
      ? 'unchanged'
      : 'update';
    return result;
  });
  const rowsByPoiId = new Map();
  rows.forEach((row) => {
    const poiId = row.normalized?.poiId;
    if (!poiId) return;
    const matches = rowsByPoiId.get(poiId) ?? [];
    matches.push(row);
    rowsByPoiId.set(poiId, matches);
  });
  for (const [poiId, matches] of rowsByPoiId) {
    if (matches.length < 2) continue;
    for (const row of matches) {
      row.status = 'conflict';
      row.errors.push(poiValidationIssue('DUPLICATE_POI_ID', 'poiId', `批次内重复 POI ID：${poiId}`));
    }
  }
  const payloadHash = poiBatchPayloadHash(rows);
  const baselineScope = poiBatchScopedBaseline(rows, existingById);
  const baselineHash = fullContentHash(stableJsonStringify(baselineScope));
  const contentHash = fullContentHash(stableJsonStringify({ payloadHash, baselineHash }));
  const batchId = buildPoiBatchId(payloadHash, baselineHash);
  const commitToken = buildPoiCommitToken(payloadHash, baselineHash, baselineScope);
  const summary = summarizePoiValidationRows(rows);
  return {
    batchId,
    commitToken,
    contentHash,
    payloadHash,
    baselineHash,
    canCommit: rows.length > 0 && summary.error === 0 && summary.conflict === 0,
    summary,
    rows,
    ...(includeBaselineScope ? { baselineScope } : {})
  };
}

function dateValueEndTimestamp(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T15:59:59.999Z`);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isDerivedPoiSource(sourceType) {
  return ['derived', 'ai', 'fallback'].includes(sourceType);
}

function approvedEvidenceForFact(fact, evidenceById) {
  if (isDerivedPoiSource(fact?.sourceType)) return [];
  return (fact?.evidenceIds ?? [])
    .map((id) => evidenceById.get(id))
    .filter((evidence) => evidence?.reviewStatus === 'approved' &&
      !isDerivedPoiSource(evidence?.sourceType) &&
      Boolean(evidence?.url || evidence?.documentId) &&
      Number.isFinite(Date.parse(evidence?.capturedAt ?? '')));
}

function poiFactFreshnessState(fact, evidenceById, nowMs = Date.now()) {
  if (fact?.reviewStatus !== 'approved') return fact?.reviewStatus === 'rejected' ? 'rejected' : 'pending';
  if (!approvedEvidenceForFact(fact, evidenceById).length) return 'pending';
  const expiry = dateValueEndTimestamp(fact.validUntil);
  if (!Number.isFinite(expiry)) return 'pending';
  if (expiry < nowMs) return 'stale';
  if (expiry <= nowMs + POI_FACT_EXPIRING_SOON_DAYS * 86400000) return 'expiringSoon';
  return 'fresh';
}

function derivePoiOperationalState(poi, nowMs = Date.now()) {
  const evidenceById = new Map((poi.evidence ?? []).map((evidence) => [evidence.id, evidence]));
  const factStates = (poi.facts ?? []).map((fact) => ({
    fact,
    state: poi.reviewStatus === 'approved'
      ? poiFactFreshnessState(fact, evidenceById, nowMs)
      : fact?.reviewStatus === 'rejected' ? 'rejected' : 'pending'
  }));
  const counts = {
    totalFacts: factStates.length,
    freshFacts: factStates.filter((item) => item.state === 'fresh').length,
    expiringSoonFacts: factStates.filter((item) => item.state === 'expiringSoon').length,
    staleFacts: factStates.filter((item) => item.state === 'stale').length,
    pendingFacts: factStates.filter((item) => item.state === 'pending').length
  };
  const evidenceBacked = factStates.some((item) => item.fact.reviewStatus === 'approved' && approvedEvidenceForFact(item.fact, evidenceById).length > 0);
  const currentlyVerified = counts.freshFacts + counts.expiringSoonFacts > 0;
  const trustState = poi.reviewStatus === 'rejected'
    ? 'rejected'
    : poi.reviewStatus !== 'approved'
      ? 'pending'
      : currentlyVerified
        ? 'verified'
        : counts.staleFacts > 0
          ? 'stale'
          : 'collecting';
  const freshnessState = counts.freshFacts > 0
    ? 'fresh'
    : counts.expiringSoonFacts > 0
      ? 'expiringSoon'
      : counts.staleFacts > 0
        ? 'stale'
        : 'pending';
  return { ...counts, evidenceBacked, currentlyVerified, trustState, freshnessState };
}

function publicOperationalPoiView(poi, nowMs = Date.now()) {
  const state = derivePoiOperationalState(poi, nowMs);
  return {
    ...poi,
    ...state,
    pendingReview: poi.reviewStatus === 'pending'
  };
}

function nullablePercent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function summarizePoiCoverage(pois, city) {
  const totalPois = pois.length;
  const approvedPois = pois.filter((poi) => poi.reviewStatus === 'approved').length;
  const evidenceBackedPois = pois.filter((poi) => poi.reviewStatus === 'approved' && poi.evidenceBacked).length;
  const verifiedPois = pois.filter((poi) => poi.reviewStatus === 'approved' && poi.currentlyVerified).length;
  const totalFacts = pois.reduce((sum, poi) => sum + poi.totalFacts, 0);
  const freshFacts = pois.reduce((sum, poi) => sum + poi.freshFacts, 0);
  const expiringSoonFacts = pois.reduce((sum, poi) => sum + poi.expiringSoonFacts, 0);
  const staleFacts = pois.reduce((sum, poi) => sum + poi.staleFacts, 0);
  const pendingFacts = pois.reduce((sum, poi) => sum + poi.pendingFacts, 0);
  const pendingReview = pois.filter((poi) => poi.reviewStatus === 'pending').length;
  const trustStates = { verified: 0, collecting: 0, pending: 0, stale: 0, rejected: 0 };
  pois.forEach((poi) => { trustStates[poi.trustState] = (trustStates[poi.trustState] ?? 0) + 1; });
  return {
    city,
    totalPois,
    approvedPois,
    evidenceBackedPois,
    verifiedPois,
    totalFacts,
    freshFacts,
    expiringSoonFacts,
    staleFacts,
    pendingFacts,
    pendingReview,
    trustStates,
    approvedPercent: nullablePercent(approvedPois, totalPois),
    evidenceCoveragePercent: nullablePercent(evidenceBackedPois, totalPois),
    verifiedCoveragePercent: nullablePercent(verifiedPois, totalPois),
    currentFactPercent: nullablePercent(freshFacts + expiringSoonFacts, totalFacts)
  };
}

async function buildPoiCoverageSnapshot() {
  const snapshotAt = new Date().toISOString();
  const nowMs = Date.parse(snapshotAt);
  const pois = (await listMergedPois()).map((poi) => publicOperationalPoiView(poi, nowMs));
  const cities = OPERATIONAL_POI_CITIES.map((city) => summarizePoiCoverage(pois.filter((poi) => poi.city === city), city));
  const totals = summarizePoiCoverage(pois.filter((poi) => OPERATIONAL_POI_CITY_SET.has(poi.city)), '全部');
  return {
    snapshotAt,
    supportedCities: OPERATIONAL_POI_CITIES,
    cities,
    totals,
    rules: {
      expiringSoonDays: POI_FACT_EXPIRING_SOON_DAYS,
      verifiedCoverage: 'approved POI + approved non-derived evidence with URL/documentId and capturedAt + approved linked fact + unexpired validUntil',
      seedReviewStatus: 'pending'
    }
  };
}

// rank27⑥：锁外/锁内两处「同 batchId 重放」分支完全同构，抽出共用构造器。
function buildPoiBatchReplayResponse(envelope, submittedBatchId, validation, validationView) {
  const storedPayloadHash = envelope.payloadHash || envelope.contentHash;
  if (storedPayloadHash !== validation.payloadHash) {
    return { statusCode: 409, error: 'batchId 与提交内容不匹配', code: 'BATCH_ID_MISMATCH', ...validationView };
  }
  return {
    statusCode: 200,
    ok: true,
    batchId: submittedBatchId,
    contentHash: envelope.contentHash,
    payloadHash: storedPayloadHash,
    baselineHash: envelope.baselineHash || '',
    replayed: true,
    committedAt: envelope.committedAt,
    summary: envelope.summary,
    rows: validation.rows
  };
}

async function commitPoiBatch(input) {
  const validation = await validatePoiBatch(input, { includeBaselineScope: true });
  const {
    baselineScope: _currentBaselineScope,
    commitToken: _generatedCommitToken,
    ...validationView
  } = validation;
  if (!input?.batchId) {
    return { statusCode: 400, error: '提交批次必须携带 validate 返回的 batchId', code: 'BATCH_ID_REQUIRED', ...validationView };
  }
  if (!input?.commitToken) {
    return { statusCode: 400, error: '提交批次必须携带 validate 返回的 commitToken', code: 'COMMIT_TOKEN_REQUIRED', ...validationView };
  }
  const submittedBatchId = String(input.batchId);
  const batchToken = parsePoiCommitToken(input.commitToken);
  if (!batchToken) {
    return { statusCode: 409, error: 'commitToken 无效或已失效', code: 'COMMIT_TOKEN_INVALID', ...validationView };
  }
  if (submittedBatchId !== buildPoiBatchId(batchToken.payloadHash, batchToken.baselineHash) || batchToken.payloadHash !== validation.payloadHash) {
    return { statusCode: 409, error: 'batchId 与提交内容不匹配', code: 'BATCH_ID_MISMATCH', ...validationView };
  }
  const existingEnvelope = (await listPoiBatchEnvelopes()).find((row) => row.batchId === submittedBatchId);
  if (existingEnvelope) {
    return buildPoiBatchReplayResponse(existingEnvelope, submittedBatchId, validation, validationView);
  }
  return withSingleProcessKeyLock(poiCatalogMutationLocks, 'catalog', async () => {
    const replayEnvelope = (await listPoiBatchEnvelopes()).find((row) => row.batchId === submittedBatchId);
    if (replayEnvelope) {
      return buildPoiBatchReplayResponse(replayEnvelope, submittedBatchId, validation, validationView);
    }
    const lockedValidation = await validatePoiBatch(input, { includeBaselineScope: true });
    const {
      baselineScope: lockedBaselineScope,
      commitToken: _lockedGeneratedCommitToken,
      ...lockedValidationView
    } = lockedValidation;
    if (batchToken.payloadHash !== lockedValidation.payloadHash) {
      return { statusCode: 409, error: 'batchId 与提交内容不匹配', code: 'BATCH_ID_MISMATCH', ...lockedValidationView };
    }
    if (poiBatchBaselineIsStale(batchToken.baselineScope, lockedBaselineScope, poiBatchIncomingScope(lockedValidation.rows))) {
      return {
        statusCode: 409,
        error: '校验后 POI 目录已变更，请重新执行预检',
        code: 'POI_BATCH_STALE',
        replayed: false,
        ...lockedValidationView
      };
    }
    if (!lockedValidation.canCommit) {
      return { statusCode: 400, error: '批次包含错误或冲突，未写入任何数据', code: 'POI_BATCH_INVALID', replayed: false, ...lockedValidationView };
    }
    const existingById = new Map((await listOperationalPoiSnapshots()).map((row) => [row.poiId, row]));
    const committedAt = new Date().toISOString();
    const committedRows = lockedValidation.rows.map((row) => {
      const incoming = row.normalized;
      const existing = existingById.get(incoming.poiId);
      const merged = mergeOperationalPoiSnapshot(existing, incoming);
      const commitAudit = {
        id: stablePoiChildId('audit', incoming.poiId, { batchId: submittedBatchId, action: 'batch-upsert' }),
        action: 'batch-upsert',
        reviewStatus: incoming.reviewStatus,
        note: '',
        createdAt: committedAt,
        actorType: 'admin',
        source: 'batch-commit'
      };
      return {
        ...merged,
        schemaVersion: 1,
        sourceKind: 'operational',
        createdAt: existing?.createdAt || incoming.createdAt || committedAt,
        updatedAt: committedAt,
        batchId: submittedBatchId,
        audits: latestItemsById(merged.audits, [commitAudit])
      };
    });
    const contentHash = fullContentHash(stableJsonStringify({
      payloadHash: batchToken.payloadHash,
      baselineHash: batchToken.baselineHash
    }));
    const envelope = {
      kind: 'poi-batch',
      schemaVersion: 1,
      batchId: submittedBatchId,
      contentHash,
      payloadHash: batchToken.payloadHash,
      baselineHash: batchToken.baselineHash,
      committedAt,
      summary: lockedValidation.summary,
      rows: committedRows
    };
    await appendJsonLine(POI_LOG_PATH, envelope);
    return {
      statusCode: 200,
      ok: true,
      batchId: submittedBatchId,
      contentHash,
      payloadHash: batchToken.payloadHash,
      baselineHash: batchToken.baselineHash,
      replayed: false,
      committedAt,
      summary: lockedValidation.summary,
      rows: lockedValidation.rows
    };
  });
}

function normalizePoiName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s·•，。、“”‘’'"()（）\[\]【】_-]+/g, '')
    .replace(/景区|风景区$/g, '')
    .toLowerCase();
}

// rank12①：从只查 16 条硬编码种子改为查 seed + 运营合并目录（运营侧仅
// reviewStatus=approved 参与），coordinateForName/poiOpenHours/resolvePoiId
// 调用链随之继承运营 POI 的坐标与营业时间事实。
function findTrustedPoi(stop, city = '') {
  const cityName = truncateString(city || stop?.city, 40);
  if (!cityName) return null;
  const normalizedCity = normalizeCityName(cityName);
  const normalizedName = normalizePoiName(stop?.name || stop?.stopName);
  if (!normalizedName) return null;
  return refreshMergedPoiCatalog().trustedLookup.get(`${normalizedCity}::${normalizedName}`) ?? null;
}

function resolvePoiId(stop, city = '') {
  const normalizedName = normalizePoiName(stop?.name || stop?.stopName);
  if (!normalizedName) return sanitizePublicId(stop?.poiId);
  const trusted = findTrustedPoi(stop, city);
  if (trusted) return trusted.poiId;
  const cityName = truncateString(city || stop?.city, 40);
  const normalizedCity = cityName ? normalizeCityName(cityName) : '未知';
  return `poi-${hashText(`${normalizedCity}:${normalizedName}`)}`;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'trustScore', 'days', 'stops', 'assets', 'validations', 'metrics', 'logs'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    trustScore: { type: 'number' },
    days: { type: 'array', items: { type: 'string' } },
    stops: {
      type: 'array',
      minItems: 3,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'time', 'name', 'area', 'stay', 'cost', 'verify', 'risk', 'score', 'lat', 'lng', 'geoConfidence', 'coordinateSystem'],
        properties: {
          day: { type: 'string' },
          time: { type: 'string' },
          name: { type: 'string' },
          area: { type: 'string' },
          stay: { type: 'string' },
          cost: { type: 'string' },
          verify: { type: 'string' },
          risk: { type: 'string' },
          score: { type: 'number' },
          lat: { type: 'number' },
          lng: { type: 'number' },
          geoConfidence: { type: 'number' },
          coordinateSystem: { type: 'string' }
        }
      }
    },
    assets: {
      type: 'array',
      minItems: 3,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'type', 'confidence'],
        properties: {
          label: { type: 'string' },
          type: { type: 'string' },
          confidence: { type: 'number' }
        }
      }
    },
    validations: {
      type: 'array',
      minItems: 4,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'state', 'detail'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          state: { type: 'string' },
          detail: { type: 'string' }
        }
      }
    },
    metrics: {
      type: 'array',
      minItems: 4,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value'],
        properties: {
          label: { type: 'string' },
          value: { type: 'string' }
        }
      }
    },
    logs: {
      type: 'array',
      minItems: 4,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stage', 'input', 'result', 'status'],
        properties: {
          stage: { type: 'string' },
          input: { type: 'string' },
          result: { type: 'string' },
          status: { type: 'string' }
        }
      }
    }
  }
};

function assignRequestId(req, res) {
  const requestId = cryptoRandomId();
  req.requestId = requestId;
  res.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  return requestId;
}

function requestIdHeaders(res) {
  return res.requestId ? { 'x-request-id': res.requestId } : {};
}

function sendJson(res, statusCode, payload) {
  const responsePayload = res.requestId && payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload, requestId: res.requestId }
    : payload;
  const body = JSON.stringify(responsePayload);
  res.writeHead(statusCode, {
    ...securityHeaders(),
    ...requestIdHeaders(res),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function parseMapTilePath(pathname) {
  const match = String(pathname ?? '').match(/^\/api\/map-tiles\/(\d{1,2})\/(\d{1,10})\/(\d{1,10})\.png$/);
  if (!match) return null;
  const [, zText, xText, yText] = match;
  const z = Number(zText);
  const x = Number(xText);
  const y = Number(yText);
  if (!Number.isInteger(z) || z < 0 || z > 19) return null;
  const maxIndex = (2 ** z) - 1;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > maxIndex || y > maxIndex) return null;
  return { z, x, y, key: `${z}/${x}/${y}` };
}

function readCachedMapTile(key) {
  const cached = mapTileCache.get(key);
  if (!cached) return null;
  mapTileCache.delete(key);
  mapTileCache.set(key, cached);
  return cached;
}

function cacheMapTile(key, tile) {
  mapTileCache.delete(key);
  mapTileCache.set(key, tile);
  while (mapTileCache.size > MAP_TILE_CACHE_MAX_ENTRIES) {
    mapTileCache.delete(mapTileCache.keys().next().value);
  }
}

function sendMapTile(res, tile, cacheState) {
  res.writeHead(200, {
    ...securityHeaders(),
    ...requestIdHeaders(res),
    'content-type': tile.contentType,
    'content-length': tile.body.length,
    'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    'x-map-tile-cache': cacheState,
    'x-map-tile-source': tile.source
  });
  res.end(tile.body);
}

function requestMapTileUpstream(upstream, tileRequest, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    const request = httpsRequest({
      protocol: 'https:',
      hostname: upstream.hostname,
      port: 443,
      method: 'GET',
      path: upstream.path(tileRequest.key),
      signal,
      headers: {
        accept: 'image/png,image/*;q=0.8,*/*;q=0.5',
        'user-agent': 'TrustedRoutebook/0.1 (+local map tile proxy)'
      }
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        rejectPromise(createHttpError(`地图上游返回 HTTP ${statusCode}`, 502, 'MAP_TILE_UPSTREAM_ERROR'));
        return;
      }
      if (declaredLength > MAP_TILE_MAX_BYTES) {
        response.destroy();
        rejectPromise(createHttpError('地图瓦片响应过大', 502, 'MAP_TILE_TOO_LARGE'));
        return;
      }
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAP_TILE_MAX_BYTES) {
          response.destroy(createHttpError('地图瓦片响应过大', 502, 'MAP_TILE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        if (!body.length) {
          rejectPromise(createHttpError('地图瓦片内容无效', 502, 'MAP_TILE_INVALID'));
          return;
        }
        const upstreamType = String(response.headers['content-type'] ?? '');
        resolvePromise({
          body,
          contentType: upstreamType.startsWith('image/') ? upstreamType : 'image/png',
          source: upstream.id
        });
      });
      response.on('error', rejectPromise);
    });
    request.setTimeout(MAP_TILE_UPSTREAM_TIMEOUT_MS, () => {
      request.destroy(createHttpError('地图上游连接超时', 504, 'MAP_TILE_UPSTREAM_TIMEOUT'));
    });
    request.on('error', rejectPromise);
    request.end();
  });
}

async function handleMapTile(req, res, url) {
  const tileRequest = parseMapTilePath(url.pathname);
  if (!tileRequest) throw createHttpError('地图瓦片路径不合法', 400, 'INVALID_MAP_TILE');

  const cached = readCachedMapTile(tileRequest.key);
  if (cached) return sendMapTile(res, cached, 'HIT');

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MAP_TILE_TIMEOUT_MS);
  req.once('aborted', () => controller.abort());
  try {
    let tile = null;
    let lastError = null;
    for (const upstream of MAP_TILE_UPSTREAMS) {
      try {
        tile = await requestMapTileUpstream(upstream, tileRequest, controller.signal);
        break;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = error;
      }
    }
    if (!tile) throw lastError || createHttpError('地图底图暂时不可用', 502, 'MAP_TILE_UNAVAILABLE');
    cacheMapTile(tileRequest.key, tile);
    return sendMapTile(res, tile, 'MISS');
  } catch (error) {
    if (req.aborted || res.destroyed) return undefined;
    if (error.name === 'AbortError' && timedOut) throw createHttpError('地图底图请求超时', 504, 'MAP_TILE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function createHttpError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// 路由参数解码：非法百分号序列（如 %zz）会让 decodeURIComponent 抛
// URIError 并被兜底成 500，这里统一转成 400 BAD_PATH。
function safeDecodePathSegment(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    throw createHttpError('请求路径编码不合法', 400, 'BAD_PATH');
  }
}

function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

function hmacText(value, secret = PROFILE_ID_SECRET) {
  return createHmac('sha256', String(secret || 'trusted-routebook')).update(String(value ?? '')).digest('hex').slice(0, 18);
}

function hashSecretToken(value) {
  const token = sanitizeEditToken(value);
  return token ? hmacText(token, `${PROFILE_ID_SECRET}:profile-token`) : '';
}

function guideLogMeta(payload) {
  const guide = String(payload?.guide ?? '');
  return {
    inputHash: hashText(guide),
    inputLength: guide.length,
    sourceCount: payload?.importedSources?.length ?? 0
  };
}

async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const bodyLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_JSON_BODY_BYTES;
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) {
    throw createHttpError('请求 Content-Type 必须是 application/json', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
    throw createHttpError('请求体过大', 413, 'PAYLOAD_TOO_LARGE');
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.byteLength;
    if (totalBytes > bodyLimit) {
      throw createHttpError('请求体过大', 413, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw createHttpError('请求体不是合法 JSON', 400, 'BAD_JSON');
  }
}

function stripQuotes(value) {
  return value?.replace(/^["']|["']$/g, '').trim();
}

function parseCodexConfig(text) {
  const config = {
    modelProvider: 'openai',
    model: DEFAULT_MODEL,
    providers: {}
  };
  let section = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!keyMatch) continue;

    const [, key, rawValue] = keyMatch;
    const value = stripQuotes(rawValue);
    if (!section) {
      if (key === 'model_provider') config.modelProvider = value;
      if (key === 'model') config.model = value;
      continue;
    }

    const providerMatch = section.match(/^model_providers\.([A-Za-z0-9_-]+)$/);
    if (providerMatch) {
      const providerName = providerMatch[1];
      config.providers[providerName] ??= {};
      config.providers[providerName][key] = value;
    }
  }

  return config;
}

async function loadCodexRuntime() {
  const configText = existsSync(CODEX_CONFIG_PATH) ? await readFile(CODEX_CONFIG_PATH, 'utf8') : '';
  const codexConfig = parseCodexConfig(configText);
  const providerName = process.env.AI_PROVIDER ?? codexConfig.modelProvider ?? 'yinyue';
  const provider = codexConfig.providers[providerName] ?? {};
  let auth = {};
  if (existsSync(CODEX_AUTH_PATH)) {
    try {
      auth = JSON.parse(await readFile(CODEX_AUTH_PATH, 'utf8'));
    } catch {
      auth = {};
    }
  }

  const baseUrl = process.env.OPENAI_BASE_URL ?? provider.base_url;
  const apiKey = process.env.OPENAI_API_KEY ?? auth.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL ?? codexConfig.model ?? DEFAULT_MODEL;
  const wireApi = process.env.OPENAI_WIRE_API ?? provider.wire_api ?? 'responses';
  const supportedWireApis = new Set(['responses', 'chat_completions']);
  const supportsWireApi = supportedWireApis.has(wireApi);

  return {
    providerName,
    model,
    wireApi,
    baseUrl,
    apiKey,
    ready: Boolean(baseUrl && apiKey && supportsWireApi),
    readyReason: supportsWireApi ? '' : `暂不支持 wire_api=${wireApi}`,
    configPath: CODEX_CONFIG_PATH,
    authPath: CODEX_AUTH_PATH
  };
}

function openAiEndpoint(baseUrl, wireApi) {
  let trimmed = '';
  try {
    trimmed = new URL(baseUrl).toString().replace(/\/+$/, '');
  } catch {
    throw createHttpError('OPENAI_BASE_URL 不是合法 URL', 503, 'BAD_BASE_URL');
  }
  const path = wireApi === 'chat_completions' ? 'chat/completions' : 'responses';
  return trimmed.endsWith('/v1') ? `${trimmed}/${path}` : `${trimmed}/v1/${path}`;
}

function redactBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '[configured]';
  }
}

function isLocalAddress(address) {
  const normalized = normalizeRemoteAddress(address);
  if (!normalized) return false;
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function normalizeRemoteAddress(address) {
  const value = String(address ?? '').trim();
  if (!value) return '';
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length);
  return value;
}

function ipv4ToNumber(address) {
  const parts = String(address ?? '').split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    result = (result << 8) + value;
  }
  return result >>> 0;
}

function ipv4MatchesCidr(address, cidr) {
  const [range, prefixText = '32'] = String(cidr ?? '').split('/');
  const addressNumber = ipv4ToNumber(address);
  const rangeNumber = ipv4ToNumber(range);
  const prefix = Number(prefixText);
  if (addressNumber == null || rangeNumber == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressNumber & mask) === (rangeNumber & mask);
}

function isTrustedProxyAddress(address) {
  const normalized = normalizeRemoteAddress(address);
  if (!normalized) return false;
  return TRUSTED_PROXY_CIDRS.some((entry) => {
    if (entry.includes('/')) return ipv4MatchesCidr(normalized, entry);
    return normalizeRemoteAddress(entry) === normalized;
  });
}

// Proxies append to X-Forwarded-For, so the leftmost hop is attacker-controlled.
// Walk from the right and stop at the first address that is not a known proxy.
function forwardedClientAddress(req) {
  const chain = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxyAddress(chain[index])) return chain[index];
  }
  return '';
}

function hasForwardedChain(req) {
  return Boolean(String(req.headers['x-forwarded-for'] ?? '').trim());
}

function shouldTrustProxyHeaders(req) {
  return TRUST_PROXY_HEADERS && isTrustedProxyAddress(req.socket.remoteAddress);
}

// Local-only bypasses must never be derived from a request header. Behind a
// same-host reverse proxy every request arrives from 127.0.0.1, so a forwarded
// chain is proof the client is remote regardless of what the header claims.
function isLocalRequest(req) {
  if (shouldTrustProxyHeaders(req) && hasForwardedChain(req)) return false;
  return isLocalAddress(req.socket.remoteAddress);
}

function requestClientKey(req) {
  if (shouldTrustProxyHeaders(req)) {
    const forwardedFor = forwardedClientAddress(req);
    if (forwardedFor) return forwardedFor;
  }
  return req.socket.remoteAddress || 'unknown';
}

function verifyApiAccess(req) {
  if (isLocalRequest(req) && ALLOW_LOCAL_API_BYPASS) return;

  const providedToken = String(req.headers['x-routebook-token'] ?? '').trim();
  if (!PUBLIC_MODEL_PROXY_ALLOWED || !safeTokenEqual(providedToken, API_TOKEN)) {
    throw createHttpError('API 仅允许本机访问；如需公开暴露请显式配置访问令牌', 403, 'LOCAL_ONLY');
  }
}

function verifyAdminAccess(req) {
  if (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) return;

  const providedToken = String(req.headers['x-routebook-admin-token'] ?? '').trim();
  if (!safeTokenEqual(providedToken, ADMIN_API_TOKEN)) {
    throw createHttpError('需要运营管理员令牌', 403, 'ADMIN_TOKEN_REQUIRED');
  }
}

function hasAdminAccess(req) {
  try {
    verifyAdminAccess(req);
    return true;
  } catch {
    return false;
  }
}

function verifySensitiveReadAccess(req) {
  if (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) return;
  verifyAdminAccess(req);
}

async function verifyProfileReadAccess(req, profileId) {
  const id = normalizeProfileId(profileId);
  if (!id || id === 'anonymous') return false;
  if (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) return true;
  if (hasAdminAccess(req)) return true;
  const headerProfileId = normalizeProfileId(req.headers['x-routebook-profile-id']);
  const token = sanitizeEditToken(req.headers['x-routebook-profile-token']);
  if (headerProfileId !== id || !token) return false;
  const profile = await getSavedProfile(id);
  return safeTokenEqual(hashSecretToken(token), profile?.accessTokenHash);
}

async function resolveWriteProfile(req, requestedProfileId, { requireRegistered = false } = {}) {
  const profileId = normalizeProfileId(requestedProfileId);
  if (!profileId || profileId === 'anonymous') {
    return { profileId: 'anonymous', verified: false, identityBound: false };
  }
  const profile = await getSavedProfile(profileId);
  if (await verifyProfileReadAccess(req, profileId)) {
    return { profileId, verified: true, identityBound: profile?.identityBound === true };
  }
  if (profile) {
    throw createHttpError('写入该用户数据需要 profile token', 403, 'PROFILE_TOKEN_REQUIRED');
  }
  // requireRegistered（目前仅打卡使用）：未注册 profile 不再静默降级为
  // anonymous——降级会让客户端误以为打卡已计入个人主页与可信分。
  if (requireRegistered) {
    throw createHttpError('该 profile 尚未在服务端注册，请先同步或重建个人资料后再打卡', 403, 'PROFILE_NOT_REGISTERED');
  }
  return { profileId: 'anonymous', verified: false, identityBound: false };
}

async function verifySensitiveOrProfileReadAccess(req, profileId) {
  if (profileId && await verifyProfileReadAccess(req, profileId)) return;
  verifySensitiveReadAccess(req);
}

// rank9：写限流分桶。埋点（exposures/clicks）超限静默 204；AI 类沿用原低配额；
// 核心写（checkins/favorites/reviews/routebooks 及其子路由）独立配额；
// 其余写与未标注类别的调用沿用默认配额。桶按「客户端 key + 类别」隔离。
function rateLimitQuotaForCategory(category) {
  switch (category) {
    case 'telemetry': return RATE_LIMIT_TELEMETRY_MAX;
    case 'core-write': return RATE_LIMIT_CORE_WRITE_MAX;
    case 'map-tile': return RATE_LIMIT_MAP_TILE_MAX;
    case 'public-read': return RATE_LIMIT_PUBLIC_READ_MAX;
    case 'ai':
    default: return RATE_LIMIT_MAX;
  }
}

function sweepExpiredRateLimitBuckets(now) {
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(key);
  }
}

function consumeRateLimit(req, category = 'default') {
  const key = `${requestClientKey(req)}::${category}`;
  const now = Date.now();
  // 桶数量超阈值时惰性清理过期条目，防止长期运行下 Map 无界增长。
  if (rateLimitBuckets.size > RATE_LIMIT_BUCKET_SWEEP_SIZE) sweepExpiredRateLimitBuckets(now);
  const bucket = rateLimitBuckets.get(key) ?? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return bucket.count <= rateLimitQuotaForCategory(category);
}

function enforceRateLimit(req, category = 'default') {
  if (!consumeRateLimit(req, category)) {
    throw createHttpError('请求过于频繁，请稍后再试', 429, 'RATE_LIMITED');
  }
}

// rank9：埋点超限的静默响应。丢弃未读请求体以保持连接可复用，返回空 204。
function sendTelemetryThrottled(req, res) {
  req.resume();
  res.writeHead(204, {
    ...securityHeaders(),
    ...requestIdHeaders(res)
  });
  res.end();
}

function bindRequestAbortSignal(req) {
  const controller = new AbortController();
  req.on('close', () => {
    if (!req.complete) controller.abort();
  });
  return controller.signal;
}

const SOURCE_PLATFORMS = [
  {
    id: 'xiaohongshu',
    name: '小红书',
    hosts: ['xiaohongshu.com', 'xhslink.com'],
    baseScore: 72,
    note: 'UGC 种草内容强，需重点复核闭店、价格、排队和商业合作痕迹。'
  },
  {
    id: 'douyin',
    name: '抖音',
    hosts: ['douyin.com', 'iesdouyin.com'],
    baseScore: 68,
    note: '短视频时效强但上下文少，需复核发布时间、定位和是否为团购引流。'
  },
  {
    id: 'x',
    name: 'X',
    hosts: ['x.com', 'twitter.com', 't.co'],
    baseScore: 62,
    note: '适合发现即时反馈，但旅行攻略结构弱，需与地图和近期打卡交叉验证。'
  }
];

function extractUrls(text) {
  const matches = String(text ?? '').match(/https?:\/\/[^\s"'<>，。；、)）]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;!?]+$/, '')))].slice(0, MAX_IMPORT_URLS);
}

function detectPlatform(url) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return {
      id: 'invalid',
      name: '无效链接',
      baseScore: 20,
      note: '链接格式无法解析。'
    };
  }
  return SOURCE_PLATFORMS.find((platform) =>
    platform.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  ) ?? {
    id: 'web',
    name: hostname,
    baseScore: 58,
    note: '普通公开网页，可信度取决于页面可访问性、发布时间和内容完整度。'
  };
}

function isPrivateIp(address) {
  const value = String(address ?? '');
  if (!value) return true;
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7));
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    return parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
      parts[0] >= 224 ||
      parts[0] === 0;
  }
	  if (isIP(value) === 6) {
	    const lower = value.toLowerCase();
    const firstHextet = Number.parseInt(lower.split(':')[0] || '0', 16);
	    return lower === '::' ||
	      lower.startsWith('fc') ||
	      lower.startsWith('fd') ||
      (Number.isFinite(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
	      lower.startsWith('ff') ||
	      lower.startsWith('2001:db8:');
	  }
  return true;
}

async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw createHttpError('链接格式不合法', 400, 'BAD_SOURCE_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw createHttpError('只支持 http/https 链接', 400, 'UNSUPPORTED_URL_PROTOCOL');
  }
  if (!url.hostname || url.username || url.password) {
    throw createHttpError('链接不能包含认证信息', 400, 'UNSAFE_SOURCE_URL');
  }

  await resolvePublicHttpEndpoint(url);
  return url;
}

function hostnameForLookup(hostname) {
  return String(hostname ?? '').replace(/^\[|\]$/g, '');
}

async function resolvePublicHttpEndpoint(url) {
  const hostname = hostnameForLookup(url.hostname);
  const literalIpVersion = isIP(hostname);
  const records = literalIpVersion
    ? [{ address: hostname, family: literalIpVersion }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw createHttpError('链接目标不可访问或不是公网地址', 400, 'UNSAFE_SOURCE_URL');
  }
  return records[0];
}

async function assertPublicHttpResponseUrl(responseUrl) {
  try {
    return await assertPublicHttpUrl(responseUrl);
  } catch {
    throw createHttpError('链接重定向到非公网地址，已停止抓取', 400, 'UNSAFE_SOURCE_REDIRECT');
  }
}

function getResponseHeader(headers, name) {
  const value = headers?.[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requestPinnedPublicUrl(url, endpoint, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port || (isHttps ? 443 : 80));
    const headers = {
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
      'user-agent': 'TrustedRoutebookBot/0.1 (+local MVP; public metadata import)',
      host: url.host
    };
    const options = {
      protocol: url.protocol,
      hostname: endpoint.address,
      family: endpoint.family,
      port,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      signal
    };
    if (isHttps) {
      options.servername = hostnameForLookup(url.hostname);
      options.checkServerIdentity = (_hostname, cert) => checkServerIdentity(hostnameForLookup(url.hostname), cert);
    }

    const chunks = [];
    let total = 0;
    let responseMeta = null;
    let settled = false;

    const finish = () => {
      if (settled || !responseMeta) return;
      settled = true;
      resolvePromise({
        status: responseMeta.statusCode ?? 0,
        ok: (responseMeta.statusCode ?? 0) >= 200 && (responseMeta.statusCode ?? 0) < 300,
        headers: responseMeta.headers ?? {},
        url: url.toString(),
        html: Buffer.concat(chunks).toString('utf8'),
        fetchedBytes: total
      });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    const request = requester(options, (response) => {
      responseMeta = response;
      response.on('data', (chunk) => {
        if (settled) return;
        const remaining = MAX_IMPORT_PAGE_BYTES - total;
        if (remaining <= 0) {
          response.destroy();
          finish();
          return;
        }
        if (chunk.byteLength > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
          response.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      });
      response.on('end', finish);
      response.on('close', () => {
        if (total >= MAX_IMPORT_PAGE_BYTES) finish();
      });
      response.on('error', fail);
    });

    request.on('error', fail);
    request.end();
  });
}

async function fetchPublicPageResponse(url, signal, redirectCount = 0) {
  if (redirectCount > 5) {
    throw createHttpError('链接重定向次数过多', 400, 'SOURCE_TOO_MANY_REDIRECTS');
  }
  const safeUrl = await assertPublicHttpUrl(url);
  const endpoint = await resolvePublicHttpEndpoint(safeUrl);
  const response = await requestPinnedPublicUrl(safeUrl, endpoint, signal);
  if (response.status >= 300 && response.status < 400) {
    const location = getResponseHeader(response.headers, 'location');
    if (!location) throw createHttpError(`公开页面返回 HTTP ${response.status}`, 502, 'SOURCE_FETCH_FAILED');
    const nextUrl = await assertPublicHttpResponseUrl(new URL(location, safeUrl).toString());
    return fetchPublicPageResponse(nextUrl, signal, redirectCount + 1);
  }
  return response;
}

function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i');
  const match = html.match(pattern);
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? '').trim();
}

function extractTitle(html) {
  return extractMeta(html, 'og:title') ||
    decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
}

function extractDescription(html) {
  return extractMeta(html, 'description') ||
    extractMeta(html, 'og:description') ||
    extractMeta(html, 'twitter:description');
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function scoreImportedSource({ platform, status, title, description, text, fetchedBytes }) {
  let score = platform.baseScore;
  const signals = [];
  const warnings = [];

  if (status === 'fetched') {
    score += 8;
    signals.push('公开页面可访问');
  } else {
    score -= 14;
    warnings.push('页面未能公开抓取，需用户粘贴正文或截图描述');
  }
  if (title) {
    score += 4;
    signals.push('标题可解析');
  }
  if (description) {
    score += 6;
    signals.push('摘要可解析');
  }
  if (text.length > 900) {
    score += 5;
    signals.push('正文信息较完整');
  } else if (text.length < 160) {
    score -= 8;
    warnings.push('正文太短，可能只有分享页元数据');
  }
  if (/广告|赞助|团购|佣金|推广|合作/.test(`${title} ${description} ${text}`)) {
    score -= 8;
    warnings.push('疑似商业推广，需要降低采信权重');
  }
  if (/闭店|暂停|排队|涨价|预约|限流|维护/.test(`${title} ${description} ${text}`)) {
    signals.push('包含风险/限制信号');
  }
  if (fetchedBytes >= MAX_IMPORT_PAGE_BYTES * 0.95) {
    warnings.push('页面内容被截断，仅分析前半部分');
  }
  warnings.push(platform.note);

  return {
    score: clampNumber(score, 20, 94, 58),
    signals: signals.length ? signals : ['仅完成链接来源识别'],
    warnings
  };
}

async function fetchPublicPage(url, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await fetchPublicPageResponse(url, controller.signal);
    const contentType = String(getResponseHeader(response.headers, 'content-type') ?? '').toLowerCase();
    if (!response.ok) {
      throw createHttpError(`公开页面返回 HTTP ${response.status}`, 502, 'SOURCE_FETCH_FAILED');
    }
    await assertPublicHttpResponseUrl(response.url);
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw createHttpError('链接不是可分析的文本页面', 415, 'SOURCE_NOT_TEXT');
    }

    return { html: response.html, fetchedBytes: response.fetchedBytes, finalUrl: response.url };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function analyzeSourceUrl(rawUrl, signal) {
  const platform = detectPlatform(rawUrl);
  const url = await assertPublicHttpUrl(rawUrl);
  let fetched = null;
  let fetchError = '';
  try {
    fetched = await fetchPublicPage(url, signal);
  } catch (error) {
    fetchError = error.message ?? '页面无法公开抓取';
  }

  const html = fetched?.html ?? '';
  const title = extractTitle(html).slice(0, 120);
  const description = extractDescription(html).slice(0, 260);
  const text = stripHtmlToText(html).slice(0, 2800);
  const analysis = scoreImportedSource({
    platform,
    status: fetched ? 'fetched' : 'metadata-only',
    title,
    description,
    text,
    fetchedBytes: fetched?.fetchedBytes ?? 0
  });

  return {
    url: rawUrl,
    finalUrl: fetched?.finalUrl ?? url.toString(),
    platform: platform.name,
    platformId: platform.id,
    status: fetched ? 'fetched' : 'metadata-only',
    title: title || `${platform.name} 分享链接`,
    description,
    excerpt: text.slice(0, 700),
    trustScore: analysis.score,
    signals: analysis.signals,
    warnings: fetchError ? [fetchError, ...analysis.warnings] : analysis.warnings,
    fetchedAt: new Date().toISOString()
  };
}

function systemPrompt() {
  return [
    '你是 AI 可信路书平台的路线编排引擎。',
    '目标不是写泛攻略，而是把用户输入的分散攻略/需求变成可执行、可编辑、可验证的地图路书。',
    '只返回 JSON，不返回 Markdown。',
	    '路线必须服务 MVP 闭环：攻略导入、POI 提取、分日路书、可执行校验、行中打卡反哺可信分、商业点击验证。',
	    '不要搬运第三方攻略原文；只提取 POI、约束、风险、执行顺序和验证理由。',
    '如果用户提供小红书、抖音、X 或普通网页链接，只能基于公开可访问信息和用户粘贴内容分析；不能假设已绕过登录墙或反爬。',
    '必须显式降低低可信来源、商业推广、过时信息、仅元数据页面的权重，并把需要复核的事实写入 validations 或 stop.risk。',
	    '支持中国大陆和港澳台常见旅行目的地；热门城市可直接使用城市中心，非热门城市必须基于用户攻略和地点线索生成，并显式提示需要复核定位。',
    '每个 stop 必须包含 0-100 的 score，以及真实地图可用的 lat/lng。',
    'lat/lng 使用 WGS84，经纬度必须落在对应城市附近；无法精确定位时返回街区级近似坐标并降低 geoConfidence。',
    '每个 stop 的 coordinateSystem 固定返回 WGS84，geoConfidence 为 0-100。',
	    'validations 必须覆盖开放时间、步行强度、预算风险、拥挤风险。',
	    'logs 必须体现链接导入、来源可信度分析、POI 提取、约束过滤、路线编排、可执行校验。',
	    '如果输入携带 approvedPoiCandidates（运营已审核 POI 候选），优先从候选中选点并直接使用候选给出的坐标与营业时间；不在候选中的自创点位必须显式降低 geoConfidence（<60）并在 stop.risk 标注需实地复核。'
	  ].join('\n');
	}

// rank12③：按目标城市注入 top-N 已审核运营 POI 候选（紧凑单行格式），
// 让生成结果优先复用运营核验过的坐标/营业时间/停留建议。
const MAX_PROMPT_POI_CANDIDATES = 40;

function approvedFactValue(poi, fieldPattern) {
  const fact = (Array.isArray(poi?.facts) ? poi.facts : []).find((item) =>
    item?.reviewStatus === 'approved' && fieldPattern.test(String(item?.field ?? '')) && String(item?.value ?? '').trim()
  );
  return fact ? truncateString(fact.value, 60) : '';
}

function buildApprovedPoiPromptCandidates(city) {
  const normalizedCity = normalizeCityName(city);
  const candidates = [];
  for (const poi of refreshMergedPoiCatalog().pois) {
    if (candidates.length >= MAX_PROMPT_POI_CANDIDATES) break;
    if (poi?.sourceKind === 'seed' || poi?.reviewStatus !== 'approved' || poi?.city !== normalizedCity) continue;
    const lat = Number(poi?.location?.lat);
    const lng = Number(poi?.location?.lng);
    const parts = [
      truncateString(poi?.name, 48),
      isValidCoordinate(lat, lng) ? `坐标:${lat.toFixed(6)},${lng.toFixed(6)}` : '坐标:未核验',
      `开放:${approvedFactValue(poi, /开放时间|营业时间/) || '未知'}`,
      `建议停留:${approvedFactValue(poi, /建议停留|停留时长|停留/) || '未知'}`,
      `适合:${approvedFactValue(poi, /适合人群|人群/) || '不限'}`
    ];
    if (!parts[0]) continue;
    candidates.push(parts.join('|'));
  }
  return candidates;
}

function truncateString(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeCityName(value) {
  const city = truncateString(value, 40).replace(/市$/u, '');
  if (!city) return '杭州';
  if (!/^[\p{Script=Han}A-Za-z0-9·.\-\s]+$/u.test(city)) {
    throw createHttpError('目的地城市名称包含不支持的字符', 400, 'BAD_CITY');
  }
  return city;
}

function sanitizePayload(payload) {
  const constraints = payload?.constraints ?? {};
  const city = normalizeCityName(payload?.city);
  const guide = truncateString(payload?.guide, MAX_GUIDE_CHARS);
  if (!guide) {
    throw createHttpError('请先输入攻略、链接或旅行需求', 400, 'GUIDE_REQUIRED');
  }
  if (String(payload?.guide ?? '').length > MAX_GUIDE_CHARS) {
    throw createHttpError(`攻略内容不能超过 ${MAX_GUIDE_CHARS} 字`, 413, 'GUIDE_TOO_LONG');
  }

  return {
    city,
    profileId: normalizeProfileId(payload?.profileId),
    editToken: sanitizeEditToken(payload?.editToken),
    guide,
    importedSources: normalizeImportedSources(payload?.importedSources),
    constraints: {
      duration: truncateString(constraints.duration, 30) || '2 天 1 晚',
      budget: truncateString(constraints.budget, 30) || '人均 900',
      tempo: truncateString(constraints.tempo, 30) || '松弛但不空',
      companion: truncateString(constraints.companion, 30) || '朋友',
      date: truncateString(constraints.date, 30),
      base: truncateString(constraints.base, 80),
      transport: truncateString(constraints.transport, 60),
      theme: truncateString(constraints.theme, 120),
      mustGo: truncateString(constraints.mustGo, 120),
      avoid: truncateString(constraints.avoid, 120)
    }
  };
}

function normalizeImportedSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, MAX_IMPORT_URLS).map((source) => {
    const normalized = {
      url: safeSourceUrl(source?.url),
      finalUrl: safeSourceUrl(source?.finalUrl),
      platform: truncateString(source?.platform, 40),
      platformId: truncateString(source?.platformId, 40),
      status: truncateString(source?.status, 30),
      title: truncateString(source?.title, 120),
      description: truncateString(source?.description, 260),
      excerpt: truncateString(source?.excerpt, 700),
      trustScore: clampNumber(source?.trustScore, 0, 100, 20),
      signals: Array.isArray(source?.signals) ? source.signals.slice(0, 5).map((item) => truncateString(item, 80)) : [],
      warnings: Array.isArray(source?.warnings) ? source.warnings.slice(0, 5).map((item) => truncateString(item, 100)) : [],
      fetchedAt: truncateString(source?.fetchedAt, 60),
      proof: String(source?.proof ?? '').trim().toLowerCase()
    };
    if (hasValidImportedSourceProof(normalized)) return normalized;
    return {
      ...normalized,
      trustScore: Math.min(20, normalized.trustScore),
      proof: '',
      warnings: [...new Set([...normalized.warnings, '来源可信度未由服务端签名'])].slice(0, 5)
    };
  }).filter((source) => source.url || source.excerpt || source.title);
}

function userPrompt(payload) {
  const constraints = payload.constraints ?? {};
  return JSON.stringify(
    {
      city: payload.city,
      guide: payload.guide,
	      constraints: {
	        duration: constraints.duration ?? '2 天 1 晚',
	        budget: constraints.budget ?? '人均 900',
	        tempo: constraints.tempo ?? '松弛但不空',
	        companion: constraints.companion ?? '朋友',
	        date: constraints.date ?? '',
	        base: constraints.base ?? '',
	        transport: constraints.transport ?? '',
	        theme: constraints.theme ?? '',
	        mustGo: constraints.mustGo ?? '',
	        avoid: constraints.avoid ?? ''
	      },
      importedSources: payload.importedSources ?? [],
      // rank12③：运营已审核 POI 候选（名称|坐标|开放|建议停留|适合），无候选时省略。
      ...(Array.isArray(payload.poiCandidates) && payload.poiCandidates.length
        ? { approvedPoiCandidates: payload.poiCandidates }
        : {}),
      sourcePolicy: [
        'importedSources 是公开链接导入与可信度分析结果，不代表平台已验证全部事实。',
        '优先使用 trustScore 高、status=fetched、signals 多的来源；对 warnings 中的商业推广、页面不可抓取、正文过短等信号降权。',
        '不要复制原攻略文字；只提炼地点、时间、预算、风险、适合人群和验证理由。',
        '如果链接只能拿到元数据，必须在 stop.verify 或 validations 里提示“需用户补充原文/出发前复核”。',
        '个人攻略必须服从用户 constraints，而不是照搬任一平台作者路线。'
      ],
	      requiredOutputShape: RESPONSE_SCHEMA
	    },
    null,
    2
  );
}

function extractTextFromResponse(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') chunks.push(content.text);
    }
  }
  const chatContent = data.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string') chunks.push(chatContent);
  if (Array.isArray(chatContent)) {
    for (const content of chatContent) {
      if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

function parseJsonFromText(text) {
  if (!text) throw new Error('模型没有返回文本');
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('模型返回中没有可解析 JSON');
    return JSON.parse(match[0]);
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function coordinateForName(name, city = '') {
  const trusted = findTrustedPoi({ name }, city);
  // 运营 POI 可能缺 location 事实：坐标不合法时不作为可信坐标源。
  if (!trusted || !isValidCoordinate(Number(trusted.lat), Number(trusted.lng))) return null;
  return {
    lat: trusted.lat,
    lng: trusted.lng,
    fallback: false,
    source: 'known-poi',
    precision: 'exact',
    confidence: 88,
    radiusMeters: 0,
    navigationDisabled: false
  };
}

function fallbackCoordinate(city, index) {
  const region = getRegionForCity(city);
  const center = CITY_CENTERS[city] ?? regionCenters[region] ?? CHINA_CENTER;
  return {
    lat: Number(center.lat.toFixed(6)),
    lng: Number(center.lng.toFixed(6)),
    fallback: true,
    source: CITY_CENTERS[city] ? 'city-center' : region ? 'region-center' : 'country-center',
    precision: CITY_CENTERS[city] ? 'city' : region ? 'region' : 'country',
    confidence: CITY_CENTERS[city] ? 38 : region ? 28 : 20,
    radiusMeters: CITY_CENTERS[city] ? 5000 : region ? 80000 : 300000,
    navigationDisabled: true
  };
}

function coordinateScopeForCity(city) {
  const region = getRegionForCity(city);
  if (CITY_CENTERS[city]) {
    return { center: CITY_CENTERS[city], precision: 'city', maxDistanceMeters: 150000 };
  }
  if (region && regionCenters[region]) {
    return { center: regionCenters[region], precision: 'region', maxDistanceMeters: 2000000 };
  }
  return { center: CHINA_CENTER, precision: 'country', maxDistanceMeters: 3200000 };
}

function coordinateDistanceWarning(lat, lng, city) {
  if (!isValidCoordinate(lat, lng)) return null;
  const scope = coordinateScopeForCity(city);
  const distance = distanceMeters({ lat, lng }, scope.center);
  if (!Number.isFinite(distance) || distance <= scope.maxDistanceMeters) return null;
  return {
    distance,
    scope,
    reason: `坐标距离${city || '目的地'}${scope.precision === 'city' ? '城市中心' : scope.precision === 'region' ? '区域中心' : '全国中心'}约 ${(distance / 1000).toFixed(0)} km，超过可导航校验范围`
  };
}

function normalizeCoordinate(stop, city, index) {
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);
  const confidence = Number(stop?.geoConfidence);
  const coordinateSource = truncateString(stop?.coordinateSource, 40);
  if (isValidCoordinate(lat, lng) && Number.isFinite(confidence) && confidence < 60) {
    return {
      lat,
      lng,
      fallback: true,
      source: truncateString(stop?.coordinateSource, 40) || 'low-confidence-input',
      precision: truncateString(stop?.coordinatePrecision, 40) || 'approximate',
      confidence: clampNumber(stop?.geoConfidence, 20, 59, 45),
      radiusMeters: clampNumber(stop?.coordinateRadiusMeters, 400, 100000, 1500),
      navigationDisabled: true
    };
  }
  if (isValidCoordinate(lat, lng)) {
    const distanceWarning = coordinateDistanceWarning(lat, lng, city);
    if (distanceWarning) {
      return {
        lat,
        lng,
        fallback: true,
        source: 'out-of-city-input',
        precision: 'approximate',
        confidence: 45,
        radiusMeters: Math.min(100000, Math.max(5000, Math.round(distanceWarning.distance / 20))),
        navigationDisabled: true,
        warning: distanceWarning.reason
      };
    }
    if (coordinateSource === 'model') {
      return {
        lat,
        lng,
        fallback: true,
        source: 'model',
        precision: 'unverified',
        confidence: 55,
        radiusMeters: 1500,
        navigationDisabled: true
      };
    }
    return {
      lat,
      lng,
      fallback: false,
      source: coordinateSource || 'model-or-user',
      precision: truncateString(stop?.coordinatePrecision, 40) || 'exact',
      confidence: clampNumber(stop?.geoConfidence, 60, 99, 82),
      radiusMeters: clampNumber(stop?.coordinateRadiusMeters, 0, 100000, 0),
      navigationDisabled: stop?.navigationDisabled === true
    };
  }
  return coordinateForName(stop?.name, city) ?? fallbackCoordinate(city, index);
}

function normalizeRoutebook(routebook, payload, runtime) {
  const now = new Date();
  const rawDays = Array.isArray(routebook.days) && routebook.days.length ? routebook.days : [];
  const inferredDayCount = inferDayCount(routebook, payload, rawDays);
  const requestedDayCount = inferDayCount(routebook, payload, rawDays, Number.POSITIVE_INFINITY);
  const days = Array.from({ length: inferredDayCount }, (_, index) => `Day ${index + 1}`);
  const stops = (Array.isArray(routebook.stops) ? routebook.stops : []).map((stop, index) => {
    const name = String(stop.name ?? `站点 ${index + 1}`).slice(0, 32);
    const coordinate = normalizeCoordinate({ ...stop, name, coordinateSource: stop.coordinateSource || 'model' }, payload.city, index);
    return {
      id: index + 1,
      day: normalizeDayLabel(stop.day, index, days),
      time: String(stop.time ?? '10:00'),
      name,
      area: String(stop.area ?? '待确认').slice(0, 24),
      stay: String(stop.stay ?? '60 分钟').slice(0, 18),
      cost: String(stop.cost ?? '待估算').slice(0, 20),
      verify: String(stop.verify ?? '需通过真实打卡继续验证').slice(0, 60),
      risk: String(stop.risk ?? '需出发前复核').slice(0, 60),
      score: clampNumber(stop.score, 60, 98, 82),
      lat: coordinate.lat,
      lng: coordinate.lng,
      geoConfidence: coordinate.fallback || coordinate.navigationDisabled === true
        ? clampNumber(coordinate.confidence, 20, 59, 45)
        : clampNumber(stop.geoConfidence, 60, 99, coordinate.confidence ?? 86),
      coordinateSystem: 'WGS84',
      coordinateSource: coordinate.source,
      coordinatePrecision: coordinate.precision,
      coordinateRadiusMeters: coordinate.fallback || coordinate.navigationDisabled === true ? coordinate.radiusMeters ?? 1500 : coordinate.radiusMeters ?? 0,
      navigationDisabled: coordinate.navigationDisabled === true
    };
  });

  if (stops.length < 3) {
    throw new Error('模型返回的站点数量不足');
  }

  const id = cryptoRandomId();
  const sourceSummary = buildSourceSummary(payload.importedSources);
  const baseValidations = buildRoutebookValidations(stops, routebook.validations, 'AI 生成', {
    city: payload.city,
    constraints: payload.constraints,
    travelDate: normalizeTravelDate(payload.constraints?.date)
  });
  const routebookValidations = requestedDayCount > inferredDayCount
    ? [
        {
          id: 'day-count-compressed',
          label: '行程天数',
          state: '已压缩',
          detail: `识别到约 ${requestedDayCount} 天行程，超出单次生成 ${MAX_GENERATED_ROUTE_DAYS} 天上限，已压缩为 ${inferredDayCount} 天，建议按段拆分生成。`
        },
        ...baseValidations
      ].slice(0, 8)
    : baseValidations;
  const routebookMetrics = buildRoutebookMetrics(stops, routebook.metrics);
  return {
    id,
    publicId: id,
    profileId: normalizeProfileId(payload.profileId),
    creator: normalizeCreator({ id: payload.profileId, sourceAuthorization: 'user-generated' }),
    publishStatus: 'draft',
    sourceAuthorization: 'user-generated',
    copyCount: 0,
    city: payload.city,
    title: String(routebook.title ?? `${payload.city ?? '杭州'} 可信路书`).slice(0, 42),
    summary: String(routebook.summary ?? '已生成可执行路线，并标记需要真实打卡校准的风险。').slice(0, 140),
    trustScore: calculateRouteTrustScore(stops),
    days,
    stops,
    assets: normalizeArray(routebook.assets, 'assets'),
    validations: routebookValidations,
    metrics: routebookMetrics,
    logs: normalizeLogs(routebook.logs, now),
    importedSources: payload.importedSources ?? [],
    sourceSummary,
    constraints: normalizeRouteConstraints(payload.constraints),
    travelDate: normalizeTravelDate(payload.constraints?.date),
    provider: {
      name: runtime.providerName,
      model: runtime.model,
      baseUrl: redactBaseUrl(runtime.baseUrl),
      generatedAt: now.toISOString(),
      travelDate: normalizeTravelDate(payload.constraints?.date)
    },
    updatedAt: now.toISOString()
  };
}

async function geocodeGeneratedRoutebook(routebook, signal) {
  if (!AMAP_GEOCODE_KEY || !routebook?.stops?.length) return routebook;
  const stops = await mapWithConcurrency(routebook.stops, 4, async (stop) => {
    if (stop.coordinateSource === 'known-poi') return stop;
    const geocoded = await geocodePoiWithAmap(routebook.city, stop.name, signal).catch(() => null);
    return geocoded ? { ...stop, ...geocoded } : stop;
  });
  return {
    ...routebook,
    stops,
    trustScore: calculateRouteTrustScore(stops),
    validations: buildRoutebookValidations(stops, routebook.validations, '真实地理编码校准', {
      city: routebook.city,
      constraints: routebook.constraints,
      travelDate: routebook.provider?.travelDate || routebook.travelDate
    }),
    metrics: buildRoutebookMetrics(stops, routebook.metrics)
  };
}

async function geocodePoiWithAmap(city, name, signal) {
  const cacheKey = `${city}:${name}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, GEOCODE_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const params = new URLSearchParams({
      key: AMAP_GEOCODE_KEY,
      address: `${city}${name}`,
      city
    });
    const response = await fetch(`https://restapi.amap.com/v3/geocode/geo?${params}`, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    const result = Array.isArray(data?.geocodes) ? data.geocodes[0] : null;
    const [gcjLng, gcjLat] = String(result?.location ?? '').split(',').map(Number);
    if (!isValidCoordinate(gcjLat, gcjLng)) return null;
    const wgs = gcj02ToWgs84(gcjLat, gcjLng);
    if (coordinateDistanceWarning(wgs.lat, wgs.lng, city)) return null;
    const level = truncateString(result?.level, 24) || 'unknown';
    const precise = /兴趣点|门牌号|道路/.test(level);
    const normalized = {
      lat: Number(wgs.lat.toFixed(6)),
      lng: Number(wgs.lng.toFixed(6)),
      geoConfidence: precise ? 92 : 55,
      coordinateSystem: 'WGS84',
      coordinateSource: 'amap-geocode',
      coordinatePrecision: level,
      coordinateRadiusMeters: precise ? 0 : 1500,
      navigationDisabled: !precise
    };
    geocodeCache.set(cacheKey, normalized);
    if (geocodeCache.size > 1000) geocodeCache.delete(geocodeCache.keys().next().value);
    return normalized;
  } catch (error) {
    if (signal?.aborted && !timedOut) throw error;
    return null;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng };
  const transformed = transformGcjOffset(lat, lng);
  return { lat: lat * 2 - transformed.lat, lng: lng * 2 - transformed.lng };
}

function transformGcjOffset(lat, lng) {
  const a = 6378245;
  const ee = 0.006693421622965943;
  let dLat = transformLatitude(lng - 105, lat - 35);
  let dLng = transformLongitude(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function transformLatitude(x, y) {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  value += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return value;
}

function transformLongitude(x, y) {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  value += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return value;
}

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

const MAX_GENERATED_ROUTE_DAYS = 10;

function inferDayCount(routebook, payload, rawDays, maxDays = MAX_GENERATED_ROUTE_DAYS) {
  const duration = String(payload?.constraints?.duration ?? '');
  const durationMatch = duration.match(/(\d+)\s*天|(\d+)\s*日/);
  const durationCount = Number(durationMatch?.[1] ?? durationMatch?.[2]);
  const stopDayNumbers = (Array.isArray(routebook?.stops) ? routebook.stops : [])
    .map((stop) => extractDayNumber(stop.day))
    .filter((number) => Number.isFinite(number));
  const maxStopDay = stopDayNumbers.length ? Math.max(...stopDayNumbers) : 0;
  return Math.min(maxDays, Math.max(1, durationCount || rawDays.length || maxStopDay || 2));
}

function extractDayNumber(value) {
  const text = String(value ?? '');
  const match = text.match(/Day\s*(\d+)|第\s*(\d+)\s*天|D\s*(\d+)/i);
  const number = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isFinite(number) ? number : null;
}

function normalizeDayLabel(value, index, days) {
  const dayNumber = extractDayNumber(value);
  if (dayNumber && days[dayNumber - 1]) return days[dayNumber - 1];
  const stopCountPerDay = Math.max(3, Math.ceil(9 / days.length));
  return days[Math.min(Math.floor(index / stopCountPerDay), days.length - 1)] ?? 'Day 1';
}

function normalizeArray(items, type) {
  const source = Array.isArray(items) ? items : [];
  if (type === 'assets') {
    const fallback = [
      { label: '核心 POI', type: '地点', confidence: 78 },
      { label: '时间约束', type: '约束', confidence: 74 },
      { label: '预算约束', type: '约束', confidence: 72 }
    ];
    const normalized = source.slice(0, 12).map((item, index) => ({
      label: String(item.label ?? `资产 ${index + 1}`).slice(0, 18),
      type: String(item.type ?? 'POI').slice(0, 18),
      confidence: clampNumber(item.confidence, 50, 99, 78)
    }));
    return [...normalized, ...fallback].slice(0, Math.max(3, normalized.length));
  }
  if (type === 'validations') {
    const fallback = [
      { id: 'hours', label: '开放时间', state: '需复核', detail: '出发前需要二次确认开放时间。' },
      { id: 'walk', label: '步行强度', state: '适中', detail: '路线强度会在真实打卡后校准。' },
      { id: 'budget', label: '预算风险', state: '可控', detail: '预算估算仍需结合现场消费。' },
      { id: 'crowd', label: '拥挤风险', state: '中', detail: '热门点位建议错峰执行。' }
    ];
    const normalized = source.slice(0, 8).map((item, index) => ({
      id: String(item.id ?? `validation-${index + 1}`).replace(/\s+/g, '-'),
      label: String(item.label ?? '校验项').slice(0, 18),
      state: String(item.state ?? '需复核').slice(0, 12),
      detail: String(item.detail ?? '需要结合真实打卡继续校准。').slice(0, 80)
    }));
    return [...normalized, ...fallback].slice(0, Math.max(4, normalized.length));
  }
  const fallback = [
    { label: '保存后打卡率', value: '待验证' },
    { label: '主线完成率', value: '待验证' },
    { label: '平均修改', value: '待验证' },
    { label: '踩坑反馈', value: '待验证' }
  ];
  const normalized = source.slice(0, 6).map((item, index) => ({
    label: String(item.label ?? `指标 ${index + 1}`).slice(0, 18),
    value: String(item.value ?? '-').slice(0, 18)
  }));
  return [...normalized, ...fallback].slice(0, Math.max(4, normalized.length));
}

function normalizeLogs(logs, now) {
  const fallback = [
    { stage: '意图识别', input: '用户攻略与约束', result: '已提取城市、天数与偏好', status: '通过' },
    { stage: 'POI 提取', input: '攻略文本', result: '已识别候选地点', status: '通过' },
    { stage: '路线编排', input: '候选地点', result: '已按分日顺序编排', status: '通过' },
    { stage: '可执行校验', input: '路线与约束', result: '已标记需复核风险', status: '需复核' }
  ];
  const source = Array.isArray(logs) && logs.length ? logs : fallback;
  const normalized = source.slice(0, 8).map((log, index) => ({
    time: new Date(now.getTime() + index * 1000).toLocaleTimeString('zh-CN', { hour12: false }),
    input: String(log.input ?? '用户攻略与约束').slice(0, 32),
    stage: String(log.stage ?? `阶段 ${index + 1}`).slice(0, 18),
    result: String(log.result ?? '已完成').slice(0, 72),
    status: String(log.status ?? '通过').slice(0, 12)
  }));
  return normalized.length >= 4 ? normalized : [...normalized, ...fallback].slice(0, 4);
}

function isStructuredOutputUnsupported(error) {
  const detail = `${error.upstreamCode ?? ''} ${error.upstreamDetail ?? ''}`;
  return error.statusCode === 400 && /json_schema|schema|structured|response_format|text\.format/i.test(detail);
}

async function callOpenAiApi(
  payload,
  runtime,
  { responseFormat = 'json_schema', signal, maxOutputTokens = AI_MAX_OUTPUT_TOKENS } = {}
) {
  const requestBody = runtime.wireApi === 'chat_completions'
    ? {
        model: runtime.model,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(payload) }
        ],
        max_tokens: maxOutputTokens
      }
    : {
        model: runtime.model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt() }] },
          { role: 'user', content: [{ type: 'input_text', text: userPrompt(payload) }] }
        ],
        store: false,
        max_output_tokens: maxOutputTokens
      };

  if (responseFormat === 'json_schema') {
    const format = {
      type: 'json_schema',
      name: 'trusted_routebook',
      schema: RESPONSE_SCHEMA,
      strict: true
    };
    if (runtime.wireApi === 'chat_completions') {
      requestBody.response_format = {
        type: 'json_schema',
        json_schema: {
          name: format.name,
          schema: format.schema,
          strict: format.strict
        }
      };
    } else {
      requestBody.text = { format };
    }
  } else if (responseFormat === 'json_object') {
    if (runtime.wireApi === 'chat_completions') {
      requestBody.response_format = { type: 'json_object' };
    } else {
      requestBody.text = { format: { type: 'json_object' } };
    }
  }

  // endpoint 在 try 外求值：BAD_BASE_URL 等配置错误应原样上抛（503），
  // 而不是被 catch 吞成 MODEL_FETCH_FAILED。
  const endpoint = openAiEndpoint(runtime.baseUrl, runtime.wireApi);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AI_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
  } catch (error) {
    if (timedOut) {
      throw createHttpError('模型服务响应超时，请稍后重试', 504, 'MODEL_TIMEOUT');
    }
    if (signal?.aborted) {
      throw createHttpError('客户端已取消请求', 499, 'CLIENT_ABORTED');
    }
    if (error?.statusCode) throw error;
    throw createHttpError('模型服务暂时不可用', 502, 'MODEL_FETCH_FAILED');
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

	  if (!response.ok) {
	    const detail = data.error?.message ?? data.message ?? `HTTP ${response.status}`;
	    const error = createHttpError('模型服务调用失败', response.status >= 500 ? 502 : response.status, 'MODEL_ERROR');
	    error.upstreamStatus = response.status;
	    error.upstreamDetail = detail;
	    error.upstreamCode = data.error?.code ?? data.code;
	    throw error;
	  }

  // A response that ran out of output budget still returns HTTP 200 with a
  // half-written JSON body, so it has to be caught here instead of at parse time.
  if (data.status === 'incomplete') {
    const reason = data.incomplete_details?.reason ?? 'unknown';
    const error = createHttpError(
      'AI 输出被截断，请重试',
      502,
      reason === 'max_output_tokens' ? 'MODEL_OUTPUT_TRUNCATED' : 'MODEL_OUTPUT_INCOMPLETE'
    );
    error.upstreamDetail = `status=incomplete reason=${reason} max_output_tokens=${maxOutputTokens}`;
    error.truncatedByTokenLimit = reason === 'max_output_tokens';
    error.attemptedMaxOutputTokens = maxOutputTokens;
    throw error;
  }

  return data;
}

async function analyzeGuideImages(images, signal) {
  const runtime = await loadCodexRuntime();
  if (!runtime.ready) {
    throw createHttpError(runtime.readyReason || 'yinyue provider 或 OPENAI_API_KEY 未配置', 503, 'MODEL_NOT_READY');
  }
  const systemText = [
    '你是可信路书 AI 的截图攻略 OCR/结构化助手。',
    '只识别用户上传截图中的旅行地点、时间、价格、排队、风险、路线顺序线索。',
    '不要复写长篇原文，不要生成营销文案，只返回 JSON。'
  ].join('\n');
  const userText = JSON.stringify({
    task: '从截图中提取旅行攻略线索',
    outputShape: {
      places: [{ name: '地点', time: '时间线索', price: '价格/门票/人均', note: '风险或上下文', confidence: 0 }],
      guideText: '可追加到攻略输入框的摘要',
      warnings: ['需要用户复核的事项']
    },
    policy: '只输出 JSON，不要 Markdown；无法识别时返回空 places 和 warnings。'
  }, null, 2);
  const responseSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['places', 'guideText', 'warnings'],
    properties: {
      places: {
        type: 'array',
        maxItems: 24,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'time', 'price', 'note', 'confidence'],
          properties: {
            name: { type: 'string' },
            time: { type: 'string' },
            price: { type: 'string' },
            note: { type: 'string' },
            confidence: { type: 'number' }
          }
        }
      },
      guideText: { type: 'string' },
      warnings: { type: 'array', maxItems: 12, items: { type: 'string' } }
    }
  };
  const buildRequestBody = (responseFormat) => {
    const requestBody = runtime.wireApi === 'chat_completions'
      ? {
          model: runtime.model,
          messages: [
            { role: 'system', content: systemText },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } }))
              ]
            }
          ],
          max_tokens: OCR_MAX_OUTPUT_TOKENS
        }
      : {
          model: runtime.model,
          input: [
            { role: 'system', content: [{ type: 'input_text', text: systemText }] },
            {
              role: 'user',
              content: [
                { type: 'input_text', text: userText },
                ...images.map((image) => ({ type: 'input_image', image_url: image.dataUrl }))
              ]
            }
          ],
          store: false,
          max_output_tokens: OCR_MAX_OUTPUT_TOKENS
        };
    if (responseFormat === 'json_schema') {
      if (runtime.wireApi === 'chat_completions') {
        requestBody.response_format = {
          type: 'json_schema',
          json_schema: { name: 'guide_image_ocr', schema: responseSchema, strict: true }
        };
      } else {
        requestBody.text = {
          format: { type: 'json_schema', name: 'guide_image_ocr', schema: responseSchema, strict: true }
        };
      }
    } else if (responseFormat === 'json_object') {
      if (runtime.wireApi === 'chat_completions') {
        requestBody.response_format = { type: 'json_object' };
      } else {
        requestBody.text = { format: { type: 'json_object' } };
      }
    }
    return requestBody;
  };
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AI_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const requestModel = async (responseFormat) => {
    const response = await fetch(openAiEndpoint(runtime.baseUrl, runtime.wireApi), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildRequestBody(responseFormat)),
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // 上游返回非 JSON（网关错误页等）时保留上游 status 与截断原文，便于排障。
      const parseError = createHttpError('截图识别上游返回无法解析', 502, 'OCR_UPSTREAM_INVALID_JSON');
      parseError.upstreamStatus = response.status;
      parseError.upstreamDetail = truncateString(`HTTP ${response.status} ${text}`, 400);
      throw parseError;
    }
    if (!response.ok) {
      const detail = data.error?.message ?? data.message ?? `HTTP ${response.status}`;
      const error = createHttpError('截图识别调用失败', response.status >= 500 ? 502 : response.status, 'OCR_MODEL_ERROR');
      error.upstreamStatus = response.status;
      error.upstreamDetail = detail;
      error.upstreamCode = data.error?.code ?? data.code;
      throw error;
    }
    if (data.status === 'incomplete') {
      const error = createHttpError('截图内容过多导致识别结果被截断，请减少图片后重试', 502, 'OCR_OUTPUT_TRUNCATED');
      error.upstreamDetail = `status=incomplete reason=${data.incomplete_details?.reason ?? 'unknown'}`;
      throw error;
    }
    return data;
  };
  try {
    let data;
    try {
      data = await requestModel('json_schema');
    } catch (error) {
      if (!isStructuredOutputUnsupported(error)) throw error;
      try {
        data = await requestModel('json_object');
      } catch (fallbackError) {
        if (!isStructuredOutputUnsupported(fallbackError)) throw fallbackError;
        data = await requestModel('none');
      }
    }
    return normalizeOcrResult(parseJsonFromText(extractTextFromResponse(data)), images, runtime);
  } catch (error) {
    if (timedOut) throw createHttpError('截图识别超时，请减少图片后重试', 504, 'OCR_TIMEOUT');
    if (error.statusCode) throw error;
    throw createHttpError('截图识别暂不可用，请先粘贴正文摘要', 502, 'OCR_UNAVAILABLE');
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

// Ops needs to tell a truncated output apart from a hallucinated one when reading
// the AI log; the HTTP code alone collapses both into MODEL_ERROR.
function generationFailureReason(error) {
  switch (error?.code) {
    case 'MODEL_OUTPUT_TRUNCATED': return 'truncated';
    case 'MODEL_OUTPUT_INCOMPLETE': return 'incomplete';
    case 'MODEL_BAD_OUTPUT': return 'bad-output';
    case 'MODEL_TIMEOUT': return 'timeout';
    case 'MODEL_NOT_READY': return 'not-ready';
    case 'CLIENT_ABORTED': return 'client-aborted';
    case 'MODEL_FETCH_FAILED': return 'upstream-unreachable';
    default: return error?.upstreamStatus ? 'upstream-error' : 'unknown';
  }
}

async function generateRoutebook(payload, signal) {
  const runtime = await loadCodexRuntime();
  if (!runtime.ready) {
    throw createHttpError(runtime.readyReason || 'yinyue provider 或 OPENAI_API_KEY 未配置', 503, 'MODEL_NOT_READY');
  }

  // rank12③：把目标城市的已审核运营 POI 候选注入 prompt（≤40 条，构建失败静默降级）。
  let promptPayload = payload;
  try {
    const poiCandidates = buildApprovedPoiPromptCandidates(payload.city);
    if (poiCandidates.length) promptPayload = { ...payload, poiCandidates };
  } catch {
    promptPayload = payload;
  }

  const callModel = (options = {}) => callOpenAiApi(promptPayload, runtime, {
    responseFormat: 'json_schema',
    signal,
    ...options
  }).catch(async (error) => {
    if (!isStructuredOutputUnsupported(error)) throw error;
    return callOpenAiApi(promptPayload, runtime, {
      responseFormat: 'json_object',
      signal,
      ...options
    }).catch((fallbackError) => {
      if (!isStructuredOutputUnsupported(fallbackError)) throw fallbackError;
      return callOpenAiApi(promptPayload, runtime, {
        responseFormat: 'none',
        signal,
        ...options
      });
    });
  });

  const raw = await callModel().catch((error) => {
    if (!error?.truncatedByTokenLimit || error.attemptedMaxOutputTokens >= AI_MAX_OUTPUT_TOKENS_RETRY) throw error;
    return callModel({ maxOutputTokens: AI_MAX_OUTPUT_TOKENS_RETRY });
  });

  let routebook;
  try {
    routebook = normalizeRoutebook(
      { ...parseJsonFromText(extractTextFromResponse(raw)), profileId: payload.profileId },
      payload,
      runtime
    );
  } catch (error) {
    if (error?.statusCode) throw error;
    const failure = createHttpError('AI 输出格式异常，请重新生成', 502, 'MODEL_BAD_OUTPUT');
    failure.upstreamDetail = error?.message ?? '未知解析失败';
    throw failure;
  }
  return geocodeGeneratedRoutebook(routebook, signal);
}

async function checkStorageReadiness() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await access(DATA_DIR, fsConstants.R_OK | fsConstants.W_OK);
    return { ready: true, code: 'READY' };
  } catch {
    return { ready: false, code: 'STORAGE_NOT_READ_WRITE' };
  }
}

async function buildReadinessSnapshot() {
  const [storage, runtimeResult] = await Promise.all([
    checkStorageReadiness(),
    loadCodexRuntime()
      .then((runtime) => ({
        ready: runtime.ready,
        code: runtime.ready ? 'READY' : 'MODEL_RUNTIME_NOT_READY'
      }))
      .catch(() => ({ ready: false, code: 'MODEL_RUNTIME_CHECK_FAILED' }))
  ]);
  const ready = storage.ready && runtimeResult.ready;
  const checks = {
    storage,
    runtime: runtimeResult
  };
  return {
    ok: ready,
    appId: APP_ID,
    ready,
    checks,
    reasonCodes: Object.values(checks)
      .filter((check) => !check.ready)
      .map((check) => check.code)
  };
}

async function handleApi(req, res) {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname.startsWith('/api/map-tiles/')) {
      enforceRateLimit(req, 'map-tile');
      return await handleMapTile(req, res, url);
    }

    if (req.method === 'GET' && url.pathname === '/api/live') {
      return sendJson(res, 200, {
        ok: true,
        appId: APP_ID,
        live: true
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/ready') {
      const readiness = await buildReadinessSnapshot();
      return sendJson(res, readiness.ready ? 200 : 503, readiness);
    }

	    if (req.method === 'GET' && url.pathname === '/api/health') {
      const runtime = await loadCodexRuntime();
      return sendJson(res, 200, {
        ok: true,
        appId: APP_ID,
        provider: runtime.providerName,
        model: runtime.model,
        wireApi: runtime.wireApi,
        baseUrl: redactBaseUrl(runtime.baseUrl),
        ready: runtime.ready,
        reason: runtime.readyReason,
        geocoder: AMAP_GEOCODE_KEY ? 'amap' : 'disabled'
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/cities') {
      const rawQuery = String(url.searchParams.get('q') ?? '').trim();
      const query = rawQuery ? normalizeCityName(rawQuery) : '';
      const matches = !query
        ? supportedCities.slice(0, 80)
        : supportedCities.filter((city) => city.includes(query) || query.includes(city)).slice(0, 80);
      return sendJson(res, 200, {
        ok: true,
        total: supportedCities.length,
        regions: regionCityGroups,
        cities: matches,
        supported: isSupportedCity(query),
        region: getRegionForCity(query)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/pois/validate') {
      enforceRateLimit(req);
      verifyAdminAccess(req);
      const validation = await validatePoiBatch(await readJsonBody(req));
      return sendJson(res, 200, { ok: true, ...validation });
    }

    if (req.method === 'POST' && url.pathname === '/api/pois/upsert') {
      enforceRateLimit(req);
      verifyAdminAccess(req);
      const result = await commitPoiBatch(await readJsonBody(req));
      const { statusCode, ...payload } = result;
      return sendJson(res, statusCode, payload);
    }

    // 跨区契约：站点改名重校验的服务端解析端点。与 hardenDraftStops 同一
    // 合并目录（seed TRUSTED_POI_CATALOG + 运营 approved POI，normalizeCityName/
    // normalizePoiName 精确匹配）；public-read 限流、无需鉴权。
    if (req.method === 'GET' && url.pathname === '/api/pois/resolve') {
      enforceRateLimit(req, 'public-read');
      const city = url.searchParams.get('city') ? normalizeCityName(url.searchParams.get('city')) : '';
      const name = truncateString(url.searchParams.get('name'), 80);
      const canonical = name ? coordinateForName(name, city) : null;
      if (!canonical) {
        return sendJson(res, 200, { ok: true, poi: { matched: false } });
      }
      const trusted = findTrustedPoi({ name }, city);
      return sendJson(res, 200, {
        ok: true,
        poi: {
          matched: true,
          name: truncateString(trusted?.name, 80) || name,
          lat: canonical.lat,
          lng: canonical.lng,
          geoConfidence: canonical.confidence,
          coordinateSource: canonical.source
        }
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/pois') {
      verifyAdminAccess(req);
      const city = truncateString(url.searchParams.get('city'), 40).replace(/市$/u, '');
      const reviewStatus = truncateString(url.searchParams.get('reviewStatus'), 24);
      const freshnessState = truncateString(url.searchParams.get('freshnessState'), 24);
      if (city && !OPERATIONAL_POI_CITY_SET.has(city)) {
        throw createHttpError('运营 POI 当前只支持杭州、上海、苏州', 400, 'UNSUPPORTED_OPERATIONAL_CITY');
      }
      if (reviewStatus && !POI_REVIEW_STATUSES.has(reviewStatus)) {
        throw createHttpError('reviewStatus 只能是 pending/approved/rejected', 400, 'INVALID_POI_STATUS_FILTER');
      }
      if (freshnessState && !['fresh', 'expiringSoon', 'stale', 'pending'].includes(freshnessState)) {
        throw createHttpError('freshnessState 只能是 fresh/expiringSoon/stale/pending', 400, 'INVALID_FRESHNESS_FILTER');
      }
      const snapshotAt = new Date().toISOString();
      const nowMs = Date.parse(snapshotAt);
      const pois = (await listMergedPois())
        .map((poi) => publicOperationalPoiView(poi, nowMs))
        .filter((poi) => (!city || poi.city === city) &&
          (!reviewStatus || poi.reviewStatus === reviewStatus) &&
          (!freshnessState || poi.freshnessState === freshnessState))
        .sort((left, right) => left.city.localeCompare(right.city, 'zh-CN') || left.name.localeCompare(right.name, 'zh-CN'));
      return sendJson(res, 200, {
        ok: true,
        snapshotAt,
        filters: { city, reviewStatus, freshnessState },
        total: pois.length,
        pois
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/poi-coverage') {
      verifyAdminAccess(req);
      return sendJson(res, 200, { ok: true, ...(await buildPoiCoverageSnapshot()) });
    }

    if (req.method === 'GET' && url.pathname === '/api/routebooks') {
      const city = url.searchParams.get('city') ? normalizeCityName(url.searchParams.get('city')) : '';
      const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
      const statuses = String(url.searchParams.get('status') ?? '')
        .split(',')
        .map((item) => truncateString(item.trim(), 40))
        .filter(Boolean);
	      const allRequestedStatusesPublic = statuses.length > 0 && statuses.every((status) => PUBLIC_ROUTE_STATUSES.has(status));
	      const privilegedRead = (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) || hasAdminAccess(req);
	      if (profileId) {
	        await verifySensitiveOrProfileReadAccess(req, profileId);
	      } else if (!privilegedRead && !allRequestedStatusesPublic) {
	        verifyAdminAccess(req);
	      }
      const routebooks = await listSavedRoutebooks(clampNumber(url.searchParams.get('limit'), 1, 200, 100));
      const filtered = routebooks.filter((routebook) =>
        (!city || routebook.city === city) &&
        (!profileId || normalizeProfileId(routebook.profileId) === profileId) &&
        (!statuses.length || statuses.includes(routebook.publishStatus || 'draft'))
      );
      // rank23①：列表路径先一次性读齐 5 份 JSONL，逐路书 enrich 时传引用复用。
      const feedbackContext = filtered.length ? await buildRouteFeedbackContext() : null;
      const enrichedRoutebooks = await Promise.all(filtered.map((routebook) => enrichRoutebook(routebook, feedbackContext)));
	      const publicList = !privilegedRead && allRequestedStatusesPublic && !profileId;
      return sendJson(res, 200, {
        ok: true,
        routebooks: publicList ? enrichedRoutebooks.map(publicRoutebookView) : enrichedRoutebooks
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/cms') {
      return sendJson(res, 200, {
        ok: true,
        config: await readCmsConfig()
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/cms') {
      enforceRateLimit(req);
      verifyAdminAccess(req);
      const config = normalizeCmsConfig(await readJsonBody(req));
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(CMS_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      return sendJson(res, 200, { ok: true, config });
    }

    if (req.method === 'GET' && url.pathname === '/api/products') {
      const config = await readProductConfig();
      return sendJson(res, 200, {
        ok: true,
        products: config.products,
        updatedAt: config.updatedAt
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/products') {
      enforceRateLimit(req);
      verifyAdminAccess(req);
      const config = normalizeProductConfig(await readJsonBody(req), { strictUrl: true });
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(PRODUCT_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      return sendJson(res, 200, {
        ok: true,
        products: config.products,
        updatedAt: config.updatedAt
      });
    }

	    if (req.method === 'POST' && url.pathname === '/api/profile') {
	      enforceRateLimit(req);
	      const body = await readJsonBody(req);
	      // 同一 profile 的「读旧行-合并-追加」需要互斥，否则并发更新会彼此覆盖。
	      const profileLockKey = normalizeProfile(body).id || 'anonymous';
	      const publicProfile = await withSingleProcessKeyLock(profileMutationLocks, profileLockKey, async () => {
	        const { storedProfile, publicProfile: builtProfile } = await buildStoredProfile(body);
	        await appendJsonLine(PROFILE_LOG_PATH, storedProfile);
	        return builtProfile;
	      });
	      return sendJson(res, 200, { ok: true, profile: publicProfile });
	    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      verifySensitiveReadAccess(req);
      return sendJson(res, 200, {
        ok: true,
        dashboard: await buildPlatformDashboard(clampNumber(url.searchParams.get('limit'), 100, 2000, 1000))
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/creators/')) {
      enforceRateLimit(req, 'public-read');
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/creators/', '')));
      if (!id) throw createHttpError('达人 ID 不合法', 400, 'CREATOR_ID_REQUIRED');
      return sendJson(res, 200, {
        ok: true,
        profile: await buildCreatorProfile(id)
      });
    }

    if (req.method === 'POST' && /^\/api\/routebooks\/[^/]+\/status$/.test(url.pathname)) {
      enforceRateLimit(req, 'core-write');
      verifyAdminAccess(req);
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/routebooks/', '').replace(/\/status$/, '')));
      const body = await readJsonBody(req);
      const routebook = await withSingleProcessKeyLock(routebookMutationLocks, id, () => updateRoutebookStatus(id, body));
      return sendJson(res, 200, {
        ok: true,
        routebook: await enrichRoutebook(routebook)
      });
    }

    if (req.method === 'POST' && /^\/api\/routebooks\/[^/]+\/publish$/.test(url.pathname)) {
      enforceRateLimit(req, 'core-write');
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/routebooks/', '').replace(/\/publish$/, '')));
      const body = await readJsonBody(req);
      const routebook = await withSingleProcessKeyLock(routebookMutationLocks, id, () => publishOwnRoutebook(id, body));
      return sendJson(res, 200, {
        ok: true,
        routebook: await enrichRoutebook(routebook),
        shareUrl: `/share/${routebook.publicId}`
      });
    }

    if (req.method === 'POST' && /^\/api\/routebooks\/[^/]+\/copy$/.test(url.pathname)) {
      enforceRateLimit(req, 'core-write');
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/routebooks/', '').replace(/\/copy$/, '')));
      const body = await readJsonBody(req);
      const actor = await resolveWriteProfile(req, body?.profileId);
      const routebook = await withSingleProcessKeyLock(routebookMutationLocks, id, () => copyRoutebook(id, { ...body, profileId: actor.profileId }));
      const enriched = await enrichRoutebook(routebook);
      return sendJson(res, 200, {
        ok: true,
        routebook: publicRoutebookView(enriched),
        copyCount: enriched.copyCount ?? 0
      });
    }

    if (req.method === 'GET' && /^\/api\/routebooks\/[^/]+\/versions$/.test(url.pathname)) {
      verifyAdminAccess(req);
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/routebooks/', '').replace(/\/versions$/, '')));
      let versions = await listRoutebookVersionRows(id);
      if (!versions.length) {
        const curated = getCuratedRoutebook(id);
        if (!curated) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
        versions = [{
          schemaVersion: positiveInteger(curated.schemaVersion, 2),
          version: positiveInteger(curated.version, 1),
          parentVersion: positiveInteger(curated.parentVersion),
          derived: false,
          snapshotOrdinal: 1,
          routebookId: id,
          title: curated.title,
          city: curated.city,
          publishStatus: curated.publishStatus,
          changeReason: curated.changeReason,
          actorType: curated.actorType,
          createdAt: curated.createdAt,
          updatedAt: curated.updatedAt,
          publishedAt: curated.publishedAt,
          archivedAt: curated.archivedAt
        }];
      }
      const audits = await listRoutebookAudits(id);
      return sendJson(res, 200, {
        ok: true,
        routebookId: id,
        currentVersion: versions.at(-1)?.version ?? null,
        versions,
        audits
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/routebooks/')) {
      // 单路书详情要做全文件反扫 + enrich，读放大明显，挂公共读桶防刷。
      enforceRateLimit(req, 'public-read');
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/routebooks/', '')));
      const savedRoutebook = await getResolvableRoutebook(id);
      if (!savedRoutebook) throw createHttpError('路书不存在或尚未保存', 404, 'ROUTEBOOK_NOT_FOUND');
      const privilegedRead = (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) || hasAdminAccess(req);
      const ownerRead = !privilegedRead && normalizeProfileId(savedRoutebook.profileId) !== 'anonymous'
        ? await verifyProfileReadAccess(req, savedRoutebook.profileId)
        : false;
      // 匿名持有编辑令牌的用户刷新页面后仍可恢复自己的草稿：
      // x-routebook-edit-token 与存储 editToken 匹配时按 owner 读处理。
      const requestedEditToken = sanitizeEditToken(req.headers['x-routebook-edit-token']);
      const storedEditToken = sanitizeEditToken(savedRoutebook.editToken);
      const editTokenRead = Boolean(
        !privilegedRead && !ownerRead &&
        requestedEditToken && storedEditToken &&
        safeTokenEqual(requestedEditToken, storedEditToken)
      );
      if (!privilegedRead && !ownerRead && !editTokenRead && !isPublicRoutebook(savedRoutebook)) {
        throw createHttpError('路书不存在或尚未公开发布', 404, 'ROUTEBOOK_NOT_FOUND');
      }
      const privateRead = !isCuratedRouteId(id) && (privilegedRead || ownerRead || editTokenRead);
      const routebook = await enrichRoutebook(privateRead ? await ensureDraftEditToken(savedRoutebook) : savedRoutebook);
      return sendJson(res, 200, { ok: true, routebook: privateRead ? routebook : publicRoutebookView(routebook) });
    }

    if (req.method === 'POST' && /^\/api\/routebooks\/[^/]+\/variants$/.test(url.pathname)) {
      enforceRateLimit(req, 'core-write');
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/routebooks/', '').replace(/\/variants$/, '')));
      const body = await readJsonBody(req);
      const result = await withSingleProcessKeyLock(routebookMutationLocks, id, () => saveRoutebookVariant(id, body));
      return sendJson(res, 200, {
        ok: true,
        routebook: await enrichRoutebook(result.routebook),
        variant: result.variant
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/routebooks') {
      enforceRateLimit(req, 'core-write');
      const body = await readJsonBody(req);
      const actor = await resolveWriteProfile(req, body?.profileId);
      const lockKey = sanitizePublicId(body?.id || body?.publicId) || `new:${req.requestId}`;
      const { routebook, enriched } = await withSingleProcessKeyLock(routebookMutationLocks, lockKey, async () => {
        const savedRoutebook = await saveDraftRoutebook({ ...body, profileId: actor.profileId });
        await appendVersionedRoutebook(savedRoutebook, savedRoutebook.parentVersion ? 'draft-saved' : 'created');
        return { routebook: savedRoutebook, enriched: await enrichRoutebook(savedRoutebook) };
      });
      return sendJson(res, 200, {
        ok: true,
        routebook: enriched,
        shareUrl: isPublicRoutebook(routebook) ? `/share/${routebook.publicId}` : ''
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/share/')) {
      enforceRateLimit(req, 'public-read');
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/share/', '')));
      const routebook = await enrichRoutebook(await getResolvableRoutebook(id));
      if (!routebook || !isPublicRoutebook(routebook)) {
        throw createHttpError('分享路书不存在或已失效', 404, 'SHARE_NOT_FOUND');
      }
      const publicRoutebook = publicRoutebookView(routebook);
      return sendJson(res, 200, {
        ok: true,
        routebook: publicRoutebook,
        share: {
          publicId: publicRoutebook.publicId,
          title: publicRoutebook.title,
          city: publicRoutebook.city,
          trustScore: publicRoutebook.trustScore,
          updatedAt: publicRoutebook.updatedAt
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/poi-corrections') {
      enforceRateLimit(req);
      const correction = normalizePoiCorrection(await readJsonBody(req));
      await appendJsonLine(POI_CORRECTION_LOG_PATH, correction);
      return sendJson(res, 200, { ok: true, correction });
    }

    if (req.method === 'GET' && url.pathname === '/api/poi-corrections') {
      verifySensitiveReadAccess(req);
      return sendJson(res, 200, {
        ok: true,
        corrections: await listPoiCorrections(clampNumber(url.searchParams.get('limit'), 1, 200, 50), {
          status: truncateString(url.searchParams.get('status'), 24)
        })
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/poi-knowledge') {
      const city = url.searchParams.get('city') ? normalizeCityName(url.searchParams.get('city')) : '';
      const stopName = truncateString(url.searchParams.get('stopName'), 80);
      return sendJson(res, 200, {
        ok: true,
        knowledge: await listPoiKnowledge({
          city,
          stopName,
          limit: clampNumber(url.searchParams.get('limit'), 1, 200, 80)
        })
      });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/poi-corrections/')) {
      enforceRateLimit(req);
      verifyAdminAccess(req);
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/poi-corrections/', '').replace(/\/status$/, '')));
      const correction = await updatePoiCorrectionStatus(id, await readJsonBody(req));
      return sendJson(res, 200, { ok: true, correction });
    }

    if (req.method === 'POST' && url.pathname === '/api/favorites') {
      enforceRateLimit(req, 'core-write');
      const body = await readJsonBody(req);
      const actor = await resolveWriteProfile(req, body?.profileId);
      const row = {
        id: cryptoRandomId(),
        profileId: actor.profileId,
        routeId: sanitizePublicId(body?.routeId || body?.publicId),
        routeTitle: truncateString(body?.routeTitle || body?.title, 100),
        city: body?.city ? normalizeCityName(body.city) : '',
        source: truncateString(body?.source, 40) || 'user',
        creatorId: sanitizePublicId(body?.creatorId),
        createdAt: new Date().toISOString()
      };
      await appendJsonLine(FAVORITE_LOG_PATH, row);
      return sendJson(res, 200, { ok: true, favorite: row });
    }

    if (req.method === 'GET' && url.pathname === '/api/favorites') {
      const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
      await verifySensitiveOrProfileReadAccess(req, profileId);
      const favoriteLimit = clampNumber(url.searchParams.get('limit'), 1, 200, 80);
      const favorites = profileId
        ? await readMatchingJsonLines(FAVORITE_LOG_PATH, (item) => normalizeProfileId(item?.profileId) === profileId, favoriteLimit, 100000)
        : await readJsonLines(FAVORITE_LOG_PATH, favoriteLimit);
      return sendJson(res, 200, { ok: true, favorites });
    }

    if (req.method === 'POST' && url.pathname === '/api/reviews') {
      enforceRateLimit(req, 'core-write');
      const body = await readJsonBody(req);
      const routeId = sanitizePublicId(body?.routebookId || body?.routeId || body?.publicId || body?.routebook?.publicId || body?.routebook?.id);
      if (!routeId) throw createHttpError('请提供公开路书 ID', 400, 'REVIEW_ROUTE_REQUIRED');
      const currentRoutebook = await getResolvableRoutebook(routeId);
      if (!currentRoutebook || !isPublicRoutebook(currentRoutebook)) {
        throw createHttpError('路书公开发布后才能生成回顾分享页', 403, 'REVIEW_ROUTE_NOT_PUBLIC');
      }
      const requestedProfileId = normalizeProfileId(body?.profileId);
      const actor = await resolveWriteProfile(req, requestedProfileId);
      if (!actor.verified) throw createHttpError('生成个人回顾需要 profile token', 403, 'PROFILE_TOKEN_REQUIRED');
      const review = await normalizeReviewShare(body, currentRoutebook, {
        profileId: actor.profileId,
        includePersistedProfileCheckins: true
      });
      await appendJsonLine(REVIEW_LOG_PATH, review);
      return sendJson(res, 200, { ok: true, review: publicReviewView(review), shareUrl: `/review/${review.publicId}` });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/reviews/')) {
      const id = sanitizePublicId(safeDecodePathSegment(url.pathname.replace('/api/reviews/', '')));
      const review = await getSavedReview(id);
      if (!review) throw createHttpError('路线回顾不存在或尚未保存', 404, 'REVIEW_NOT_FOUND');
      if (!isPublicRoutebook(review.routebook) || !(await reviewIsStillPublic(review))) {
        throw createHttpError('路线回顾已失效', 404, 'REVIEW_NOT_FOUND');
      }
	      return sendJson(res, 200, { ok: true, review: publicReviewView(review) });
    }

    if (req.method === 'POST' && url.pathname === '/api/ocr-guide') {
      enforceRateLimit(req, 'ai');
      verifyApiAccess(req);
      const body = await readJsonBody(req, MAX_OCR_REQUEST_BYTES);
      const images = (Array.isArray(body?.images) ? body.images : [])
        .slice(0, MAX_OCR_IMAGES)
        .map((image, index) => normalizeOcrImage(image, index));
      if (!images.length) throw createHttpError('请上传至少 1 张攻略截图', 400, 'OCR_IMAGE_REQUIRED');
      return sendJson(res, 200, await analyzeGuideImages(images, bindRequestAbortSignal(req)));
    }

	    if (req.method === 'POST' && url.pathname === '/api/generate-routebook') {
	      enforceRateLimit(req, 'ai');
	      verifyApiAccess(req);
	      const sanitizedPayload = sanitizePayload(await readJsonBody(req));
        const actor = await resolveWriteProfile(req, sanitizedPayload.profileId);
        const payload = { ...sanitizedPayload, profileId: actor.profileId };
        const startedAt = Date.now();
        const requestId = req.requestId || cryptoRandomId();
        const inputMeta = guideLogMeta(payload);
        try {
		        const routebook = await generateRoutebook(payload, bindRequestAbortSignal(req));
		        const profileId = normalizeProfileId(payload.profileId);
		          const storedRoutebook = normalizeRoutebookForStorage({
		            ...routebook,
		            schemaVersion: 2,
		            version: 1,
		            parentVersion: null,
		            changeReason: 'AI 生成初始草稿',
		            actorType: 'user',
		            profileId,
		            creator: normalizeUserRouteCreator(payload, profileId),
		            sourceAuthorization: 'user-generated',
		            editToken: sanitizeEditToken(payload.editToken) || createRouteEditToken()
		          }, routebook.publicId);
          await appendVersionedRoutebook(storedRoutebook, 'generated');
		          await appendJsonLine(AI_LOG_PATH, {
            requestId,
            kind: 'generate-routebook',
            status: 'ok',
            city: payload.city,
            profileId,
            provider: routebook.provider,
            ...inputMeta,
	            outputTitle: storedRoutebook.title,
	            trustScore: storedRoutebook.trustScore,
	            stopCount: storedRoutebook.stops.length,
            publicId: storedRoutebook.publicId,
	            durationMs: Date.now() - startedAt,
	            createdAt: new Date().toISOString()
	          });
		        return sendJson(res, 200, { ...(await enrichRoutebook(storedRoutebook)), shareUrl: '' });
        } catch (error) {
          await appendJsonLine(AI_LOG_PATH, {
            requestId,
            kind: 'generate-routebook',
            status: 'error',
            city: payload.city,
            ...inputMeta,
            code: error.code ?? 'MODEL_ERROR',
            failureReason: generationFailureReason(error),
            upstreamStatus: error.upstreamStatus,
            upstreamDetail: truncateString(error.upstreamDetail, 400),
            durationMs: Date.now() - startedAt,
            createdAt: new Date().toISOString()
          });
          throw error;
        }
	    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      verifySensitiveReadAccess(req);
      return sendJson(res, 200, {
        ok: true,
        logs: await readJsonLines(AI_LOG_PATH, clampNumber(url.searchParams.get('limit'), 1, 200, 50))
      });
    }

    // rank13①：照片打卡上传，鉴权与 POST /api/checkins 同级（rate limit + owner headers）。
    if (req.method === 'POST' && url.pathname === '/api/checkin-photos') {
      enforceRateLimit(req, 'core-write');
      const body = await readJsonBody(req, MAX_CHECKIN_PHOTO_REQUEST_BYTES);
      // 照片必须归属已注册身份：resolveWriteProfile 对缺失/anonymous profileId
      // 有早退（不会触发 requireRegistered），这里显式拦截，堵住匿名整体绕过。
      const requestedPhotoProfileId = normalizeProfileId(body?.profileId);
      if (!requestedPhotoProfileId || requestedPhotoProfileId === 'anonymous') {
        throw createHttpError('上传打卡照片需要已注册的个人资料，请先同步身份后重试', 403, 'PROFILE_NOT_REGISTERED');
      }
      const actor = await resolveWriteProfile(req, body?.profileId, { requireRegistered: true });
      if (!actor.verified || actor.profileId === 'anonymous') {
        throw createHttpError('上传打卡照片需要已注册的个人资料，请先同步身份后重试', 403, 'PROFILE_NOT_REGISTERED');
      }
      // 幂等键与打卡同款进程内互斥，避免并发双传各自反扫不到而重复落盘。
      const result = await withSingleProcessKeyLock(
        checkinIdempotencyLocks,
        JSON.stringify(['photo', actor.profileId, sanitizePublicId(body?.routeId || body?.publicId), truncateString(body?.clientLocalId, 120)]),
        () => storeCheckinPhoto(body, actor)
      );
      return sendJson(res, 200, { ok: true, ...result });
    }

    // rank13②：照片读取，强缓存（内容不可变）。
    if (req.method === 'GET' && url.pathname.startsWith('/api/checkin-photos/')) {
      enforceRateLimit(req, 'public-read');
      const photoId = safeDecodePathSegment(url.pathname.replace('/api/checkin-photos/', ''));
      if (!CHECKIN_PHOTO_ID_PATTERN.test(photoId)) {
        throw createHttpError('照片不存在或已清理', 404, 'PHOTO_NOT_FOUND');
      }
      if (await sendCheckinPhotoFile(res, photoId)) return;
      throw createHttpError('照片不存在或已清理', 404, 'PHOTO_NOT_FOUND');
    }

	    if (req.method === 'POST' && url.pathname === '/api/checkins') {
	      enforceRateLimit(req, 'core-write');
	      const body = await readJsonBody(req);
	      const actor = await resolveWriteProfile(req, body?.profileId, { requireRegistered: true });
	      const routeId = sanitizePublicId(body?.routeId || body?.publicId);
	      const clientLocalId = truncateString(body?.clientLocalId, 120);
	      const persistCheckin = async () => {
	        if (clientLocalId) {
	          const existing = await findLatestJsonLine(
	            CHECKIN_LOG_PATH,
	            (item) => normalizeProfileId(item?.profileId) === actor.profileId
	              && sanitizePublicId(item?.routeId) === routeId
	              && item?.clientLocalId === clientLocalId
	          );
	          if (existing) return { checkin: existing, deduplicated: true };
	        }
	        const targetStop = await findStopForCheckin(body);
	        const previousCheckin = actor.profileId !== 'anonymous'
	          ? await findLatestJsonLine(
	            CHECKIN_LOG_PATH,
	            (item) => normalizeProfileId(item?.profileId) === actor.profileId && item?.gps
	          )
	          : null;
	        const arrival = applyTravelPlausibility(
	          buildArrivalEvidence(body, targetStop),
	          body?.gps && typeof body.gps === 'object' ? body.gps : null,
	          previousCheckin
	        );
          const resolvedCity = body?.city
            ? normalizeCityName(body.city)
            : targetStop?.city
              ? normalizeCityName(targetStop.city)
              : '';
        // rank13③：持久化照片证据 ID；落库前校验照片行存在且归属当前 profile，
        // 不符则置空 photoId（photoEvidence 记 ownership-mismatch），防挂他人照片。
        let photoId = normalizeCheckinPhotoId(body?.photoId);
        let photoEvidence = '';
        if (photoId) {
          const photoRow = await findLatestJsonLine(
            CHECKIN_PHOTO_LOG_PATH,
            (item) => String(item?.id ?? '') === photoId
          ).catch(() => null);
          if (!photoRow || normalizeProfileId(photoRow?.profileId) !== actor.profileId) {
            photoId = '';
            photoEvidence = 'ownership-mismatch';
          } else {
            const exifGps = photoRow?.exif && isValidCoordinate(Number(photoRow.exif.lat), Number(photoRow.exif.lng))
              ? { lat: Number(photoRow.exif.lat), lng: Number(photoRow.exif.lng) }
              : null;
            const photoDistance = exifGps && targetStop && isValidCoordinate(Number(targetStop.lat), Number(targetStop.lng))
              ? distanceMeters(exifGps, targetStop)
              : null;
            photoEvidence = Number.isFinite(photoDistance)
              ? (photoDistance <= CHECKIN_PHOTO_GPS_MATCH_METERS ? 'gps-match' : 'gps-mismatch')
              : 'no-exif';
          }
        }
	        const row = {
	          id: cryptoRandomId(),
	          trustState: actor.identityBound ? 'profile-attested' : actor.verified ? 'profile-owned' : 'untrusted',
	          profileId: actor.profileId,
	          routeId,
	          clientLocalId,
          routeTitle: truncateString(body?.routeTitle, 80),
          city: resolvedCity,
          localStopKey: truncateString(targetStop?.localStopKey || targetStop?.id || body?.localStopKey, 120),
          stopId: truncateString(targetStop?.id || body?.stopId, 80),
          poiId: resolvePoiId(targetStop ?? { name: body?.stopName }, resolvedCity),
          stopName: truncateString(targetStop?.name || body?.stopName, 60),
          serverResolvedStop: targetStop?.serverResolved === true,
          status: ['visited', 'skipped', 'replaced'].includes(body?.status) ? body.status : 'visited',
          replacementStopId: truncateString(body?.replacementStopId, 80),
          worth: truncateString(body?.worth, 20),
          queue: truncateString(body?.queue, 40),
          cost: truncateString(body?.cost, 40),
          crowd: truncateString(body?.crowd, 20),
          comment: truncateString(body?.comment, 300),
          pitfall: truncateString(body?.pitfall, 200),
          audience: truncateString(body?.audience, 80),
          photoName: truncateString(body?.photoName, 160),
          photoId,
          ...(photoEvidence ? { photoEvidence } : {}),
          observedAt: truncateString(body?.time || body?.observedAt, 60),
          // rank18①：保留客户端上报的坐标系（白名单）与 userAgent（截 160）。
          gps: body?.gps && typeof body.gps === 'object' ? {
            lat: clampNumber(body.gps.lat, -90, 90, 0),
            lng: clampNumber(body.gps.lng, -180, 180, 0),
            accuracy: clampNumber(body.gps.accuracy, 0, 10000, 0),
            coordinateSystem: normalizeCheckinCoordinateSystem(body.gps.coordinateSystem)
          } : null,
          userAgent: truncateString(body?.gps?.userAgent || body?.userAgent, 160),
          arrival,
          arrivalConfidence: arrival.confidence,
          createdAt: new Date().toISOString()
        };
        await appendJsonLine(CHECKIN_LOG_PATH, row);
        return { checkin: row, deduplicated: false };
      };
	      const result = clientLocalId
	        // JSONL needs a database uniqueness constraint before this can be safe across multiple processes.
	        ? await withSingleProcessKeyLock(
	            checkinIdempotencyLocks,
	            JSON.stringify([actor.profileId, routeId, clientLocalId]),
	            persistCheckin
	          )
	        : await persistCheckin();
	      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && url.pathname === '/api/checkins') {
      const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
      await verifySensitiveOrProfileReadAccess(req, profileId);
      const checkinLimit = clampNumber(url.searchParams.get('limit'), 1, 200, 50);
      // 按 profileId 谓词精确反扫，替代「全局尾窗 + filter」：热门时段其他用户的
      // 打卡会把当前用户的历史行挤出窗口，导致个人记录凭空消失。
      const checkins = profileId
        ? await readMatchingJsonLines(CHECKIN_LOG_PATH, (item) => normalizeProfileId(item?.profileId) === profileId, checkinLimit, 100000)
        : await readJsonLines(CHECKIN_LOG_PATH, checkinLimit);
      return sendJson(res, 200, { ok: true, checkins });
    }

    if (req.method === 'POST' && url.pathname === '/api/clicks') {
      // rank9：埋点类超限静默 204，不写库也不报错，避免客户端重试风暴。
      if (!consumeRateLimit(req, 'telemetry')) return sendTelemetryThrottled(req, res);
      const body = await readJsonBody(req);
      const actor = await resolveWriteProfile(req, body?.profileId);
      const { product, derived, seedFallback } = await resolveProductAttribution(body);
      const row = {
        id: cryptoRandomId(),
        profileId: actor.profileId,
        routeId: sanitizePublicId(derived.routeId),
        routeTitle: truncateString(derived.routeTitle, 80),
        stopId: truncateString(body?.stopId, 40),
        stopName: truncateString(body?.stopName, 80),
        productId: product.id,
        productTitle: product.title,
        type: product.type,
        poi: product.poi,
        provider: product.provider,
        source: truncateString(body?.source, 40) || 'unknown',
        sourcePosition: truncateString(body?.sourcePosition, 40),
        url: product.url,
        creatorId: sanitizePublicId(derived.creatorId),
        // rank-seed：保留 linkType 供运营台识别；seed 兜底行单独归组。
        ...(truncateString(body?.linkType, 40) ? { linkType: truncateString(body.linkType, 40) } : {}),
        ...(seedFallback ? { analyticsSource: 'seed-fallback' } : {}),
        createdAt: new Date().toISOString()
      };
      await appendJsonLine(CLICK_LOG_PATH, row);
      return sendJson(res, 200, { ok: true, click: row });
    }

    if (req.method === 'POST' && url.pathname === '/api/exposures') {
      // rank9：埋点类超限静默 204，不写库也不报错。
      if (!consumeRateLimit(req, 'telemetry')) return sendTelemetryThrottled(req, res);
      const body = await readJsonBody(req);
      // 曝光埋点防伪：itemType 走白名单；routebook-copy（含 copy-routebook
      // surface 伪装）只允许 /api/routebooks/:id/copy 内部落库。
      const requestedItemType = truncateString(body?.itemType || body?.type, 40) || 'routebook';
      if (INTERNAL_EXPOSURE_ITEM_TYPES.has(requestedItemType) || sanitizeExposureSurface(body?.surface) === 'copy-routebook') {
        throw createHttpError('路书复制事件只能由复制接口记录', 400, 'EXPOSURE_COPY_FORBIDDEN');
      }
      if (!PUBLIC_EXPOSURE_ITEM_TYPES.has(requestedItemType)) {
        throw createHttpError('曝光 itemType 不在白名单内', 400, 'EXPOSURE_ITEM_TYPE_INVALID');
      }
      const actor = await resolveWriteProfile(req, body?.profileId);
      const attributedBody = { ...body, profileId: actor.profileId };
      const row = (attributedBody?.itemType === 'product' || attributedBody?.productId)
        ? normalizeExposure(attributedBody, (await resolveProductAttribution(attributedBody)).derived)
        : normalizeExposure(attributedBody);
      await appendJsonLine(EXPOSURE_LOG_PATH, row);
      return sendJson(res, 200, { ok: true, exposure: row });
    }

    if (req.method === 'GET' && url.pathname === '/api/clicks') {
      const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
      await verifySensitiveOrProfileReadAccess(req, profileId);
      const clickLimit = clampNumber(url.searchParams.get('limit'), 1, 200, 50);
      const clicks = profileId
        ? await readMatchingJsonLines(CLICK_LOG_PATH, (item) => normalizeProfileId(item?.profileId) === profileId, clickLimit, 100000)
        : await readJsonLines(CLICK_LOG_PATH, clickLimit);
      return sendJson(res, 200, { ok: true, clicks });
    }

    if (req.method === 'GET' && url.pathname === '/api/product-analytics') {
      const profileId = url.searchParams.get('profileId') ? normalizeProfileId(url.searchParams.get('profileId')) : '';
      await verifySensitiveOrProfileReadAccess(req, profileId);
      return sendJson(res, 200, {
        ok: true,
        analytics: await buildProductAnalytics(clampNumber(url.searchParams.get('limit'), 50, 2000, 500), profileId)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/import-guide') {
      enforceRateLimit(req, 'ai');
      verifyApiAccess(req);
      const body = await readJsonBody(req);
      const urls = Array.isArray(body?.urls)
        ? body.urls.map((item) => truncateString(item, 800)).filter(Boolean)
        : extractUrls(body?.text);
      if (!urls.length) {
        throw createHttpError('请提供小红书、抖音、X 或公开网页链接', 400, 'SOURCE_URL_REQUIRED');
      }
      const uniqueUrls = [...new Set(urls)].slice(0, MAX_IMPORT_URLS);
      const signal = bindRequestAbortSignal(req);
      const analyzedSources = await Promise.all(uniqueUrls.map(async (sourceUrl) => {
        try {
          return await analyzeSourceUrl(sourceUrl, signal);
        } catch (error) {
          const platform = detectPlatform(sourceUrl);
          const safeUrl = safeSourceUrl(sourceUrl);
          return {
            url: safeUrl,
            finalUrl: safeUrl,
            platform: platform.name,
            platformId: platform.id,
            status: 'failed',
            title: `${platform.name} 链接待补充`,
            description: '',
            excerpt: '',
            trustScore: 28,
            signals: ['已识别链接来源'],
            warnings: [error.message ?? '链接无法公开抓取', platform.note],
            fetchedAt: new Date().toISOString()
          };
        }
      }));
      const sources = analyzedSources.map((source) => ({ ...source, proof: signImportedSource(source) }));
      const averageTrust = Math.round(sources.reduce((sum, source) => sum + source.trustScore, 0) / sources.length);
      const importLog = {
        id: cryptoRandomId(),
        sourceCount: sources.length,
        averageTrust,
        platforms: [...new Set(sources.map((source) => source.platform))],
        lowTrustCount: sources.filter((source) => source.trustScore < 45).length,
        createdAt: new Date().toISOString(),
        sources: sources.map((source) => ({
          url: source.url,
          platform: source.platform,
          status: source.status,
          title: source.title,
          trustScore: source.trustScore,
          warnings: source.warnings?.slice(0, 3) ?? []
        }))
      };
      await appendJsonLine(IMPORT_LOG_PATH, importLog);
      return sendJson(res, 200, {
        ok: true,
        importId: importLog.id,
        sourceCount: sources.length,
        averageTrust,
        sources,
        guideText: sources.map((source, index) => [
          `来源 ${index + 1}｜${source.platform}｜可信 ${source.trustScore}｜${source.status}`,
          `标题：${source.title}`,
          source.description ? `摘要：${source.description}` : '',
          source.excerpt ? `公开正文摘录：${source.excerpt}` : '',
          `可信信号：${source.signals.join('；')}`,
          `风险提示：${source.warnings.join('；')}`,
          `链接：${source.url}`
        ].filter(Boolean).join('\n')).join('\n\n')
      });
    }

	    if (req.method === 'GET' && url.pathname === '/api/imports') {
	      verifySensitiveReadAccess(req);
	      return sendJson(res, 200, {
	        ok: true,
	        imports: await readJsonLines(IMPORT_LOG_PATH, clampNumber(url.searchParams.get('limit'), 1, 200, 50))
	      });
	    }

	    throw createHttpError('接口不存在', 404, 'API_NOT_FOUND');
		  } catch (error) {
    if (error.upstreamDetail) {
      console.error(`[model] requestId=${req.requestId ?? 'unknown'} status=${error.upstreamStatus ?? error.statusCode ?? 500} code=${error.upstreamCode ?? error.code ?? 'MODEL_ERROR'}`);
    } else if ((error.statusCode ?? 500) >= 500) {
      console.error(`[server] requestId=${req.requestId ?? 'unknown'} status=${error.statusCode ?? 500} code=${error.code ?? 'SERVER_ERROR'}`);
    }
    return sendJson(res, error.statusCode ?? 500, {
      error: error.message ?? '服务器错误',
      code: error.code ?? 'SERVER_ERROR',
      ...(error.currentVersion != null ? { currentVersion: error.currentVersion } : {})
    });
  }
}

function cryptoRandomId() {
  if (typeof randomUUID === 'function') return randomUUID();
  return randomBytes(16).toString('hex');
}

async function sendStatic(req, res) {
  if (!existsSync(DIST_DIR)) {
    return sendJson(res, 503, {
      error: 'dist 不存在，请先运行 npm run build',
      code: 'DIST_MISSING'
    });
  }

  let decodedPath = '/';
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: '请求路径不合法', code: 'BAD_PATH' });
  }
  const normalizedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const requestedPath = resolve(DIST_DIR, `.${normalizedPath}`);
  const rootPath = resolve(DIST_DIR);
  const isInsideDist = requestedPath === rootPath || requestedPath.startsWith(`${rootPath}${sep}`);
  if (!isInsideDist) {
    return sendJson(res, 404, { error: '文件不存在', code: 'NOT_FOUND' });
  }
  const missingAsset = !existsSync(requestedPath) && extname(normalizedPath) !== '';
  if (missingAsset) {
    return sendJson(res, 404, { error: '文件不存在', code: 'NOT_FOUND' });
  }
  const filePath = existsSync(requestedPath) ? requestedPath : join(DIST_DIR, 'index.html');
  const ext = extname(filePath);

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      ...STATIC_SECURITY_HEADERS,
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: '文件不存在', code: 'NOT_FOUND' });
  }
}

// rank15①：/share/:id 与 /review/:id 的 H5 落地页注入 og meta（微信/朋友圈等
// 分享卡片抓不到 SPA 运行时标题）。读取失败或路书/回顾非公开时原样回退 index.html。
function matchShareLandingPath(req) {
  if (req.method !== 'GET') return null;
  let pathname = '';
  try {
    pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  } catch {
    return null;
  }
  const match = /^\/(share|review)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let decoded = '';
  try {
    decoded = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const id = sanitizePublicId(decoded);
  return id ? { kind: match[1], id } : null;
}

// 注入值统一做 HTML 实体转义，防止路书标题/摘要携带的 <script> 等内容注入页面。
function escapeHtmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('`', '&#96;');
}

async function buildShareLandingMeta(target) {
  try {
    if (target.kind === 'share') {
      const routebook = await getResolvableRoutebook(target.id);
      if (!routebook || !isPublicRoutebook(routebook)) return null;
      const title = truncateString(routebook.title, 80) || 'AI 可信路书';
      const city = routebook.city ? normalizeCityName(routebook.city) : '';
      return {
        title: `${title}｜AI 可信路书`,
        description: truncateString(routebook.summary, 160) || `${city ? `${city}的` : ''}可执行、可验证的分日路书。`,
        image: cityStories[city]?.image ?? defaultCityImage
      };
    }
    const review = await getSavedReview(target.id);
    if (!review || !isPublicRoutebook(review.routebook) || !(await reviewIsStillPublic(review))) return null;
    const routeTitle = truncateString(review.routebook?.title, 80) || 'AI 可信路书';
    const reviewCity = review.routebook?.city ? normalizeCityName(review.routebook.city) : '';
    const stats = review.stats && typeof review.stats === 'object' ? review.stats : {};
    return {
      title: `${routeTitle}｜旅行回顾`,
      description: truncateString(
        `真实打卡 ${clampNumber(stats.checkinCount, 0, 100000, 0)} 次，主线完成率 ${clampNumber(stats.completionRate, 0, 100, 0)}%，来自 AI 可信路书的可验证行程回顾。`,
        200
      ),
      image: cityStories[reviewCity]?.image ?? defaultCityImage
    };
  } catch {
    return null;
  }
}

function injectShareLandingMeta(html, meta) {
  const safeTitle = escapeHtmlText(meta.title);
  const safeDescription = escapeHtmlText(meta.description);
  const safeImage = escapeHtmlText(meta.image ?? '');
  const metaTags = [
    `<meta property="og:title" content="${safeTitle}">`,
    `<meta property="og:description" content="${safeDescription}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="AI 可信路书">',
    ...(safeImage ? [
      `<meta property="og:image" content="${safeImage}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:image" content="${safeImage}">`
    ] : [
      '<meta name="twitter:card" content="summary">'
    ]),
    `<meta name="description" content="${safeDescription}">`
  ].join('\n    ');
  // 用函数返回替换串：字符串形态的第二参会展开 $&/$` 等模板序列，
  // 标题里出现这些字符时会把原 HTML 片段拼进注入结果。
  let output = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${safeTitle}</title>`);
  if (output.includes('</head>')) {
    output = output.replace('</head>', () => `    ${metaTags}\n  </head>`);
  }
  return output;
}

// 返回 true 表示已响应；返回 false 让调用方回退到 vite/静态托管原样返回 index.html。
async function serveShareLandingHtml(req, res, target) {
  const meta = await buildShareLandingMeta(target);
  if (!meta) return false;
  // og:image 需要绝对 URL（微信/QQ 等抓取器不解析相对路径）；以请求来源组装 origin。
  if (meta.image?.startsWith('/')) {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() || 'http';
    const host = String(req.headers.host ?? '').split(',')[0].trim();
    if (host) meta.image = `${proto}://${host}${meta.image}`;
  }
  let html = '';
  try {
    if (vite) {
      html = await readFile(join(PROJECT_ROOT, 'index.html'), 'utf8');
      html = await vite.transformIndexHtml(req.url ?? `/${target.kind}/${target.id}`, html);
    } else {
      html = await readFile(join(DIST_DIR, 'index.html'), 'utf8');
    }
  } catch {
    return false;
  }
  const body = injectShareLandingMeta(html, meta);
  res.writeHead(200, {
    // dev 下 vite 会注入内联脚本（react-refresh preamble），不能带静态 CSP。
    ...(vite ? securityHeaders() : STATIC_SECURITY_HEADERS),
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache'
  });
  res.end(body);
  return true;
}

const vite = IS_PRODUCTION ? null : await createDevelopmentViteServer();

async function createDevelopmentViteServer() {
  const { createServer: createViteServer } = await import('vite');
  const preferredHmrPort = Number(process.env.VITE_HMR_PORT ?? 24679);
  const hmrPort = await findAvailablePort(preferredHmrPort, '0.0.0.0');
  return createViteServer({
    server: { middlewareMode: true, hmr: { host: HOST === '0.0.0.0' ? 'localhost' : HOST, port: hmrPort } },
    appType: 'spa'
  });
}

async function findAvailablePort(preferredPort, host = '127.0.0.1') {
  const start = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : 0;
  if (start === 0) return probeAvailablePort(0, host);
  for (let offset = 0; offset < 50; offset += 1) {
    const candidate = start + offset;
    const available = await probeAvailablePort(candidate, host).catch(() => null);
    if (available) return available;
  }
  return probeAvailablePort(0, host);
}

function probeAvailablePort(port, host = '127.0.0.1') {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once('error', rejectPort);
    server.listen(port, host, () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      server.close(() => resolvePort(resolvedPort));
    });
  });
}

function listen(port, attemptsLeft = 10) {
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/')) {
      assignRequestId(req, res);
      const handled = await handleApi(req, res);
      if (handled !== false) return;
    }
    // rank15①：分享/回顾落地页优先尝试注入 og meta，失败则回退默认托管路径。
    // 落地页构建要反扫路书/回顾 JSONL，挂 public-read 桶；超限不回 429，
    // 直接跳过注入回退纯静态 index.html（成本极低，分享打开也不至于报错页）。
    const shareLandingTarget = matchShareLandingPath(req);
    if (shareLandingTarget && consumeRateLimit(req, 'public-read')) {
      const served = await serveShareLandingHtml(req, res, shareLandingTarget).catch(() => false);
      if (served) return;
    }
    if (vite) {
      vite.middlewares(req, res);
      return;
    }
    await sendStatic(req, res);
  });
  server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS ?? 130000);
  server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS ?? 15000);

  const onError = (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    throw error;
  };

  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.off('error', onError);
    const mode = IS_PRODUCTION ? 'production' : 'dev';
    console.log(`Trusted Routebook ${mode} server: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}/`);
  });
}

listen(PORT);

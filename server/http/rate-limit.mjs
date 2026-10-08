// In-memory fixed-window rate limiting per client and category.
import { RATE_LIMIT_CORE_WRITE_MAX, RATE_LIMIT_MAP_TILE_MAX, RATE_LIMIT_MAX, RATE_LIMIT_PUBLIC_CONFIG_MAX, RATE_LIMIT_PUBLIC_READ_MAX, RATE_LIMIT_TELEMETRY_MAX, RATE_LIMIT_BUCKET_SWEEP_SIZE, RATE_LIMIT_WINDOW_MS } from '../config/index.mjs';
import { requestClientKey } from '../auth/request-access.mjs';
import { createHttpError } from '../lib/util.mjs';
import { requestIdHeaders, securityHeaders } from './response.mjs';

const rateLimitBuckets = new Map();

// rank9：写限流分桶。埋点（exposures/clicks）超限静默 204；AI 类沿用原低配额；
// 核心写（checkins/favorites/reviews/routebooks 及其子路由）独立配额；
// 其余写与未标注类别的调用沿用默认配额。桶按「客户端 key + 类别」隔离。
function rateLimitQuotaForCategory(category) {
  switch (category) {
    case 'telemetry': return RATE_LIMIT_TELEMETRY_MAX;
    case 'core-write': return RATE_LIMIT_CORE_WRITE_MAX;
    case 'map-tile': return RATE_LIMIT_MAP_TILE_MAX;
    case 'public-read': return RATE_LIMIT_PUBLIC_READ_MAX;
    case 'public-config': return RATE_LIMIT_PUBLIC_CONFIG_MAX;
    case 'ai':
    default: return RATE_LIMIT_MAX;
  }
}

function sweepExpiredRateLimitBuckets(now) {
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(key);
  }
}

export function consumeRateLimit(req, category = 'default') {
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

export function enforceRateLimit(req, category = 'default') {
  if (!consumeRateLimit(req, category)) {
    throw createHttpError('请求过于频繁，请稍后再试', 429, 'RATE_LIMITED');
  }
}

// rank9：埋点超限的静默响应。丢弃未读请求体以保持连接可复用，返回空 204。
export function sendTelemetryThrottled(req, res) {
  req.resume();
  res.writeHead(204, {
    ...securityHeaders(),
    ...requestIdHeaders(res)
  });
  res.end();
}

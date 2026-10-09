import { ROUTING_ERROR_CODES, RoutingError, isRoutingCancellation, routingIssueFromError } from './errors.mjs';
import { isValidCoordinate, routingCoordinateForStop } from './coordinates.mjs';

export const ROUTING_MODES = Object.freeze(['walking', 'driving', 'transit', 'bicycling']);
const MAX_ROUTING_CONCURRENCY = 8;

export function normalizeRouteLeg(candidate = {}, context = {}) {
  const status = candidate?.status === 'verified' ? 'verified' : 'unverified';
  const distanceMeters = finiteNonNegative(candidate?.distanceMeters);
  const durationSeconds = finiteNonNegative(candidate?.durationSeconds);
  const geometry = normalizeLegGeometry(candidate?.geometry);
  const queriedAt = normalizeQueriedAt(context?.queriedAt ?? candidate?.queriedAt);
  const base = {
    fromStopId: normalizeStopId(context?.fromStopId ?? candidate?.fromStopId),
    toStopId: normalizeStopId(context?.toStopId ?? candidate?.toStopId),
    mode: normalizeMode(context?.mode ?? candidate?.mode, { allowUnknown: true }),
    distanceMeters: null,
    durationSeconds: null,
    geometry: [],
    provider: normalizeProvider(context?.provider ?? candidate?.provider),
    queriedAt,
    status: 'unverified'
  };

  if (status === 'verified' && distanceMeters != null && durationSeconds != null && geometry.length >= 2 && queriedAt != null && base.provider !== 'none') {
    return {
      ...base,
      distanceMeters: Math.round(distanceMeters),
      durationSeconds: Math.round(durationSeconds),
      geometry,
      status: 'verified'
    };
  }

  const fallbackError = new RoutingError(ROUTING_ERROR_CODES.UPSTREAM_PAYLOAD_INVALID, '路径规划结果不完整，道路距离和时长未校验', {
    category: 'upstream_payload',
    retryable: true
  });
  return {
    ...base,
    error: candidate?.error && typeof candidate.error === 'object' ? normalizeIssue(candidate.error) : routingIssueFromError(context?.error ?? fallbackError)
  };
}

export function unverifiedRouteLeg(context = {}, error) {
  return normalizeRouteLeg({ status: 'unverified', error: routingIssueFromError(error) }, context);
}

/** @param {Record<string, any>} [options] */
export async function buildRouteLegs({
  routebook,
  stops = routebook?.stops,
  city = routebook?.city || '',
  provider = null,
  defaultMode = 'walking',
  modeForLeg,
  concurrency = 3,
  signal,
  now = () => new Date()
} = {}) {
  assertNotCancelled(signal);
  const sourceStops = Array.isArray(stops) ? stops : [];
  const tasks = adjacentSameDayPairs(sourceStops);
  const providerId = normalizeProvider(provider?.id || provider?.name || 'none');
  const providerConfigured = provider?.configured !== false && typeof provider?.route === 'function';
  const workerCount = normalizeConcurrency(concurrency, tasks.length);

  return mapWithConcurrency(
    tasks,
    workerCount,
    async ({ from, to, index }) => {
      assertNotCancelled(signal);
      const fromStopId = normalizeStopId(from?.id);
      const toStopId = normalizeStopId(to?.id);
      let mode;
      try {
        const perLegMode = typeof modeForLeg === 'function' ? await modeForLeg({ from, to, index, city }) : null;
        mode = normalizeMode(perLegMode || defaultMode);
      } catch (error) {
        if (isRoutingCancellation(error) || signal?.aborted) throw cancelledError();
        return unverifiedRouteLeg({ fromStopId, toStopId, mode: defaultMode, provider: providerId, queriedAt: null }, error);
      }

      const context = { fromStopId, toStopId, mode, provider: providerId, queriedAt: null };
      if (fromStopId == null || toStopId == null) {
        return unverifiedRouteLeg(
          context,
          new RoutingError(ROUTING_ERROR_CODES.STOP_ID_MISSING, '站点缺少稳定 ID，路段无法关联到路书', { category: 'input', retryable: false })
        );
      }

      let origin;
      let destination;
      try {
        origin = routingCoordinateForStop(from);
        destination = routingCoordinateForStop(to);
      } catch (error) {
        return unverifiedRouteLeg(context, error);
      }

      if (!providerConfigured) {
        return unverifiedRouteLeg(
          context,
          new RoutingError(ROUTING_ERROR_CODES.PROVIDER_NOT_CONFIGURED, '未配置路径规划服务，道路路线未校验', { category: 'configuration', retryable: false })
        );
      }

      const queriedAt = currentIso(now);
      try {
        const result = await provider.route({
          origin,
          destination,
          fromStop: from,
          toStop: to,
          mode,
          city,
          signal
        });
        assertNotCancelled(signal);
        // A reused (still verified) leg keeps the time it was actually queried.
        return normalizeRouteLeg(result, { ...context, queriedAt: result?.reusedQueriedAt ?? queriedAt });
      } catch (error) {
        if (isRoutingCancellation(error) || signal?.aborted) throw cancelledError();
        return unverifiedRouteLeg({ ...context, queriedAt }, error);
      }
    },
    signal
  );
}

export function normalizeLegGeometry(geometry) {
  if (!Array.isArray(geometry)) return [];
  const points = [];
  for (const point of geometry.slice(0, 20000)) {
    const rawLat = Array.isArray(point) ? point[0] : point?.lat;
    const rawLng = Array.isArray(point) ? point[1] : point?.lng;
    const lat = presentNumber(rawLat);
    const lng = presentNumber(rawLng);
    if (lat == null || lng == null || !isValidCoordinate(lat, lng)) continue;
    const normalized = [roundCoordinate(lat), roundCoordinate(lng)];
    const previous = points.at(-1);
    if (!previous || previous[0] !== normalized[0] || previous[1] !== normalized[1]) points.push(normalized);
  }
  return points;
}

function adjacentSameDayPairs(stops) {
  const pairs = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    if ((from?.day || 'Day 1') !== (to?.day || 'Day 1')) continue;
    pairs.push({ from, to, index });
  }
  return pairs;
}

async function mapWithConcurrency(items, concurrency, mapper, signal) {
  if (!items.length) return [];
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      assertNotCancelled(signal);
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return output;
}

function normalizeMode(value, { allowUnknown = false } = {}) {
  const mode = String(value || 'walking')
    .trim()
    .toLowerCase();
  if (ROUTING_MODES.includes(mode)) return mode;
  if (allowUnknown) return mode.slice(0, 24) || 'unknown';
  throw new RoutingError(ROUTING_ERROR_CODES.MODE_UNSUPPORTED, `不支持的路径模式：${mode.slice(0, 24) || '空'}`, { category: 'input', retryable: false });
}

function normalizeStopId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128);
  return null;
}

function normalizeProvider(value) {
  const provider = String(value || 'none')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return provider.slice(0, 40) || 'none';
}

function normalizeQueriedAt(value) {
  if (value == null || value === '') return null;
  const timestamp = Date.parse(value instanceof Date ? value.toISOString() : String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function currentIso(now) {
  const value = typeof now === 'function' ? now() : now;
  const parsed = normalizeQueriedAt(value);
  return parsed ?? new Date().toISOString();
}

function finiteNonNegative(value) {
  const number = presentNumber(value);
  if (number == null) return null;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function presentNumber(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundCoordinate(value) {
  return Number(value.toFixed(6));
}

function normalizeIssue(issue) {
  return routingIssueFromError(
    new RoutingError(issue.code, issue.message, {
      category: issue.category,
      retryable: issue.retryable,
      httpStatus: issue.httpStatus,
      upstreamCode: issue.upstreamCode
    })
  );
}

function normalizeConcurrency(value, itemCount) {
  if (!itemCount) return 1;
  const parsed = Number(value);
  const requested = Number.isFinite(parsed) ? Math.floor(parsed) : 3;
  return Math.max(1, Math.min(MAX_ROUTING_CONCURRENCY, itemCount, requested || 1));
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError() {
  return new RoutingError(ROUTING_ERROR_CODES.CANCELLED, '路径规划已取消', { category: 'cancelled', retryable: false });
}

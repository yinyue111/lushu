import { createHash } from 'node:crypto';
import { MAX_ROUTEBOOK_STOPS, TRIP_SESSION_LOG_PATH } from '../config/index.mjs';
import { createHttpError, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { appendJsonLine, findLatestJsonLine } from '../storage/jsonl.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';
import { withActiveProfileMutation } from '../auth/profile-lifecycle.mjs';
import { getResolvableRoutebook } from '../routebooks/normalize.mjs';
import { isPublicRoutebook, publicRoutebookStop } from '../routebooks/views.mjs';

function sessionKey(routeId, profileId) {
  return createHash('sha256')
    .update(`${normalizeProfileId(profileId)}:${sanitizePublicId(routeId)}`)
    .digest('hex');
}

export async function requireTripSessionRouteAccess(routeId, profileId) {
  const routebook = await getResolvableRoutebook(routeId);
  if (!routebook || routebook.tombstone || routebook.deletedAt) throw createHttpError('路书不存在或已删除', 404, 'ROUTEBOOK_NOT_FOUND');
  if (!isPublicRoutebook(routebook) && normalizeProfileId(routebook.profileId) !== normalizeProfileId(profileId)) {
    throw createHttpError('仅可同步本人草稿或公开路书的行中计划', 403, 'TRIP_SESSION_ROUTE_FORBIDDEN');
  }
  return routebook;
}

export async function getTripSessionSnapshot(routeId, profileId) {
  const key = sessionKey(routeId, profileId);
  const row = await findLatestJsonLine(TRIP_SESSION_LOG_PATH, (candidate) => candidate.sessionKey === key, Infinity);
  return row?.tombstone || row?.deletedAt ? null : row;
}

export async function saveTripSessionSnapshot(routeId, input, actor) {
  return withActiveProfileMutation(actor.profileId, async () => {
    const routebook = await requireTripSessionRouteAccess(routeId, actor.profileId);
    const previous = await getTripSessionSnapshot(routeId, actor.profileId);
    const currentVersion = previous?.revision || 0;
    const expected = Number(input?.expectedRevision);
    if (input?.expectedRevision === '' || input?.expectedRevision == null || !Number.isSafeInteger(expected) || expected < 0) {
      throw createHttpError('同步行程需要当前版本号', 400, 'TRIP_SESSION_REVISION_REQUIRED');
    }
    if (expected !== currentVersion) {
      const error = createHttpError('其他设备已更新行程，请加载云端版本后重试', 409, 'TRIP_SESSION_CONFLICT');
      error.currentVersion = currentVersion;
      throw error;
    }
    if (!Array.isArray(input?.stops) || !input.stops.length || input.stops.length > MAX_ROUTEBOOK_STOPS) {
      throw createHttpError(`行中计划需包含 1 至 ${MAX_ROUTEBOOK_STOPS} 个站点`, 400, 'TRIP_SESSION_STOPS_REQUIRED');
    }
    const stops = input.stops.map((stop, index) => ({
      ...publicRoutebookStop(stop),
      id: truncateString(stop?.id, 120) || `execution-stop-${index + 1}`,
      tripOriginalDay: truncateString(stop?.tripOriginalDay, 24),
      tripOriginalTime: truncateString(stop?.tripOriginalTime, 24),
      tripReplacementFor: truncateString(stop?.tripReplacementFor, 120),
      tripStatus: ['pending', 'visited', 'skipped'].includes(stop?.tripStatus) ? stop.tripStatus : 'pending'
    }));
    if (new Set(stops.map((stop) => stop.id)).size !== stops.length || stops.some((stop) => !stop.name)) {
      throw createHttpError('行中站点需有名称且 ID 不可重复', 400, 'TRIP_SESSION_STOPS_INVALID');
    }
    const now = new Date().toISOString();
    const requestedCurrentId = truncateString(input?.currentStopId, 120);
    const currentStopId = stops.some((stop) => stop.id === requestedCurrentId)
      ? requestedCurrentId
      : (stops.find((stop) => stop.tripStatus === 'pending') || stops[0]).id;
    const key = sessionKey(routeId, actor.profileId);
    const snapshot = {
      id: key,
      sessionKey: key,
      routeId: sanitizePublicId(routeId),
      profileId: actor.profileId,
      revision: currentVersion + 1,
      sourceRouteVersion: Math.max(1, Number(routebook.version) || 1),
      routeTitle: truncateString(routebook.title, 80),
      city: truncateString(routebook.city, 40),
      stops,
      currentStopId,
      lastMode: truncateString(input?.lastMode, 40),
      createdAt: previous?.createdAt || now,
      clientUpdatedAt: truncateString(input?.updatedAt, 60),
      updatedAt: now
    };
    await appendJsonLine(TRIP_SESSION_LOG_PATH, snapshot, { profileMutationLocked: true });
    return snapshot;
  });
}

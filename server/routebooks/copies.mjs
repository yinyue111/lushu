// Routebook copy counting from exposure logs.
import { sanitizePublicId } from '../lib/util.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';

export function copyActorKey(input = {}) {
  const profileId = normalizeProfileId(input?.profileId);
  if (profileId && profileId !== 'anonymous') return `profile:${profileId}`;
  const sessionId = sanitizePublicId(input?.sessionId);
  return sessionId ? `session:${sessionId}` : '';
}

// 只统计合法来源：内部复制接口落库的行一定带 itemType='routebook-copy'；
// 仅凭 surface='copy-routebook' 的行只可能来自历史客户端伪造直写，不再计入。
export function isRoutebookCopyExposure(event, routeId = '') {
  const eventRouteId = sanitizePublicId(event?.routeId || event?.itemId);
  return Boolean(
    event?.itemType === 'routebook-copy' &&
    (!routeId || eventRouteId === routeId)
  );
}

export function routebookCopyCount(exposures, routeId) {
  return new Set((exposures ?? [])
    .filter((event) => isRoutebookCopyExposure(event, routeId))
    .map(copyActorKey)
    .filter(Boolean)).size;
}

export function totalRoutebookCopyCount(exposures) {
  return new Set((exposures ?? [])
    .filter((event) => isRoutebookCopyExposure(event))
    .map((event) => {
      const routeId = sanitizePublicId(event?.routeId || event?.itemId);
      const actorKey = copyActorKey(event);
      return routeId && actorKey ? `${routeId}::${actorKey}` : '';
    })
    .filter(Boolean)).size;
}

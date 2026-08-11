const TRIP_SESSION_PREFIX = 'trusted-routebook:trip-session:v1';
const EXECUTION_VERSION = 1;

export function tripRoutebookId(routebook) {
  const explicitId = String(routebook?.publicId || routebook?.id || '').trim();
  if (explicitId) return explicitId;
  const fingerprint = JSON.stringify({
    city: routebook?.city ?? '',
    title: routebook?.title ?? '',
    stops: (routebook?.stops ?? []).map((stop) => [stop?.id ?? '', stop?.name ?? '', stop?.day ?? ''])
  });
  return `local-${hashString(fingerprint)}`;
}

export function normalizeTripStops(routebook, stops = routebook?.stops ?? []) {
  const routeId = tripRoutebookId(routebook);
  return (Array.isArray(stops) ? stops : []).map((stop, index) => ({
    ...stop,
    id: String(stop?.id ?? '').trim() || `trip-stop-${hashString(`${routeId}:${index}:${stop?.name ?? ''}`)}`
  }));
}

export function readTripSession(routebook, profileId = 'anonymous') {
  const routeId = tripRoutebookId(routebook);
  try {
    const session = JSON.parse(localStorage.getItem(tripSessionStorageKey(routebook, profileId)) ?? 'null');
    if (!session || session.version !== EXECUTION_VERSION) return null;
    if (String(session.routeId ?? '') !== routeId || String(session.profileId ?? '') !== String(profileId ?? 'anonymous')) return null;
    if (!Array.isArray(session.stops) || !session.stops.length) return null;
    return { ...session, stops: normalizeTripStops(routebook, session.stops) };
  } catch {
    return null;
  }
}

export function saveTripSession(routebook, profileId = 'anonymous', input = {}) {
  const routeId = tripRoutebookId(routebook);
  const previous = readTripSession(routebook, profileId);
  const session = {
    ...previous,
    ...input,
    version: EXECUTION_VERSION,
    routeId,
    profileId: String(profileId ?? 'anonymous'),
    createdAt: previous?.createdAt || new Date().toISOString(),
    stops: normalizeTripStops(routebook, input.stops ?? previous?.stops ?? routebook?.stops ?? []),
    updatedAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(tripSessionStorageKey(routebook, profileId), JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

// encode 侧已下线（回顾分享改走服务端 executionStops）；保留 decode 仅为兼容
// 历史分享链接里的 ?execution= 参数（旧版把执行路线编码进 URL）。
export function decodeTripExecution(value, routebook) {
  if (!value) return null;
  try {
    const base64 = String(value).replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (payload?.version !== EXECUTION_VERSION || payload?.routeId !== tripRoutebookId(routebook)) return null;
    if (!Array.isArray(payload.stops) || !payload.stops.length) return null;
    return { ...payload, stops: normalizeTripStops(routebook, payload.stops) };
  } catch {
    return null;
  }
}

function tripSessionStorageKey(routebook, profileId) {
  return `${TRIP_SESSION_PREFIX}:${encodeURIComponent(String(profileId ?? 'anonymous'))}:${encodeURIComponent(tripRoutebookId(routebook))}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

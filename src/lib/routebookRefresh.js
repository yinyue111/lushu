// Pure routebook version & refresh-conflict helpers shared by App.jsx and RouteView.
export function currentRoutebookVersion(routebook) {
  const version = Number(routebook?.version ?? routebook?.currentVersion ?? routebook?.revision);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

export function adoptNewerServerVersionScalars(target, serverRoutebook) {
  if (!target || !serverRoutebook) return;
  const serverVersion = currentRoutebookVersion(serverRoutebook);
  const targetVersion = currentRoutebookVersion(target);
  if (serverVersion == null || (targetVersion != null && serverVersion <= targetVersion)) return;
  if (serverRoutebook.version !== undefined) target.version = serverRoutebook.version;
  if (serverRoutebook.currentVersion !== undefined) target.currentVersion = serverRoutebook.currentVersion;
  if (serverRoutebook.editToken) target.editToken = serverRoutebook.editToken;
}

export function hasUnsyncedLocalEdits(routebook) {
  const editedAt = Date.parse(routebook?.provider?.editedAt ?? '');
  if (!Number.isFinite(editedAt)) return false;
  const syncedAt = Date.parse(routebook?.updatedAt ?? '');
  return !Number.isFinite(syncedAt) || editedAt > syncedAt;
}

export function hasRoutebookContentDifference(left, right) {
  if (!left || !right) return false;
  return routebookContentFingerprint(left) !== routebookContentFingerprint(right);
}

export function selectLatestLocalRoutebook(candidates, profileId, routeId = '') {
  const targetId = String(routeId || '').trim();
  const eligible = (Array.isArray(candidates) ? candidates : []).filter((book) => {
    if (!book) return false;
    const id = String(book.publicId || book.id || '').trim();
    if (targetId && id !== targetId) return false;
    return book.profileId === profileId || book.creator?.id === profileId;
  });
  if (!eligible.length) return null;
  return eligible.slice(1).reduce((best, candidate) => (compareLocalRoutebookSnapshots(candidate, best) > 0 ? candidate : best), eligible[0]);
}

export function routebookRemoteAdvanced(remote, local) {
  const remoteVersion = currentRoutebookVersion(remote);
  const localVersion = currentRoutebookVersion(local);
  if (remoteVersion != null && localVersion != null) return remoteVersion > localVersion;
  const remoteUpdated = Date.parse(remote?.updatedAt ?? '');
  const localUpdated = Date.parse(local?.updatedAt ?? '');
  if (!Number.isFinite(remoteUpdated)) return false;
  return !Number.isFinite(localUpdated) || remoteUpdated > localUpdated;
}

export function routebookRefreshDecision(remote, local, profileId, { remoteFromCache = false } = {}) {
  const remoteId = String(remote?.publicId || remote?.id || '').trim();
  const localId = String(local?.publicId || local?.id || '').trim();
  const sameRoute = Boolean(remoteId && localId && remoteId === localId);
  const localOwned = Boolean(local && (local.profileId === profileId || local.creator?.id === profileId));
  const localDirty = hasUnsyncedLocalEdits(local);
  const contentDiverged = sameRoute && hasRoutebookContentDifference(remote, local);
  const remoteVersion = currentRoutebookVersion(remote);
  const localVersion = currentRoutebookVersion(local);
  const versionDiverged = remoteVersion != null && localVersion != null && remoteVersion !== localVersion;
  const preserveLocal = Boolean(sameRoute && localOwned && localDirty && contentDiverged);
  const remoteAdvanced = !remoteFromCache && routebookRemoteAdvanced(remote, local);
  const conflict = Boolean(preserveLocal && remoteAdvanced);
  return {
    remoteFromCache: Boolean(remoteFromCache),
    remoteAdvanced,
    conflict,
    sameRoute,
    localOwned,
    localDirty,
    contentDiverged,
    versionDiverged,
    remoteVersion,
    localVersion,
    preserveLocal,
    reason: conflict ? 'local-dirty-remote-advanced' : preserveLocal ? (remoteFromCache ? 'local-dirty-offline-cache' : 'local-dirty-refresh-race') : ''
  };
}

export function routebookRefreshConflictKey(remote, local) {
  return [
    String(remote?.publicId || remote?.id || ''),
    currentRoutebookVersion(remote) ?? '',
    currentRoutebookVersion(local) ?? '',
    remote?.updatedAt ?? '',
    local?.updatedAt ?? '',
    remote?.provider?.editedAt ?? '',
    local?.provider?.editedAt ?? '',
    routebookContentFingerprint(remote),
    routebookContentFingerprint(local)
  ].join('|');
}

function compareLocalRoutebookSnapshots(left, right) {
  const leftDirty = hasUnsyncedLocalEdits(left);
  const rightDirty = hasUnsyncedLocalEdits(right);
  if (leftDirty !== rightDirty) return leftDirty ? 1 : -1;
  const leftTimestamp = routebookSnapshotTimestamp(left);
  const rightTimestamp = routebookSnapshotTimestamp(right);
  if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
  return (currentRoutebookVersion(left) ?? -1) - (currentRoutebookVersion(right) ?? -1);
}

function routebookSnapshotTimestamp(routebook) {
  const timestamps = [routebook?.provider?.editedAt, routebook?.updatedAt, routebook?.provider?.generatedAt, routebook?.createdAt]
    .map((value) => Date.parse(value ?? ''))
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : 0;
}

function routebookContentFingerprint(routebook) {
  return JSON.stringify(
    canonicalizeRoutebookValue({
      city: routebook?.city,
      title: routebook?.title,
      summary: routebook?.summary,
      days: routebook?.days,
      stops: routebook?.stops,
      variants: routebook?.variants,
      activeVariantId: routebook?.activeVariantId,
      constraints: routebook?.constraints,
      routeLegs: routebook?.routeLegs,
      importedSources: routebook?.importedSources
    })
  );
}

function canonicalizeRoutebookValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeRoutebookValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalizeRoutebookValue(value[key]);
      return result;
    }, {});
}

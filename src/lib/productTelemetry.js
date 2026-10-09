import { recordClick, recordExposure } from './api.js';

// One browser page session. No persistent cross-site identifier is created.
const sessionId = `ps_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const exposures = new Map();

function keyFor(input) {
  return JSON.stringify([
    input.profileId || 'anonymous',
    input.surface || '',
    input.routeId || '',
    String(input.stopId ?? ''),
    input.productId || input.itemId || ''
  ]);
}

export function recordProductExposure(input) {
  const key = keyFor(input);
  if (exposures.has(key)) return exposures.get(key).promise;
  const exposureId = `pe_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const payload = { ...input, itemType: 'product', itemId: input.productId || input.itemId, sessionId, exposureId };
  const entry = { exposureId, confirmed: false, promise: null };
  entry.promise = recordExposure(payload)
    .then((response) => {
      entry.confirmed = response?.exposure?.exposureId === exposureId;
      return response;
    })
    .catch((error) => {
      entry.confirmed = false;
      throw error;
    });
  exposures.set(key, entry);
  // Limit memory without inventing replacement impressions on click.
  if (exposures.size > 1000) exposures.delete(exposures.keys().next().value);
  return entry.promise;
}

export async function recordProductClick(input) {
  const entry = exposures.get(keyFor(input));
  if (entry) await entry.promise.catch(() => {});
  // A failed or absent render-time exposure remains an unattributed raw click.
  // Never manufacture an exposure just because the user clicked.
  return recordClick({ ...input, sessionId, exposureId: entry?.confirmed ? entry.exposureId : '' });
}

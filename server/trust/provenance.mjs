// Per-stop provenance: where a stop came from and which verifiable signals back
// it. Derived by code only (text matching against the user's own input, the
// server-signed imported sources and the reviewed POI catalog); the model is
// never asked to report its own sources.
import { createHmac } from 'node:crypto';
import { curatedRoutes } from '../../src/lib/content.js';
import { countVerifiedPoiFacts, currentPoiPrice, findTrustedPoi } from '../poi/catalog.mjs';
import { parseCostText } from '../../src/lib/cost.js';
import { truncateString } from '../lib/util.mjs';
import { PROFILE_ID_SECRET } from '../config/index.mjs';
import { safeEqualHex } from '../auth/tokens.mjs';
import { findPlaceMention, normalizePlaceText, normalizeStopOrigin, routeEvidenceScore } from '../../src/lib/trustSignals.js';

function signedSourceTexts(importedSources = []) {
  return (Array.isArray(importedSources) ? importedSources : [])
    .filter((source) => source?.proof && source?.status !== 'failed')
    .map((source) => [source.title, source.description, source.excerpt].filter(Boolean).join('\n'));
}

function catalogSignals(name, city, nowMs) {
  const trusted = findTrustedPoi({ name }, city);
  return {
    trusted,
    reviewedPoi: Boolean(trusted),
    verifiedFactCount: countVerifiedPoiFacts(trusted, nowMs),
    poiAliases: trusted ? [trusted.name, ...(trusted.aliases ?? [])] : []
  };
}

// A `user-guide` origin can only be established at generation time, when the
// user's text is available, so it is signed; a client cannot upgrade a stop to
// "来自你的攻略" on save without the server having seen the mention.
function provenanceProof(origin, name, matchedText) {
  return createHmac('sha256', PROFILE_ID_SECRET).update(`stop-provenance|${origin}|${name}|${matchedText}`).digest('hex');
}

/**
 * Provenance at generation time, when the user's guide text is available.
 * @param {any} stop
 * @param {{ city?: string, guideText?: string, mustGo?: string, importedSources?: any[], nowMs?: number }} context
 */
export function deriveStopProvenance(stop, { city = '', guideText = '', mustGo = '', importedSources = [], nowMs = Date.now() } = {}) {
  const name = truncateString(stop?.name, 48);
  const { reviewedPoi, verifiedFactCount, poiAliases } = catalogSignals(name, city, nowMs);
  const userMatch = findPlaceMention(`${guideText}\n${mustGo}`, name, poiAliases);
  const sourceMatch = userMatch
    ? ''
    : signedSourceTexts(importedSources)
        .map((text) => findPlaceMention(text, name, poiAliases))
        .find(Boolean) || '';
  const origin = userMatch ? 'user-guide' : sourceMatch ? 'imported-source' : 'model';
  const matchedText = truncateString(userMatch || sourceMatch, 48);
  return {
    origin,
    matchedText,
    name,
    reviewedPoi,
    verifiedFactCount,
    derivedAt: new Date(nowMs).toISOString(),
    ...(origin === 'user-guide' ? { proof: provenanceProof(origin, name, matchedText) } : {})
  };
}

/**
 * Provenance on save/read. `reviewedPoi` and `verifiedFactCount` are always
 * recomputed from the current catalog. The origin recorded at generation is
 * kept while the stop keeps its name; a renamed stop becomes `user-added`.
 * Stops saved before provenance existed are `unknown` unless a signed imported
 * source mentions them.
 * @param {any} stop
 * @param {string} name normalized stop name
 * @param {{ city?: string, importedSources?: any[], nowMs?: number }} context
 */
const curatedStopNames = new Map();
function isCuratedStopName(name, city) {
  if (!curatedStopNames.size) {
    for (const route of curatedRoutes) {
      for (const stop of route.stops ?? []) curatedStopNames.set(`${route.city}|${normalizePlaceText(stop.name)}`, true);
    }
  }
  return curatedStopNames.has(`${city}|${normalizePlaceText(name)}`);
}

export function normalizeStopProvenance(stop, name, { city = '', importedSources = [], nowMs = Date.now() } = {}) {
  const input = stop?.provenance && typeof stop.provenance === 'object' ? stop.provenance : null;
  const { reviewedPoi, verifiedFactCount, poiAliases } = catalogSignals(name, city, nowMs);
  let origin = 'unknown';
  let matchedText = '';
  if (input) {
    const recordedName = truncateString(input.name, 48);
    const sameName = !recordedName || normalizePlaceText(recordedName) === normalizePlaceText(name);
    origin = sameName ? normalizeStopOrigin(input.origin) : 'user-added';
    matchedText = sameName ? truncateString(input.matchedText, 48) : '';
    if (origin === 'editorial' && !isCuratedStopName(name, city)) {
      // 只有编辑部精选路线里的站名才能自称「编辑部选的点」；其余一律当用户自己加的。
      origin = 'user-added';
    }
    if (origin === 'user-guide' && !safeEqualHex(String(input.proof ?? ''), provenanceProof('user-guide', recordedName || name, matchedText))) {
      // Unsigned claim: the user did supply this stop, but not verifiably from their guide text.
      origin = 'user-added';
      matchedText = '';
    }
  }
  if (origin === 'unknown' || origin === 'model' || origin === 'imported-source') {
    const sourceMatch = signedSourceTexts(importedSources)
      .map((text) => findPlaceMention(text, name, poiAliases))
      .find(Boolean);
    if (sourceMatch) {
      origin = 'imported-source';
      matchedText = truncateString(sourceMatch, 48);
    } else if (origin === 'imported-source') {
      // The signed source no longer mentions it (or was removed): do not keep the claim.
      origin = input ? 'model' : 'unknown';
      matchedText = '';
    }
  }
  return {
    origin,
    matchedText,
    name,
    reviewedPoi,
    verifiedFactCount,
    derivedAt: truncateString(input?.derivedAt, 60) || new Date(nowMs).toISOString(),
    ...(origin === 'user-guide' ? { proof: provenanceProof(origin, name, matchedText) } : {})
  };
}

/** Recomputes catalog-derived signals (facts expire) and returns the evidence score. */
export function routebookEvidence(routebook, nowMs = Date.now()) {
  const stops = (routebook?.stops ?? []).map((stop) => {
    const { trusted, reviewedPoi, verifiedFactCount } = catalogSignals(stop?.name, routebook?.city, nowMs);
    // Phase 2: a reviewed, evidence-backed, unexpired price fact is attached at
    // read time (never stored), so it disappears when the fact expires.
    const price = currentPoiPrice(trusted, nowMs);
    const { verifiedPrice: _stale, ...rest } = stop ?? {};
    return {
      ...rest,
      provenance: { ...(stop?.provenance ?? { origin: 'unknown' }), reviewedPoi, verifiedFactCount },
      ...(price ? { verifiedPrice: { ...price, costInfo: { ...parseCostText(price.text), source: 'poi-fact' } } } : {})
    };
  });
  return { stops, ...routeEvidenceScore(stops) };
}

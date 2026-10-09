// Pure rules for canonical POIs: which human merge decisions are in effect, and which POI
// pairs look like duplicates. Nothing here merges anything by itself — candidates only
// enter an ops review queue, and only a recorded human decision changes lookups.
import { distanceMeters, isValidCoordinate } from '../lib/util.mjs';
import { classifyNameMatch, nameSimilarity } from '../geo/geocodeChooser.mjs';

export const POI_MERGE_DECISIONS = Object.freeze(['merge', 'reject', 'unmerge']);

export function poiPairKey(left, right) {
  return [String(left ?? ''), String(right ?? '')].sort().join('|');
}

/**
 * Replays decisions in chronological order.
 * - merge: duplicate → canonical, only when it cannot form a chain or a cycle
 *   (duplicate is not itself a canonical, canonical is not itself merged away, and the
 *   duplicate is not already merged elsewhere). Otherwise the row is kept as `conflict`.
 * - unmerge: removes the active merge for that pair.
 * - reject: records "not a duplicate" so the pair leaves the candidate queue; ignored while
 *   the pair is actively merged (unmerge first).
 * @param {Array<any>} rowsOldestFirst
 */
export function replayPoiMergeDecisions(rowsOldestFirst) {
  /** @type {Map<string, string>} */
  const redirects = new Map();
  /** @type {Map<string, Set<string>>} */
  const mergedInto = new Map();
  /** @type {Map<string, any>} */
  const pairs = new Map();
  const conflicts = [];
  for (const row of Array.isArray(rowsOldestFirst) ? rowsOldestFirst : []) {
    if (row?.type !== 'poi-merge-decision' || !POI_MERGE_DECISIONS.includes(row.decision)) continue;
    const canonical = String(row.canonicalPoiId ?? '');
    const duplicate = String(row.duplicatePoiId ?? '');
    if (!canonical || !duplicate || canonical === duplicate) continue;
    const key = poiPairKey(canonical, duplicate);
    const activeMerge = pairs.get(key)?.decision === 'merge' && redirects.get(pairs.get(key).duplicatePoiId) === pairs.get(key).canonicalPoiId;
    if (row.decision === 'merge') {
      const blocked = mergedInto.get(duplicate)?.size || redirects.has(canonical) || redirects.has(duplicate);
      if (blocked) {
        conflicts.push(row);
        continue;
      }
      redirects.set(duplicate, canonical);
      if (!mergedInto.has(canonical)) mergedInto.set(canonical, new Set());
      mergedInto.get(canonical).add(duplicate);
    } else if (row.decision === 'unmerge') {
      if (!activeMerge) {
        conflicts.push(row);
        continue;
      }
      const previous = pairs.get(key);
      redirects.delete(previous.duplicatePoiId);
      mergedInto.get(previous.canonicalPoiId)?.delete(previous.duplicatePoiId);
    } else if (activeMerge) {
      conflicts.push(row);
      continue;
    }
    pairs.set(key, row);
  }
  return { redirects, pairs, conflicts };
}

export function canonicalPoiIdFrom(redirects, poiId) {
  let current = String(poiId ?? '');
  // Writes forbid chains; the depth bound only guards hand-edited data.
  for (let depth = 0; depth < 4 && redirects?.has(current); depth += 1) current = redirects.get(current);
  return current;
}

function poiCoordinate(poi) {
  const lat = Number(poi?.location?.lat ?? poi?.lat);
  const lng = Number(poi?.location?.lng ?? poi?.lng);
  return isValidCoordinate(lat, lng) ? { lat, lng } : null;
}

const MATCH_POINTS = Object.freeze({ exact: 60, alias: 45, contains: 30 });

function nameMatchBetween(left, right) {
  const forward = classifyNameMatch(left?.name, right?.name, left?.aliases);
  const backward = classifyNameMatch(right?.name, left?.name, right?.aliases);
  const ranked = [forward, backward].filter(Boolean).sort((a, b) => MATCH_POINTS[b] - MATCH_POINTS[a]);
  return ranked[0] ?? null;
}

/**
 * Same-city pairs that may be the same place. A pair qualifies when the names match by a
 * rule (exact / alias / bounded containment) and the points are not far apart, or when the
 * points nearly coincide and the names are at least loosely similar. Pairs whose latest
 * decision is merge or reject are left out.
 */
export function findPoiDuplicateCandidates(pois, { pairs = new Map(), redirects = new Map(), city = '', limit = 100 } = {}) {
  const byCity = new Map();
  for (const poi of Array.isArray(pois) ? pois : []) {
    if (!poi?.poiId || !poi?.city || redirects.has(poi.poiId)) continue;
    if (city && poi.city !== city) continue;
    if (!byCity.has(poi.city)) byCity.set(poi.city, []);
    byCity.get(poi.city).push(poi);
  }
  const candidates = [];
  for (const cityPois of byCity.values()) {
    cityPois.sort((a, b) => String(a.poiId).localeCompare(String(b.poiId)));
    for (let i = 0; i < cityPois.length; i += 1) {
      for (let j = i + 1; j < cityPois.length; j += 1) {
        const left = cityPois[i];
        const right = cityPois[j];
        // merge / reject settle a pair; after an unmerge it is open for review again.
        if (['merge', 'reject'].includes(pairs.get(poiPairKey(left.poiId, right.poiId))?.decision)) continue;
        const match = nameMatchBetween(left, right);
        const similarity = Number(nameSimilarity(left.name, right.name).toFixed(3));
        const a = poiCoordinate(left);
        const b = poiCoordinate(right);
        const distance = a && b ? Math.round(distanceMeters(a, b)) : null;
        const qualifies = (match && (distance == null || distance <= 1000)) || (distance != null && distance <= 150 && similarity >= 0.4);
        if (!qualifies) continue;
        const reasons = [];
        if (match) reasons.push(`name-${match}`);
        if (similarity > 0) reasons.push(`similarity-${similarity}`);
        reasons.push(distance == null ? 'distance-unknown' : `distance-${distance}m`);
        const proximityPoints = distance == null ? 0 : distance <= 50 ? 30 : distance <= 150 ? 20 : distance <= 500 ? 10 : 0;
        candidates.push({
          pairKey: poiPairKey(left.poiId, right.poiId),
          city: left.city,
          score: (match ? MATCH_POINTS[match] : 0) + Math.round(similarity * 10) + proximityPoints,
          nameMatch: match,
          similarity,
          distanceMeters: distance,
          reasons,
          pois: [left, right].map((poi) => ({
            poiId: poi.poiId,
            name: poi.name,
            aliases: Array.isArray(poi.aliases) ? poi.aliases : [],
            sourceKind: poi.sourceKind ?? '',
            reviewStatus: poi.reviewStatus ?? '',
            factCount: Array.isArray(poi.facts) ? poi.facts.length : 0,
            location: poiCoordinate(poi)
          }))
        });
      }
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.pairKey.localeCompare(y.pairKey));
  return candidates.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

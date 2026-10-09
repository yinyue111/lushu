// Deterministic choice among geocoder POI candidates.
//
// A candidate is accepted only when its name matches the query by a rule we can explain:
// exact (after normalisation), a known alias / generic-suffix variant, or one name
// containing the other. Character-bigram similarity only ranks candidates that already
// passed one of those rules; it never accepts a candidate on its own. Ties break on the
// provider's own rank, then on candidate id, so the same inputs always pick the same POI.
import { normalizePlaceText, placeNameVariants } from '../../src/lib/trustSignals.js';

export const GEOCODE_PRECISION = Object.freeze({
  POI_EXACT: 'poi-exact',
  POI_NAME_MATCH: 'poi-name-match',
  ADDRESS: 'address',
  ROAD: 'road',
  APPROXIMATE: 'approximate'
});

// Extra metres added to the check-in arrival radius for a stop whose coordinate is less
// precise than an exact POI. Kept modest so a coarse coordinate never buys a large radius;
// anything coarser than "road" is not precise enough to count arrivals at all.
export const ARRIVAL_RADIUS_EXTRA_METERS = Object.freeze({
  [GEOCODE_PRECISION.POI_EXACT]: 0,
  exact: 0,
  [GEOCODE_PRECISION.POI_NAME_MATCH]: 50,
  [GEOCODE_PRECISION.ADDRESS]: 100,
  [GEOCODE_PRECISION.ROAD]: 250
});

export function arrivalRadiusExtraMeters(precision) {
  return ARRIVAL_RADIUS_EXTRA_METERS[String(precision ?? '')] ?? 0;
}

function bigrams(text) {
  const grams = new Set();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

export function nameSimilarity(left, right) {
  const a = normalizePlaceText(left);
  const b = normalizePlaceText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  if (!gramsA.size || !gramsB.size) return 0;
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared += 1;
  return (2 * shared) / (gramsA.size + gramsB.size);
}

const MATCH_RANK = Object.freeze({ exact: 3, alias: 2, contains: 1 });

export function classifyNameMatch(query, candidateName, aliases = []) {
  const normalizedQuery = normalizePlaceText(query);
  const normalizedCandidate = normalizePlaceText(candidateName);
  if (!normalizedQuery || !normalizedCandidate) return null;
  if (normalizedQuery === normalizedCandidate) return 'exact';
  const queryVariants = new Set(placeNameVariants(query, aliases));
  const candidateVariants = placeNameVariants(candidateName);
  if (candidateVariants.some((variant) => queryVariants.has(variant))) return 'alias';
  // Containment needs at least 2 shared characters and the shorter name to cover half
  // of the longer one, so "西湖" does not match "西湖区第三人民医院".
  const [shorter, longer] =
    normalizedQuery.length <= normalizedCandidate.length ? [normalizedQuery, normalizedCandidate] : [normalizedCandidate, normalizedQuery];
  if (shorter.length >= 2 && longer.includes(shorter) && shorter.length * 2 >= longer.length) return 'contains';
  return null;
}

/**
 * @param {{ name: string, aliases?: string[] }} query
 * @param {Array<any>} candidates
 */
export function chooseGeocodeCandidate(query, candidates) {
  const scored = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const matchType = classifyNameMatch(query?.name, candidate?.name, query?.aliases);
    return {
      candidate,
      matchType,
      similarity: Number(nameSimilarity(query?.name, candidate?.name).toFixed(4)),
      rank: Number.isFinite(candidate?.rank) ? Number(candidate.rank) : index
    };
  });
  const accepted = scored
    .filter((entry) => entry.matchType)
    .sort(
      (left, right) =>
        MATCH_RANK[right.matchType] - MATCH_RANK[left.matchType] ||
        right.similarity - left.similarity ||
        left.rank - right.rank ||
        String(left.candidate?.id ?? '').localeCompare(String(right.candidate?.id ?? ''))
    );
  const best = accepted[0] ?? null;
  return {
    chosen: best?.candidate ?? null,
    matchType: best?.matchType ?? null,
    similarity: best?.similarity ?? 0,
    precision: best ? (best.matchType === 'contains' ? GEOCODE_PRECISION.POI_NAME_MATCH : GEOCODE_PRECISION.POI_EXACT) : null,
    candidateCount: scored.length,
    acceptedCount: accepted.length,
    reason: best ? `name-${best.matchType}` : scored.length ? 'no-name-match' : 'no-candidates'
  };
}

/** Maps an AMap geocode/geo `level` to our precision scale. */
export function precisionFromAmapLevel(level) {
  const text = String(level ?? '');
  if (/兴趣点|门牌号/.test(text)) return GEOCODE_PRECISION.ADDRESS;
  if (/道路|交叉路口/.test(text)) return GEOCODE_PRECISION.ROAD;
  return GEOCODE_PRECISION.APPROXIMATE;
}

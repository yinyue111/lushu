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

// A name that merely *contains* the query is often a business named after the sight
// ("西湖音乐喷泉公寓酒店", "全季酒店…音乐喷泉店停车场"): same words, different place.
// Containment is refused when the candidate is lodging / parking / transit by AMap
// typecode, or when the extra text names such a facility or a branch ("…店"), unless the
// query itself asks for that kind of place.
const FACILITY_TYPECODE = /^(10|1505|1507|1509)/;
const FACILITY_WORDS = /酒店|宾馆|饭店|公寓|民宿|客栈|旅馆|青旅|停车场|停车库|出入口|售票|公交站|地铁站|充电站|店$|店\)|分店/;

export function isFacilityMismatch(query, candidate) {
  const normalizedQuery = normalizePlaceText(query);
  if (FACILITY_WORDS.test(normalizedQuery)) return false;
  if (FACILITY_TYPECODE.test(String(candidate?.typecode ?? ''))) return true;
  const normalizedCandidate = normalizePlaceText(candidate?.name);
  const remainder = normalizedCandidate.split(normalizedQuery).join(' ');
  return FACILITY_WORDS.test(remainder) || FACILITY_WORDS.test(String(candidate?.name ?? '').replace(String(query ?? ''), ' '));
}

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
    const nameMatch = classifyNameMatch(query?.name, candidate?.name, query?.aliases);
    const facilityMismatch = nameMatch === 'contains' && isFacilityMismatch(query?.name, candidate);
    return {
      candidate,
      matchType: facilityMismatch ? null : nameMatch,
      facilityMismatch,
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
    facilityRejectedCount: scored.filter((entry) => entry.facilityMismatch).length,
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

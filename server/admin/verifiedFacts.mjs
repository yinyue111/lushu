// Operator-verified facts ("设为核实值"). Keyed like the enrichment cache (city|place|field) and served
// before it until expires_at (enrich.verifiedFactDays, default 90). Phase 2 grows this into the verified
// places library (docs/admin.md §8): the record already carries value, sources, verifier, verified-at, expiry, scope.
import { adminStore } from './store.mjs';

const FIELD_LABEL = { price: '门票', hours: '开放时间' };

/** Claim shape the routebook view understands, or null. Never throws (enrichment must not fail on this). */
export async function verifiedFactClaim(cacheKey, now = Date.now()) {
  try {
    const fact = await adminStore().getVerifiedFact(cacheKey, now);
    if (!fact) return null;
    const day = String(fact.verifiedAt).slice(0, 10);
    return {
      status: 'filled',
      value: fact.value,
      display: `${FIELD_LABEL[fact.field] ?? fact.field}：${fact.value} · 人工核实 · ${day}`,
      sources: fact.sources,
      retrievedAt: fact.verifiedAt,
      method: 'ops-verified',
      verifiedAt: fact.verifiedAt,
      expiresAt: fact.expiresAt
    };
  } catch {
    return null;
  }
}

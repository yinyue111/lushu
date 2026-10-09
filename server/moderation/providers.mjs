// Moderation providers. 'keyword' (default) runs the local pre-filter only. 'domestic' adds
// a call to a domestic content-safety API through a generic adapter; this is a stub
// contract (POST {text, scene} → {decision: pass|review|block, labels: []}) that must be
// mapped to the chosen vendor's real API before use. Any failure falls back to 'review',
// so unchecked content is held for ops rather than published.
/** @param {{ url?: string, apiKey?: string, timeoutMs?: number, fetchImpl?: any }} [options] */
export function createDomesticModerationAdapter({ url = '', apiKey = '', timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'domestic',
    configured: Boolean(url && apiKey),
    /** @param {string} text @param {string} scene */
    async check(text, scene) {
      if (!url || !apiKey) return { decision: 'review', labels: ['provider-not-configured'] };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ text, scene }),
          signal: controller.signal
        });
        if (!response.ok) return { decision: 'review', labels: [`provider-http-${response.status}`] };
        const data = await response.json();
        const decision = ['pass', 'review', 'block'].includes(data?.decision) ? data.decision : 'review';
        const labels = Array.isArray(data?.labels) ? data.labels.slice(0, 10).map((label) => String(label).slice(0, 40)) : [];
        return { decision, labels };
      } catch {
        return { decision: 'review', labels: ['provider-unavailable'] };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

const RANK = { pass: 0, review: 1, block: 2 };
export function strictestDecision(...decisions) {
  return decisions.reduce((worst, next) => (RANK[next] > RANK[worst] ? next : worst), 'pass');
}

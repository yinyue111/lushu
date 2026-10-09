// Shared pacing for AMap Web-service calls (POI search, geocoding, route planning).
// Personal AMap keys allow only a few requests per second per service; bursts from parallel
// geocoding/routing came back as infocode 10021 CUQPS_HAS_EXCEEDED_THE_LIMIT and silently
// downgraded stops to "approximate" and legs to "unverified". Calls are spaced to AMAP_QPS
// and a QPS rejection is retried once after a short pause. Request URLs (which carry the key)
// are never logged here.
const QPS_INFOCODES = new Set(['10014', '10019', '10020', '10021']);

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

export function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(
      () => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      },
      Math.max(0, ms)
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * @param {{ qps?: number, fetchImpl?: (url: any, init?: any) => Promise<any>, retryDelayMs?: number, now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} [options]
 */
export function createPacedAmapFetch({ qps = 3, fetchImpl, retryDelayMs = 1100, now = () => Date.now(), sleep = sleepWithSignal } = {}) {
  const spacingMs = Math.ceil(1000 / Math.max(0.1, Number(qps) || 3));
  let nextSlotAt = 0;
  const takeSlot = () => {
    const current = now();
    const slot = Math.max(current, nextSlotAt);
    nextSlotAt = slot + spacingMs;
    return slot - current;
  };
  const pacedOnce = async (url, init) => {
    const wait = takeSlot();
    if (wait > 0) await sleep(wait, init?.signal);
    return (fetchImpl ?? globalThis.fetch)(url, init);
  };
  return async function pacedAmapFetch(url, init) {
    const response = await pacedOnce(url, init);
    if (!response?.ok || typeof response.clone !== 'function') return response;
    let infocode = '';
    try {
      const data = await response.clone().json();
      if (String(data?.status ?? '1') === '0') infocode = String(data?.infocode ?? '');
    } catch {
      return response;
    }
    if (!QPS_INFOCODES.has(infocode)) return response;
    await sleep(retryDelayMs, init?.signal);
    return pacedOnce(url, init);
  };
}

export function isAmapQpsInfocode(infocode) {
  return QPS_INFOCODES.has(String(infocode ?? ''));
}

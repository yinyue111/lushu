// §2.4: the one network-failure sentence. public/sw.js inlines NETWORK_ERROR_TEXT in its offline
// fallback page (it cannot import app modules); test/unit/network-copy.test.mjs keeps them in sync.
export const NETWORK_ERROR_TEXT = '网络不太稳，没连上。检查网络后再试。';
/** Same sentence for places where the user had typed or picked something that is still on screen. */
export const NETWORK_ERROR_KEPT_TEXT = '网络不太稳，没连上。你填的都还在，检查网络后再试。';

/** True when fetch itself failed (no HTTP response at all), as opposed to a server error or an abort. */
export function isNetworkFailure(error) {
  return Boolean(error) && error.name !== 'AbortError' && (error.code === 'NETWORK_OFFLINE' || error instanceof TypeError);
}

/** Wraps a raw fetch rejection into an Error the UI can recognise; aborts pass through untouched. */
export function networkError(cause) {
  if (cause?.name === 'AbortError') return cause;
  const error = /** @type {Error & Record<string, any>} */ (new Error(NETWORK_ERROR_KEPT_TEXT));
  error.code = 'NETWORK_OFFLINE';
  error.cause = cause;
  return error;
}

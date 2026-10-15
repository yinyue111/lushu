export const ROUTING_ERROR_CODES = Object.freeze({
  PROVIDER_NOT_CONFIGURED: 'ROUTING_PROVIDER_NOT_CONFIGURED',
  FETCH_UNAVAILABLE: 'ROUTING_FETCH_UNAVAILABLE',
  STOP_ID_MISSING: 'ROUTING_STOP_ID_MISSING',
  COORDINATES_MISSING: 'ROUTING_COORDINATES_MISSING',
  COORDINATES_UNVERIFIED: 'ROUTING_COORDINATES_UNVERIFIED',
  MODE_UNSUPPORTED: 'ROUTING_MODE_UNSUPPORTED',
  CITY_REQUIRED: 'ROUTING_CITY_REQUIRED',
  CANCELLED: 'ROUTING_CANCELLED',
  TIMEOUT: 'ROUTING_TIMEOUT',
  NETWORK_ERROR: 'ROUTING_NETWORK_ERROR',
  UPSTREAM_HTTP_ERROR: 'ROUTING_UPSTREAM_HTTP_ERROR',
  UPSTREAM_REJECTED: 'ROUTING_UPSTREAM_REJECTED',
  ROUTE_NOT_FOUND: 'ROUTING_ROUTE_NOT_FOUND',
  UPSTREAM_PAYLOAD_INVALID: 'ROUTING_UPSTREAM_PAYLOAD_INVALID',
  PROVIDER_ERROR: 'ROUTING_PROVIDER_ERROR',
  PROVENANCE_INVALID: 'ROUTING_PROVENANCE_INVALID'
});

export class RoutingError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, any>} [options] */
  constructor(code, message, { category = 'provider', retryable = false, httpStatus = null, upstreamCode = '', cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RoutingError';
    this.code = code || ROUTING_ERROR_CODES.PROVIDER_ERROR;
    this.category = category;
    this.retryable = retryable === true;
    this.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
    this.upstreamCode = String(upstreamCode || '').slice(0, 40);
  }
}

export function isRoutingCancellation(error) {
  return error?.code === ROUTING_ERROR_CODES.CANCELLED || error?.name === 'AbortError';
}

export function routingIssueFromError(error) {
  if (error instanceof RoutingError) {
    return compactIssue({
      code: error.code,
      category: error.category,
      retryable: error.retryable,
      message: error.message,
      httpStatus: error.httpStatus,
      upstreamCode: error.upstreamCode
    });
  }
  if (error?.name === 'AbortError') {
    return compactIssue({
      code: ROUTING_ERROR_CODES.CANCELLED,
      category: 'cancelled',
      retryable: false,
      message: '路径规划已取消'
    });
  }
  return compactIssue({
    code: ROUTING_ERROR_CODES.PROVIDER_ERROR,
    category: 'provider',
    retryable: true,
    message: '路径规划服务暂不可用'
  });
}

function compactIssue(issue) {
  const normalized = /** @type {Record<string, any>} */ ({
    code: String(issue.code || ROUTING_ERROR_CODES.PROVIDER_ERROR).slice(0, 80),
    category: String(issue.category || 'provider').slice(0, 40),
    retryable: issue.retryable === true,
    message: String(issue.message || '路线还没核对').slice(0, 180)
  });
  if (Number.isInteger(issue.httpStatus)) normalized.httpStatus = issue.httpStatus;
  if (issue.upstreamCode) normalized.upstreamCode = String(issue.upstreamCode).slice(0, 40);
  return normalized;
}

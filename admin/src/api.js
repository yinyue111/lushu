// Admin console API client. The session lives in an HttpOnly __Host- cookie; the CSRF token is held in
// memory only (a reload means signing in again). Nothing is written to localStorage / sessionStorage.
let csrfToken = '';
let onSessionLost = () => {};

export function setCsrfToken(token) {
  csrfToken = String(token ?? '');
}

export function setSessionLostHandler(handler) {
  onSessionLost = handler;
}

export class AdminApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function call(method, path, body) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-admin-csrf'] = csrfToken;
  }
  const response = await fetch(`/api/admin${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/login') && !path.startsWith('/enroll')) onSessionLost();
    throw new AdminApiError(data.error || `HTTP ${response.status}`, response.status, data.code || '', data);
  }
  return data;
}

export const adminGet = (path) => call('GET', path);
export const adminPost = (path, body = {}) => call('POST', path, body);

export function query(params) {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  const text = search.toString();
  return text ? `?${text}` : '';
}

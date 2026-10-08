// External/source URL normalisation for user-supplied links.
import { createHttpError, truncateString } from './util.mjs';

export function normalizeExternalUrl(value, { allowHttp = false } = {}) {
  const raw = truncateString(value, 500);
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw createHttpError('外链 URL 不合法', 400, 'BAD_EXTERNAL_URL');
  }
  const allowedProtocols = allowHttp ? ['http:', 'https:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol) || url.username || url.password) {
    throw createHttpError('外链只允许安全的 http/https 地址且不能包含认证信息', 400, 'UNSAFE_EXTERNAL_URL');
  }
  return url.toString();
}

export function safeExternalUrl(value) {
  try {
    return normalizeExternalUrl(value, { allowHttp: false });
  } catch {
    return '';
  }
}

export function safeSourceUrl(value) {
  try {
    return normalizeExternalUrl(value, { allowHttp: true });
  } catch {
    return '';
  }
}

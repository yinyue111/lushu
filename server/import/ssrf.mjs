// SSRF-safe outbound fetching: private address checks, DNS pinning, size limits.
import { decodeHtmlBody } from './html-text.mjs';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHttpError } from '../lib/util.mjs';
import { MAX_IMPORT_PAGE_BYTES } from '../config/index.mjs';

export function isPrivateIp(address) {
  const value = String(address ?? '');
  if (!value) return true;
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7));
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    return parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
      parts[0] >= 224 ||
      parts[0] === 0;
  }
	  if (isIP(value) === 6) {
	    const lower = value.toLowerCase();
    const firstHextet = Number.parseInt(lower.split(':')[0] || '0', 16);
	    return lower === '::' ||
	      lower.startsWith('fc') ||
	      lower.startsWith('fd') ||
      (Number.isFinite(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
	      lower.startsWith('ff') ||
	      lower.startsWith('2001:db8:');
	  }
  return true;
}

export async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw createHttpError('链接格式不合法', 400, 'BAD_SOURCE_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw createHttpError('只支持 http/https 链接', 400, 'UNSUPPORTED_URL_PROTOCOL');
  }
  if (!url.hostname || url.username || url.password) {
    throw createHttpError('链接不能包含认证信息', 400, 'UNSAFE_SOURCE_URL');
  }

  await resolvePublicHttpEndpoint(url);
  return url;
}

export function hostnameForLookup(hostname) {
  return String(hostname ?? '').replace(/^\[|\]$/g, '');
}

export async function resolvePublicHttpEndpoint(url) {
  const hostname = hostnameForLookup(url.hostname);
  const literalIpVersion = isIP(hostname);
  const records = literalIpVersion
    ? [{ address: hostname, family: literalIpVersion }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw createHttpError('链接目标不可访问或不是公网地址', 400, 'UNSAFE_SOURCE_URL');
  }
  return records[0];
}

export async function assertPublicHttpResponseUrl(responseUrl) {
  try {
    return await assertPublicHttpUrl(responseUrl);
  } catch {
    throw createHttpError('链接重定向到非公网地址，已停止抓取', 400, 'UNSAFE_SOURCE_REDIRECT');
  }
}

export function getResponseHeader(headers, name) {
  const value = headers?.[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function requestPinnedPublicUrl(url, endpoint, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port || (isHttps ? 443 : 80));
    const headers = {
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
      'user-agent': 'TrustedRoutebookBot/0.1 (+local MVP; public metadata import)',
      host: url.host
    };
    const options = {
      protocol: url.protocol,
      hostname: endpoint.address,
      family: endpoint.family,
      port,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      signal
    };
    if (isHttps) {
      options.servername = hostnameForLookup(url.hostname);
      options.checkServerIdentity = (_hostname, cert) => checkServerIdentity(hostnameForLookup(url.hostname), cert);
    }

    const chunks = [];
    let total = 0;
    let responseMeta = null;
    let settled = false;

    const finish = () => {
      if (settled || !responseMeta) return;
      settled = true;
      resolvePromise({
        status: responseMeta.statusCode ?? 0,
        ok: (responseMeta.statusCode ?? 0) >= 200 && (responseMeta.statusCode ?? 0) < 300,
        headers: responseMeta.headers ?? {},
        url: url.toString(),
        // L7: honour the page charset (GBK/GB2312/Big5 pages were decoded as UTF-8).
        html: decodeHtmlBody(Buffer.concat(chunks), String(responseMeta.headers?.['content-type'] ?? '')),
        fetchedBytes: total
      });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    const request = requester(options, (response) => {
      responseMeta = response;
      response.on('data', (chunk) => {
        if (settled) return;
        const remaining = MAX_IMPORT_PAGE_BYTES - total;
        if (remaining <= 0) {
          response.destroy();
          finish();
          return;
        }
        if (chunk.byteLength > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
          response.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      });
      response.on('end', finish);
      response.on('close', () => {
        if (total >= MAX_IMPORT_PAGE_BYTES) finish();
      });
      response.on('error', fail);
    });

    request.on('error', fail);
    request.end();
  });
}

export async function fetchPublicPageResponse(url, signal, redirectCount = 0) {
  if (redirectCount > 5) {
    throw createHttpError('链接重定向次数过多', 400, 'SOURCE_TOO_MANY_REDIRECTS');
  }
  const safeUrl = await assertPublicHttpUrl(url);
  const endpoint = await resolvePublicHttpEndpoint(safeUrl);
  const response = await requestPinnedPublicUrl(safeUrl, endpoint, signal);
  if (response.status >= 300 && response.status < 400) {
    const location = getResponseHeader(response.headers, 'location');
    if (!location) throw createHttpError(`公开页面返回 HTTP ${response.status}`, 502, 'SOURCE_FETCH_FAILED');
    const nextUrl = await assertPublicHttpResponseUrl(new URL(location, safeUrl).toString());
    return fetchPublicPageResponse(nextUrl, signal, redirectCount + 1);
  }
  return response;
}

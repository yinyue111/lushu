// SSRF-safe outbound fetching: private address checks, DNS pinning, size limits.
import { decodeHtmlBody } from './html-text.mjs';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHttpError } from '../lib/util.mjs';
import { MAX_IMPORT_PAGE_BYTES } from '../config/index.mjs';

function isPrivateIpv4(value) {
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

/**
 * Expands an IPv6 address (optionally with a trailing dotted IPv4) into 8 hextets.
 * @param {string} value
 * @returns {number[] | null}
 */
function expandIpv6(value) {
  let text = value.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const parse = (part) => (part ? part.split(':').map((hextet) => Number.parseInt(hextet, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const hextets = [...left, ...new Array(missing).fill(0), ...right];
  return hextets.every((hextet) => Number.isInteger(hextet) && hextet >= 0 && hextet <= 0xffff) ? hextets : null;
}

const embeddedIpv4 = (high, low) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

// M7: unit tests showed IPv4-compatible (::7f00:1), NAT64 (64:ff9b::/96) and 6to4
// (2002::/16) forms of private IPv4 addresses were treated as public; IPv6 is now
// expanded and any embedded IPv4 address is checked with the IPv4 rules.
export function isPrivateIp(address) {
  const value = String(address ?? '');
  if (!value) return true;
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return isPrivateIpv4(value.slice(7));
  if (isIP(value) === 4) return isPrivateIpv4(value);
  if (isIP(value) === 6) {
    const h = expandIpv6(value);
    if (!h) return true;
    const zeroPrefix = (count) => h.slice(0, count).every((hextet) => hextet === 0);
    if (zeroPrefix(8)) return true; // ::
    if (zeroPrefix(7) && h[7] === 1) return true; // ::1
    if (zeroPrefix(5) && h[5] === 0xffff) return isPrivateIpv4(embeddedIpv4(h[6], h[7])); // ::ffff:a.b.c.d
    if (zeroPrefix(6)) return isPrivateIpv4(embeddedIpv4(h[6], h[7])); // ::a.b.c.d (deprecated)
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((hextet) => hextet === 0)) return isPrivateIpv4(embeddedIpv4(h[6], h[7]));
    if (h[0] === 0x2002) return isPrivateIpv4(embeddedIpv4(h[1], h[2]));
    return (h[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (h[0] & 0xffc0) === 0xfe80 || // fe80::/10 link local
      (h[0] & 0xffc0) === 0xfec0 || // fec0::/10 site local (deprecated)
      (h[0] & 0xff00) === 0xff00 || // ff00::/8 multicast
      (h[0] === 0x2001 && h[1] === 0x0db8); // documentation
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

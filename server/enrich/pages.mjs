// Fetching the pages a web search cited, to check the value literally appears there.
// Reuses the importer's SSRF-safe fetcher (public IPs only, DNS pinning, redirects re-checked, size cap);
// adds a domain blocklist (sites whose terms forbid automated access), robots.txt and a time limit.
import { fetchPublicPageResponse } from '../import/ssrf.mjs';
import { htmlToText } from './text.mjs';
import { ENRICH_ALLOW_PRIVATE_FETCH_FOR_TESTS, ENRICH_BLOCKED_DOMAINS, ENRICH_PAGE_MAX_BYTES, ENRICH_PAGE_TIMEOUT_MS } from '../config/index.mjs';

export const ENRICH_USER_AGENT = 'TrustedRoutebookBot';

export function isBlockedDomain(hostname, blocked = ENRICH_BLOCKED_DOMAINS) {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '');
  return blocked.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Registrable domain, approximately (cd.bendibao.com and m.cd.bendibao.com are one source). */
export function siteOf(hostname) {
  const parts = String(hostname ?? '')
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean);
  const second = new Set(['com', 'net', 'org', 'gov', 'edu', 'ac']);
  if (parts.length >= 3 && second.has(parts.at(-2)) && parts.at(-1).length === 2) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

async function rawFetch(url, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  if (ENRICH_ALLOW_PRIVATE_FETCH_FOR_TESTS) {
    const res = await fetch(url, { signal, headers: { 'user-agent': ENRICH_USER_AGENT } });
    const html = (await res.text()).slice(0, ENRICH_PAGE_MAX_BYTES);
    return { status: res.status, ok: res.ok, html };
  }
  const res = await fetchPublicPageResponse(url, signal);
  return { status: res.status, ok: res.ok, html: String(res.html ?? '').slice(0, ENRICH_PAGE_MAX_BYTES) };
}

/** Minimal robots.txt check for our user agent (falls back to the * group). */
export function robotsAllows(robotsText, path, agent = ENRICH_USER_AGENT) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(robotsText ?? '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === 'disallow' || key === 'allow')) current.rules.push({ allow: key === 'allow', prefix: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best = null;
  for (const rule of rules) {
    if (!rule.prefix) continue;
    const pattern = rule.prefix.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${pattern.endsWith('\\$') ? pattern : pattern}`);
    if (re.test(path) && (!best || rule.prefix.length > best.prefix.length || (rule.prefix.length === best.prefix.length && rule.allow))) best = rule;
  }
  return !best || best.allow;
}

const robotsCache = new Map();
async function robotsFor(origin) {
  const hit = robotsCache.get(origin);
  if (hit && hit.expires > Date.now()) return hit.text;
  let text = '';
  try {
    const res = await rawFetch(`${origin}/robots.txt`, Math.min(5000, ENRICH_PAGE_TIMEOUT_MS));
    text = res.ok ? res.html : '';
  } catch {
    text = '';
  }
  robotsCache.set(origin, { text, expires: Date.now() + 6 * 3600 * 1000 });
  if (robotsCache.size > 500) robotsCache.delete(robotsCache.keys().next().value);
  return text;
}

/**
 * Fetches a cited page as plain text, or explains why not.
 * @returns {Promise<{ ok: true, text: string, title: string } | { ok: false, reason: string }>}
 */
export async function fetchCitedPage(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'bad-url' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'protocol' };
  if (isBlockedDomain(url.hostname)) return { ok: false, reason: 'blocked-domain' };
  try {
    if (!robotsAllows(await robotsFor(url.origin), `${url.pathname}${url.search}`)) return { ok: false, reason: 'robots' };
    const res = await rawFetch(url.toString(), ENRICH_PAGE_TIMEOUT_MS);
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const title = (res.html.match(/<title[^>]*>([^<]{0,200})/i)?.[1] ?? '').trim();
    return { ok: true, text: htmlToText(res.html), title };
  } catch (error) {
    return { ok: false, reason: error?.code === 'UNSAFE_SOURCE_URL' || error?.code === 'UNSAFE_SOURCE_REDIRECT' ? 'unsafe-address' : 'fetch-failed' };
  }
}

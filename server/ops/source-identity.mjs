import { createHash } from 'node:crypto';
import { safeSourceUrl } from '../lib/urls.mjs';
import { truncateString } from '../lib/util.mjs';

// Identity is derived from signed content, never from a client-selected sourceId.
export function importSourceId(source = {}) {
  const identity = [
    safeSourceUrl(source.url),
    safeSourceUrl(source.finalUrl),
    truncateString(source.platform, 40),
    truncateString(source.title, 120),
    truncateString(source.fetchedAt, 60)
  ];
  return `source-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
}

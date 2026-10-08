// L7: decoding of fetched HTML — byte charset detection and HTML entity decoding.

const META_SNIFF_BYTES = 4096;

/**
 * Returns a TextDecoder label for the response, or 'utf-8'.
 * Order: BOM, Content-Type charset, <meta charset> / http-equiv in the first 4 KiB.
 * @param {Buffer} body
 * @param {string} [contentType]
 */
export function detectCharset(body, contentType = '') {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType ?? ''))?.[1];
  if (fromHeader && supportedLabel(fromHeader)) return supportedLabel(fromHeader);
  const head = body.subarray(0, META_SNIFF_BYTES).toString('latin1');
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  if (fromMeta && supportedLabel(fromMeta)) return supportedLabel(fromMeta);
  return 'utf-8';
}

function supportedLabel(label) {
  const normalized = String(label).trim().toLowerCase();
  // gb2312 pages routinely contain GBK-only characters; decode them as GBK (superset).
  const candidate = normalized === 'gb2312' || normalized === 'x-gbk' ? 'gbk' : normalized;
  try {
    return new TextDecoder(candidate).encoding;
  } catch {
    return null;
  }
}

/**
 * @param {Buffer} body
 * @param {string} [contentType]
 */
export function decodeHtmlBody(body, contentType = '') {
  const charset = detectCharset(body, contentType);
  // Truncated pages may end mid-character; the decoder replaces that with U+FFFD.
  return new TextDecoder(charset).decode(body);
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  yen: '¥',
  times: '×',
  deg: '°'
};

function fromCodePointSafe(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return '\ufffd';
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return '\ufffd';
  return String.fromCodePoint(codePoint);
}

/**
 * Single-pass entity decoding: decimal and hex numeric references (including
 * astral code points such as emoji) and common named entities. A single pass
 * means "&amp;lt;" decodes to "&lt;" rather than "<".
 * @param {unknown} text
 */
export function decodeHtmlEntities(text) {
  return String(text ?? '').replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,15});/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      return fromCodePointSafe(Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    const named = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

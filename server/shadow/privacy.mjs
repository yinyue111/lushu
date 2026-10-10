// Guard for anything sent to Jev: only public, non-personal data may leave the server.
// Builders choose fields explicitly; this is a second line of defence.
const FORBIDDEN_KEYS =
  /^(profileid|profile|creator|userid|user|gps|lat|lng|latitude|longitude|useragent|ip|email|phone|token|edittoken|photo|photoid|comment|pitfall|checkin|checkins|deviceid)$/i;
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
// Value-level detection (any formatting): +86 / 0086 prefixes, spaces, dashes, dots and masks like 138****5678.
const PHONE_LIKE = /(?<![\d*])(?:(?:\+|00)\s*86[\s.-]*)?1[3-9]\d(?:[\s.-]*[\d*]){8}(?![\d*])/;
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const ID_CARD_LIKE = /(?<!\d)\d{17}[\dXx](?!\d)/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ID_CARD = /(?<!\d)\d{17}[\dXx](?!\d)/g;

/** Redacts contact details and ID numbers in public text before it is sent. */
export function redactPublicText(value, maxLength = 700) {
  return String(value ?? '')
    .replace(ID_CARD, '[证件号]')
    .replace(PHONE, '[手机号]')
    .replace(EMAIL, '[邮箱]')
    .slice(0, maxLength);
}

/** Whether a string value looks like a phone number, email or ID number (in any common formatting). */
export function containsPersonalValue(text) {
  const value = String(text ?? '');
  return PHONE_LIKE.test(value) || EMAIL_LIKE.test(value) || ID_CARD_LIKE.test(value);
}

/**
 * Throws when a payload carries a field name that identifies or locates a user, or a string value that
 * looks like a phone number / email / ID number. The message names the path only, never the value.
 */
export function assertNoPersonalData(value, path = 'state') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPersonalData(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'string') {
    if (containsPersonalValue(value)) throw new Error(`personal-data value blocked: ${path}`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`personal-data field blocked: ${path}.${key}`);
    assertNoPersonalData(child, `${path}.${key}`);
  }
}

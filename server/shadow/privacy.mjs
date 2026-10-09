// Guard for anything sent to Jev: only public, non-personal data may leave the server.
// Builders choose fields explicitly; this is a second line of defence.
const FORBIDDEN_KEYS =
  /^(profileid|profile|creator|userid|user|gps|lat|lng|latitude|longitude|useragent|ip|email|phone|token|edittoken|photo|photoid|comment|pitfall|checkin|checkins|deviceid)$/i;
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
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

/** Throws when a payload carries a field name that identifies or locates a user. */
export function assertNoPersonalData(value, path = 'state') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPersonalData(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`personal-data field blocked: ${path}.${key}`);
    assertNoPersonalData(child, `${path}.${key}`);
  }
}

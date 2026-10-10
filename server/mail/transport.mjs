// Mail delivery behind one function. MAIL_TRANSPORT: file (dev/tests: JSON files on disk, nothing is
// sent) | log (only "sent to ab***@x.com" in the log) | resend (HTTP API) | disabled.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MAIL_API_KEY, MAIL_API_URL, MAIL_FROM, MAIL_OUTBOX_DIR, MAIL_TRANSPORT } from '../config/index.mjs';
import { createHttpError } from '../lib/util.mjs';
import { maskEmail } from '../accounts/email.mjs';

let override = null;
/** Test hook: replace the transport with a function (mail) => Promise<void>. */
export function setMailTransportForTests(fn) {
  override = fn;
}

export const mailDelivers = () => Boolean(override) || MAIL_TRANSPORT === 'file' || MAIL_TRANSPORT === 'resend';

/**
 * @param {{ to: string, subject: string, text: string, kind: string }} mail
 */
export async function sendMail(mail) {
  if (override) return override(mail);
  if (MAIL_TRANSPORT === 'disabled') throw createHttpError('邮件服务还没开通，暂时发不了验证码', 503, 'MAIL_UNAVAILABLE');
  if (MAIL_TRANSPORT === 'log') {
    console.info(`[mail] ${mail.kind} → ${maskEmail(mail.to)} (MAIL_TRANSPORT=log, not delivered)`);
    return;
  }
  if (MAIL_TRANSPORT === 'file') {
    await mkdir(MAIL_OUTBOX_DIR, { recursive: true, mode: 0o700 });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.json`;
    await writeFile(join(MAIL_OUTBOX_DIR, name), JSON.stringify({ from: MAIL_FROM, ...mail, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return;
  }
  // resend
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(MAIL_API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${MAIL_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`mail provider answered ${response.status}`);
  } catch (error) {
    console.warn(`[mail] ${mail.kind} → ${maskEmail(mail.to)} failed: ${error?.message ?? error}`);
    throw createHttpError('邮件没发出去，稍后再试', 502, 'MAIL_SEND_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

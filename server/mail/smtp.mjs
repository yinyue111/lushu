// SMTP delivery via nodemailer (pinned). TLS certificates are verified by default; plain SMTP is only
// meant for a relay on the same host. Credentials and addresses never reach the logs.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

/**
 * @typedef {{ host: string, port: number, secure: 'tls' | 'starttls' | 'none', user?: string, pass?: string,
 *   tlsVerify?: boolean, caFile?: string, timeoutMs?: number, from: string }} SmtpConfig
 */

/** nodemailer transport options for our config (exported for tests). @param {SmtpConfig} cfg */
export function smtpTransportOptions(cfg) {
  const timeout = cfg.timeoutMs ?? 15000;
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === 'tls',
    requireTLS: cfg.secure === 'starttls',
    ignoreTLS: cfg.secure === 'none',
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass ?? '' } } : {}),
    tls: {
      rejectUnauthorized: cfg.tlsVerify !== false,
      ...(isIP(cfg.host) ? {} : { servername: cfg.host }),
      minVersion: /** @type {'TLSv1.2'} */ ('TLSv1.2'),
      ...(cfg.caFile ? { ca: readFileSync(cfg.caFile, 'utf8') } : {})
    },
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout * 2,
    dnsTimeout: timeout,
    pool: false,
    logger: false,
    debug: false
  };
}

let cached = null;
/** @param {SmtpConfig} cfg */
async function transporterFor(cfg) {
  const key = JSON.stringify({ ...cfg, pass: cfg.pass ? 'set' : '' }) + (cfg.pass ?? '').length;
  if (cached?.key === key) return cached.transporter;
  const { default: nodemailer } = await import('nodemailer');
  const transporter = nodemailer.createTransport(smtpTransportOptions(cfg));
  cached = { key, transporter };
  return transporter;
}

/**
 * Sends one plain-text mail. Throws on any failure (the caller maps it to a user-facing error).
 * @param {SmtpConfig} cfg @param {{ to: string, subject: string, text: string }} mail
 */
export async function sendSmtpMail(cfg, mail) {
  const transporter = await transporterFor(cfg);
  const info = await transporter.sendMail({ from: cfg.from, to: mail.to, subject: mail.subject, text: mail.text });
  if (Array.isArray(info?.rejected) && info.rejected.length) throw new Error('recipient rejected');
  return { messageId: info?.messageId ?? '' };
}

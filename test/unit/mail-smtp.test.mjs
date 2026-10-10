import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sendSmtpMail, smtpTransportOptions } from '../../server/mail/smtp.mjs';
import { evaluateStartupSafety } from '../../server/config/startup-checks.mjs';
import { startFakeSmtp } from '../support/fake-smtp.mjs';

const dir = mkdtempSync(join(tmpdir(), 'lushu-smtp-'));
let certPath = '';
let keyPem = '';
let certPem = '';
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem')
    ],
    { stdio: 'ignore' }
  );
  certPath = join(dir, 'cert.pem');
  keyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
  certPem = readFileSync(certPath, 'utf8');
} catch {
  // openssl missing: the TLS cases below are skipped.
}
const mail = { to: 'traveler@example.com', subject: '路书验证码', text: '验证码 123456\n15 分钟内有效。' };
const base = { host: '127.0.0.1', from: '路书 <no-reply@lushu.test>', timeoutMs: 2000 };

test('transport options: verification on by default, modes map to nodemailer flags', () => {
  const starttls = smtpTransportOptions({ ...base, port: 587, secure: 'starttls' });
  assert.equal(starttls.tls.rejectUnauthorized, true);
  assert.equal(starttls.requireTLS, true);
  assert.equal(starttls.secure, false);
  assert.equal(starttls.connectionTimeout, 2000);
  assert.equal(smtpTransportOptions({ ...base, port: 465, secure: 'tls' }).secure, true);
  assert.equal(smtpTransportOptions({ ...base, port: 25, secure: 'none' }).ignoreTLS, true);
  assert.equal(smtpTransportOptions({ ...base, port: 25, secure: 'none' }).auth, undefined);
});

test('plain SMTP to a local relay delivers the mail with auth', async () => {
  const server = await startFakeSmtp();
  try {
    await sendSmtpMail({ ...base, host: '127.0.0.1', port: server.port, secure: 'none', user: 'lushu', pass: 's3cret' }, mail);
    assert.equal(server.messages.length, 1);
    const [message] = server.messages;
    assert.deepEqual(message.to, ['traveler@example.com']);
    assert.equal(message.from, 'no-reply@lushu.test');
    assert.equal(message.auth, 'lushu:s3cret');
    assert.match(message.data, /Subject: =\?UTF-8\?/);
    assert.equal(message.tls, false);
  } finally {
    await server.close();
  }
});

test('STARTTLS: an untrusted certificate is refused; trusting it via the CA file delivers over TLS', { skip: !certPath }, async () => {
  const server = await startFakeSmtp({ key: keyPem, cert: certPem });
  try {
    await assert.rejects(sendSmtpMail({ ...base, port: server.port, secure: 'starttls', user: 'u', pass: 'p' }, mail), /certificate|self[- ]signed/i);
    assert.equal(server.messages.length, 0, 'nothing (not even the password) is sent before the certificate checks out');
    await sendSmtpMail({ ...base, port: server.port + 0, secure: 'starttls', user: 'u', pass: 'p', caFile: certPath }, mail);
    assert.equal(server.messages.length, 1);
    assert.equal(server.messages[0].tls, true);
    assert.equal(server.messages[0].auth, 'u:p');
  } finally {
    await server.close();
  }
});

test('STARTTLS required: a server that does not offer it is refused', async () => {
  const server = await startFakeSmtp();
  try {
    await assert.rejects(sendSmtpMail({ ...base, host: '127.0.0.1', port: server.port, secure: 'starttls', user: 'u', pass: 'p' }, mail));
    assert.equal(server.messages.length, 0);
  } finally {
    await server.close();
  }
});

test('implicit TLS (465 style) delivers when the certificate is trusted', { skip: !certPath }, async () => {
  const server = await startFakeSmtp({ key: keyPem, cert: certPem, implicitTls: true });
  try {
    await sendSmtpMail({ ...base, port: server.port, secure: 'tls', caFile: certPath }, mail);
    assert.equal(server.messages.length, 1);
    assert.equal(server.messages[0].tls, true);
  } finally {
    await server.close();
  }
});

test('a server that never answers fails within the timeout', async () => {
  const server = await startFakeSmtp({ silent: true });
  try {
    const started = Date.now();
    await assert.rejects(sendSmtpMail({ ...base, host: '127.0.0.1', port: server.port, secure: 'none', timeoutMs: 1000 }, mail));
    assert.ok(Date.now() - started < 8000);
  } finally {
    await server.close();
  }
});

test('startup checks for smtp', () => {
  const prod = (smtp, extra = {}) =>
    evaluateStartupSafety(
      /** @type {any} */ ({
        isProduction: true,
        authEnabled: true,
        authEmailHashSecret: 'h'.repeat(40),
        authEmailEncKey: 'k'.repeat(40),
        mailTransport: 'smtp',
        mailFrom: '路书 <no-reply@lushu.app>',
        smtp: { host: 'mail.example.jp', port: 587, secure: 'starttls', user: 'u', tlsVerify: true, caFile: '', ...smtp },
        ...extra
      })
    ).errors.filter((line) => /SMTP|smtp/.test(line));
  assert.deepEqual(prod({}), []);
  assert.ok(prod({ host: '' }).length);
  assert.ok(prod({ secure: 'invalid' }).length);
  assert.ok(prod({ secure: 'none' }).some((line) => /localhost/.test(line)));
  assert.deepEqual(prod({ secure: 'none', host: '127.0.0.1' }), []);
  assert.ok(prod({ tlsVerify: false }).some((line) => /TLS_VERIFY/.test(line)));
  writeFileSync(join(dir, 'ca.pem'), 'x');
  assert.deepEqual(prod({ caFile: join(dir, 'ca.pem') }), []);
  assert.ok(prod({ caFile: join(dir, 'missing.pem') }).length);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from '../helpers/server.mjs';
import { INVITE, authEnv, createClient } from '../helpers/accounts.mjs';
import { startFakeSmtp } from '../support/fake-smtp.mjs';

test('MAIL_TRANSPORT=smtp: the sign-up code goes out through the SMTP server and works', async (t) => {
  const smtp = await startFakeSmtp();
  t.after(smtp.close);
  const server = await startServer({
    env: authEnv('login', {
      EMAIL_VERIFICATION_REQUIRED: 'true',
      MAIL_TRANSPORT: 'smtp',
      MAIL_FROM: '路书 <no-reply@lushu.test>',
      MAIL_SMTP_HOST: '127.0.0.1',
      MAIL_SMTP_PORT: String(smtp.port),
      MAIL_SMTP_SECURE: 'none',
      MAIL_SMTP_USER: 'lushu',
      MAIL_SMTP_PASS: 'relay-pass',
      MAIL_SMTP_TIMEOUT_MS: '3000'
    })
  });
  t.after(server.stop);
  const client = createClient(server.baseUrl);
  const config = await client.request('/api/auth/config');
  assert.equal(config.data.emailDelivery, true);
  const email = 'smtp-user@example.com';
  const sent = await client.request('/api/auth/register/code', { method: 'POST', body: { email, humanCheck: await client.humanCheck('mail') } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(smtp.messages.length, 1);
  const [message] = smtp.messages;
  assert.deepEqual(message.to, [email]);
  assert.equal(message.auth, 'lushu:relay-pass');
  const code = /\b(\d{6})\b/.exec(
    Buffer.from(message.data.split('\n\n').slice(1).join('\n').replace(/\s/g, ''), 'base64').toString('utf8') + message.data
  )?.[1];
  assert.ok(code, 'code in the mail body');
  const registered = await client.request('/api/auth/register', {
    method: 'POST',
    body: { email, password: '西湖边走一走2026', inviteCode: INVITE, acceptPrivacy: true, emailCode: code, humanCheck: await client.humanCheck('register') }
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal(registered.data.account.emailVerified, true);
  // The relay password and the address stay out of the server log.
  assert.ok(!server.output.join('').includes('relay-pass'));
});

test('MAIL_TRANSPORT=smtp: an unreachable server gives a clear 502, nothing leaks', async (t) => {
  const smtp = await startFakeSmtp({ silent: true });
  t.after(smtp.close);
  const server = await startServer({
    env: authEnv('login', {
      MAIL_TRANSPORT: 'smtp',
      MAIL_FROM: 'no-reply@lushu.test',
      MAIL_SMTP_HOST: '127.0.0.1',
      MAIL_SMTP_PORT: String(smtp.port),
      MAIL_SMTP_SECURE: 'none',
      MAIL_SMTP_TIMEOUT_MS: '1000'
    })
  });
  t.after(server.stop);
  const client = createClient(server.baseUrl);
  const sent = await client.request('/api/auth/register/code', {
    method: 'POST',
    body: { email: 'nobody-home@example.com', humanCheck: await client.humanCheck('mail') }
  });
  assert.equal(sent.status, 502);
  assert.equal(sent.data.code, 'MAIL_SEND_FAILED');
  assert.ok(!server.output.join('').includes('nobody-home@example.com'));
});

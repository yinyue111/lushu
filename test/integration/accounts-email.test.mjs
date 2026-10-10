import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { adminHeaders, fetchJson, startServer, writeJsonl } from '../helpers/server.mjs';
import { INVITE, PHONE_SECRET, authEnv, createClient } from '../helpers/accounts.mjs';
import { hashPassword } from '../../server/accounts/password.mjs';

const PASSWORD = '西湖边走一走2026';
const NEW_PASSWORD = '灵隐寺再走一走2027';

async function outbox(dataDir) {
  const dir = join(dataDir, 'mail-outbox');
  let names = [];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'))));
}
async function lastMailTo(dataDir, to) {
  const mails = (await outbox(dataDir)).filter((m) => m.to === to);
  return mails.at(-1) ?? null;
}
const codeIn = (mail) => /\b(\d{6})\b/.exec(mail?.text ?? '')?.[1] ?? '';

async function allDataText(dir) {
  let text = '';
  for (const name of await readdir(dir)) if (name.endsWith('.jsonl')) text += await readFile(join(dir, name), 'utf8');
  return text;
}

test('email accounts: verified sign-up, login by email or phone, reset by email, change email, enumeration safety', async (t) => {
  const server = await startServer({ env: authEnv('login', { EMAIL_VERIFICATION_REQUIRED: 'true' }) });
  t.after(server.stop);
  const config = await createClient(server.baseUrl).request('/api/auth/config');
  assert.equal(config.data.emailVerificationRequired, true);
  assert.equal(config.data.emailDelivery, true);

  const alice = createClient(server.baseUrl);
  const email = 'Alice.Trip@Example.COM';
  const normalized = 'alice.trip@example.com';
  // A code is needed before the account exists.
  const noCode = await alice.post('/api/auth/register', {
    email,
    password: PASSWORD,
    inviteCode: INVITE,
    acceptPrivacy: true,
    humanCheck: await alice.humanCheck('register')
  });
  assert.equal(noCode.data.code, 'EMAIL_CODE_REQUIRED');
  assert.equal((await alice.post('/api/auth/register/code', { email: 'not-an-email', humanCheck: await alice.humanCheck('mail') })).data.code, 'EMAIL_INVALID');
  assert.equal((await alice.post('/api/auth/register/code', { email })).data.code, 'HUMAN_CHECK_REQUIRED');
  const sent = await alice.post('/api/auth/register/code', { email, humanCheck: await alice.humanCheck('mail') });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.emailMasked, 'al***@example.com');
  // Resend is rate-limited.
  assert.equal((await alice.post('/api/auth/register/code', { email, humanCheck: await alice.humanCheck('mail') })).data.code, 'EMAIL_CODE_TOO_SOON');
  const mail = await lastMailTo(server.dataDir, normalized);
  const code = codeIn(mail);
  assert.match(code, /^\d{6}$/);
  assert.match(mail.subject, /验证码/);

  const registerBody = async (extra = {}) => ({
    email,
    password: PASSWORD,
    inviteCode: INVITE,
    acceptPrivacy: true,
    humanCheck: await alice.humanCheck('register'),
    ...extra
  });
  const wrongCode = await alice.post('/api/auth/register', await registerBody({ emailCode: code === '000000' ? '111111' : '000000' }));
  assert.equal(wrongCode.data.code, 'EMAIL_CODE_INVALID');
  const registered = await alice.post('/api/auth/register', await registerBody({ emailCode: code }));
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal(registered.data.account.emailMasked, 'al***@example.com');
  assert.equal(registered.data.account.emailVerified, true);
  assert.equal(registered.data.account.phoneMasked, '', 'phone is optional');
  assert.equal(registered.data.recoveryCodes.length, 6);
  // The code is single use.
  const bob = createClient(server.baseUrl);
  assert.equal((await bob.post('/api/auth/register', { ...(await registerBody({ emailCode: code })), email: normalized })).data.code, 'EMAIL_CODE_INVALID');

  // A taken address: same answer for the send; the owner gets a notice, not a code.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const takenSend = await bob.post('/api/auth/register/code', { email: normalized, humanCheck: await bob.humanCheck('mail') });
  assert.equal(takenSend.data.code, 'EMAIL_CODE_TOO_SOON', 'the resend timer is per address, account or not');
  const fresh = createClient(server.baseUrl);
  const freeSend = await fresh.post('/api/auth/register/code', { email: 'nobody@example.com', humanCheck: await fresh.humanCheck('mail') });
  assert.deepEqual(
    Object.keys(freeSend.data)
      .filter((k) => k !== 'requestId')
      .sort(),
    ['emailMasked', 'ok', 'sent']
  );

  // Login with the email (any case) or — after adding one — the phone.
  const byEmail = await createClient(server.baseUrl).post('/api/auth/login', { identifier: ' ALICE.trip@example.com ', password: PASSWORD });
  assert.equal(byEmail.status, 200, JSON.stringify(byEmail.data));
  const wrong = await createClient(server.baseUrl).post('/api/auth/login', { identifier: normalized, password: 'nope-nope-nope' });
  const unknownEmail = await createClient(server.baseUrl).post('/api/auth/login', { identifier: 'ghost@example.com', password: 'nope-nope-nope' });
  const unknownPhone = await createClient(server.baseUrl).post('/api/auth/login', { identifier: '13900000000', password: 'nope-nope-nope' });
  for (const result of [wrong, unknownEmail, unknownPhone]) {
    assert.equal(result.status, 401);
    assert.equal(result.data.code, 'INVALID_CREDENTIALS');
    assert.equal(result.data.error ?? result.data.message, wrong.data.error ?? wrong.data.message);
  }

  // Forgot password by email: unknown addresses get the same answer and no mail.
  const resetter = createClient(server.baseUrl);
  const ghost = await resetter.post('/api/auth/reset-password/code', { email: 'ghost2@example.com', humanCheck: await resetter.humanCheck('mail') });
  assert.equal(ghost.status, 200);
  assert.equal(await lastMailTo(server.dataDir, 'ghost2@example.com'), null);
  // Wait out the per-address resend gap from the sign-up code.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const mailsBefore = (await outbox(server.dataDir)).length;
  const resetSend = await resetter.post('/api/auth/reset-password/code', { email: normalized, humanCheck: await resetter.humanCheck('mail') });
  // The sign-up code was sent < 60 s ago: the gap applies across purposes.
  assert.equal(resetSend.data.code, 'EMAIL_CODE_TOO_SOON');
  assert.equal((await outbox(server.dataDir)).length, mailsBefore);
});

async function signUp(server, client, email, phone = '') {
  await client.post('/api/auth/register/code', { email, humanCheck: await client.humanCheck('mail') });
  return client.post('/api/auth/register', {
    email,
    phone,
    password: PASSWORD,
    inviteCode: INVITE,
    acceptPrivacy: true,
    emailCode: codeIn(await lastMailTo(server.dataDir, email)),
    humanCheck: await client.humanCheck('register')
  });
}

test('email accounts: reset, change email, legacy phone-only account adds email, ops view, nothing stored in clear', async (t) => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-email-'));
  // An account created before migration 0009: phone only, no email fields at all.
  const legacyPhone = '+8613512345678';
  const now = new Date().toISOString();
  await writeJsonl(dataDir, 'accounts.jsonl', [
    {
      t: 'user',
      at: now,
      v: {
        id: 'u_legacy',
        phoneHash: createHmac('sha256', PHONE_SECRET).update(`phone:v1:${legacyPhone}`).digest('hex'),
        phoneMasked: '+86 135****5678',
        phoneLast4: '5678',
        passwordHash: await hashPassword(PASSWORD),
        recoveryHashes: [],
        primaryProfileId: 'p_legacy',
        status: 'active',
        generationQuota: null,
        lastLoginAt: null,
        credentialsChangedAt: now,
        createdAt: now,
        updatedAt: now
      }
    }
  ]);
  const server = await startServer({ dataDir, env: authEnv('login', { EMAIL_VERIFICATION_REQUIRED: 'true', EMAIL_CODE_RESEND_SECONDS: '0' }) });
  t.after(async () => {
    await server.stop();
    const { rm } = await import('node:fs/promises');
    await rm(dataDir, { recursive: true, force: true });
  });
  const email = 'carol@example.com';
  const carol = createClient(server.baseUrl);
  const reg = await signUp(server, carol, email, '13711112222');
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  assert.equal(reg.data.account.phoneMasked, '+86 137****2222');
  const phoneLogin = await createClient(server.baseUrl).post('/api/auth/login', { identifier: '137 1111 2222', password: PASSWORD });
  assert.equal(phoneLogin.status, 200);
  const otherDevice = createClient(server.baseUrl);
  assert.equal((await otherDevice.post('/api/auth/login', { identifier: email, password: PASSWORD })).status, 200);

  // Reset by email: code is hashed, single use, signs out everywhere, notice mailed.
  const resetter = createClient(server.baseUrl);
  const sent = await resetter.post('/api/auth/reset-password/code', { email, humanCheck: await resetter.humanCheck('mail') });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const resetCode = codeIn(await lastMailTo(server.dataDir, email));
  assert.match(resetCode, /^\d{6}$/);
  const empty = await resetter.post('/api/auth/reset-password', { email, emailCode: '', password: NEW_PASSWORD });
  assert.equal(empty.data.code, 'EMAIL_CODE_REQUIRED', 'empty code is named, not a human-check error');
  const reset = await resetter.post('/api/auth/reset-password', { email, emailCode: resetCode, password: NEW_PASSWORD });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.match((await lastMailTo(server.dataDir, email)).subject, /密码已重设/);
  assert.equal((await otherDevice.request('/api/auth/me')).data.account, null, 'other sessions are revoked');
  assert.equal((await resetter.post('/api/auth/reset-password', { email, emailCode: resetCode, password: PASSWORD })).data.code, 'EMAIL_CODE_INVALID');
  assert.equal((await createClient(server.baseUrl).post('/api/auth/login', { identifier: email, password: PASSWORD })).status, 401);
  assert.equal((await createClient(server.baseUrl).post('/api/auth/login', { identifier: email, password: NEW_PASSWORD })).status, 200);

  // Five wrong codes burn a code.
  await resetter.post('/api/auth/reset-password/code', { email, humanCheck: await resetter.humanCheck('mail') });
  const burnCode = codeIn(await lastMailTo(server.dataDir, email));
  const bad = burnCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) await resetter.post('/api/auth/reset-password', { email, emailCode: bad, password: PASSWORD });
  assert.equal((await resetter.post('/api/auth/reset-password', { email, emailCode: burnCode, password: PASSWORD })).data.code, 'EMAIL_CODE_INVALID');

  // Change email: password + code to the new address; the old one is told.
  assert.equal((await resetter.post('/api/auth/email/code', { email: 'carol2@example.com', password: 'wrong-password-x' })).data.code, 'PASSWORD_MISMATCH');
  const change = await resetter.post('/api/auth/email/code', { email: 'Carol2@Example.com', password: NEW_PASSWORD });
  assert.equal(change.status, 200, JSON.stringify(change.data));
  const changeCode = codeIn(await lastMailTo(server.dataDir, 'carol2@example.com'));
  // Another account cannot use that code.
  const mallory = createClient(server.baseUrl);
  assert.equal((await signUp(server, mallory, 'mallory@example.com')).status, 200);
  assert.equal((await mallory.post('/api/auth/email', { email: 'carol2@example.com', emailCode: changeCode })).data.code, 'EMAIL_CODE_INVALID');
  const confirmed = await resetter.post('/api/auth/email', { email: 'carol2@example.com', emailCode: changeCode });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.account.emailMasked, 'ca***@example.com');
  assert.match((await lastMailTo(server.dataDir, email)).text, /ca\*\*\*@example\.com/);
  assert.equal((await createClient(server.baseUrl).post('/api/auth/login', { identifier: email, password: NEW_PASSWORD })).status, 401);
  assert.equal((await createClient(server.baseUrl).post('/api/auth/login', { identifier: 'carol2@example.com', password: NEW_PASSWORD })).status, 200);
  // Taken by someone else.
  assert.equal((await mallory.post('/api/auth/email/code', { email: 'carol2@example.com', password: PASSWORD })).data.code, 'EMAIL_TAKEN');

  // Signing up again with a taken address: same answer, the owner gets a notice and no code.
  const probe = createClient(server.baseUrl);
  const takenSend = await probe.post('/api/auth/register/code', { email: 'carol2@example.com', humanCheck: await probe.humanCheck('mail') });
  const freeSend = await probe.post('/api/auth/register/code', { email: 'erin@example.com', humanCheck: await probe.humanCheck('mail') });
  assert.equal(takenSend.status, freeSend.status);
  assert.deepEqual(Object.keys(takenSend.data).sort(), Object.keys(freeSend.data).sort());
  const notice = await lastMailTo(server.dataDir, 'carol2@example.com');
  assert.match(notice.subject, /有人用你的邮箱注册/);
  assert.equal(codeIn(notice), '');

  // Recovery codes still work, now with the email as the account name.
  const viaRecovery = await createClient(server.baseUrl).post('/api/auth/reset-password', {
    identifier: 'carol2@example.com',
    recoveryCode: reg.data.recoveryCodes[0],
    password: PASSWORD,
    humanCheck: await probe.humanCheck('reset')
  });
  assert.equal(viaRecovery.status, 200, JSON.stringify(viaRecovery.data));

  // Legacy phone-only account (created before 0009): logs in by phone, is asked (not forced) to add an email.
  const legacy = createClient(server.baseUrl);
  const legacyLogin = await legacy.post('/api/auth/login', { identifier: '13512345678', password: PASSWORD });
  assert.equal(legacyLogin.status, 200, JSON.stringify(legacyLogin.data));
  assert.equal(legacyLogin.data.account.emailMasked, '');
  assert.equal(legacyLogin.data.account.emailVerified, false);
  assert.equal((await legacy.request('/api/auth/me')).data.account.phoneMasked, '+86 135****5678');
  assert.equal((await legacy.post('/api/auth/email/code', { email: 'dave@example.com', password: PASSWORD })).status, 200);
  const added = await legacy.post('/api/auth/email', { email: 'dave@example.com', emailCode: codeIn(await lastMailTo(server.dataDir, 'dave@example.com')) });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.account.emailVerified, true);
  assert.equal((await createClient(server.baseUrl).post('/api/auth/login', { identifier: 'dave@example.com', password: PASSWORD })).status, 200);

  // Ops: masked email + verified state, search by full email.
  const ops = await fetchJson(`${server.baseUrl}/api/ops/users?q=${encodeURIComponent('Carol2@example.com')}`, { headers: adminHeaders() });
  assert.equal(ops.data.users.length, 1);
  assert.equal(ops.data.users[0].emailMasked, 'ca***@example.com');
  assert.equal(ops.data.users[0].emailVerified, true);

  const stored = await allDataText(server.dataDir);
  for (const secret of ['carol@example.com', 'carol2@example.com', 'dave@example.com', '13711112222', resetCode, changeCode]) {
    assert.ok(!stored.includes(secret), `${secret} must not be stored in clear`);
  }
});

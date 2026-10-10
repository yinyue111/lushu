import assert from 'node:assert/strict';

/** Behaviour every account store (JSONL, PostgreSQL) must share. */
export async function runAccountStoreContract(store) {
  const now = new Date().toISOString();
  const base = {
    phoneMasked: '+86 138****5678',
    phoneLast4: '5678',
    passwordHash: 'scrypt$v1$x',
    recoveryHashes: [{ hash: 'a' }],
    status: 'active',
    createdAt: now
  };
  const user = await store.createUser({ ...base, id: 'u_a', phoneHash: 'h1', primaryProfileId: 'p_a' });
  assert.equal(user.id, 'u_a');
  await assert.rejects(store.createUser({ ...base, id: 'u_b', phoneHash: 'h1', primaryProfileId: 'p_b' }), (/** @type {any} */ e) => e.code === 'PHONE_TAKEN');
  await assert.rejects(
    store.createUser({ ...base, id: 'u_c', phoneHash: 'h2', primaryProfileId: 'p_a' }),
    (/** @type {any} */ e) => e.code === 'PROFILE_TAKEN'
  );
  assert.equal((await store.findUserByPhoneHash('h1')).id, 'u_a');
  assert.equal(await store.findUserByPhoneHash('nope'), null);

  const updated = await store.updateUser('u_a', { status: 'disabled', recoveryHashes: [{ hash: 'b', usedAt: now }], generationQuota: 3 });
  assert.equal(updated.status, 'disabled');
  assert.deepEqual(updated.recoveryHashes, [{ hash: 'b', usedAt: now }]);
  assert.equal(updated.generationQuota, 3);
  assert.equal((await store.listUsers({ last4: '5678' })).length, 1);
  assert.equal((await store.listUsers({ last4: '0000' })).length, 0);

  // A deleted account frees the number.
  await store.updateUser('u_a', { status: 'deleted' });
  assert.equal(await store.findUserByPhoneHash('h1'), null);
  await store.createUser({ ...base, id: 'u_d', phoneHash: 'h1', primaryProfileId: 'p_d' });

  const later = new Date(Date.now() + 86400000).toISOString();
  await store.createSession({ sidHash: 's1', userId: 'u_d', createdAt: now, lastSeenAt: now, expiresAt: later, absoluteExpiresAt: later, userAgent: 'x' });
  await store.createSession({ sidHash: 's2', userId: 'u_d', createdAt: now, lastSeenAt: now, expiresAt: later, absoluteExpiresAt: later, userAgent: 'y' });
  assert.equal((await store.getSession('s1')).userId, 'u_d');
  assert.equal(await store.countActiveSessions('u_d'), 2);
  assert.equal(await store.revokeUserSessions('u_d', { except: 's2' }), 1);
  assert.ok((await store.getSession('s1')).revokedAt);
  assert.equal((await store.getSession('s2')).revokedAt, null);
  await store.revokeSession('s2');
  assert.equal(await store.countActiveSessions('u_d'), 0);

  await store.putThrottle({ key: 'phone:x', failures: 2, windowStartedAt: now, lockedUntil: null, lockLevel: 0 });
  assert.equal((await store.getThrottle('phone:x')).failures, 2);
  await store.deleteThrottle('phone:x');
  assert.equal(await store.getThrottle('phone:x'), null);

  assert.equal(await store.linkProfile('p_old', 'u_d'), 'u_d');
  assert.equal(await store.linkProfile('p_old', 'u_other'), 'u_d', 'a linked profile is never re-assigned');
  assert.equal(await store.linkProfile('p_d', 'u_other'), 'u_d', "another account's primary profile cannot be linked");
  assert.equal(await store.findUserIdByProfile('p_old'), 'u_d');
  assert.equal(await store.findUserIdByProfile('p_d'), 'u_d');
  assert.deepEqual(await store.listLinkedProfiles('u_d'), ['p_old']);
  await assert.rejects(
    store.createUser({ ...base, id: 'u_e', phoneHash: 'h9', primaryProfileId: 'p_old' }),
    (/** @type {any} */ e) => e.code === 'PROFILE_TAKEN'
  );

  // ---- email (migration 0009)
  const emailUser = await store.createUser({
    ...base,
    id: 'u_m',
    phoneHash: null,
    phoneMasked: '',
    phoneLast4: '',
    primaryProfileId: 'p_m',
    emailHash: 'e1',
    emailEnc: 'v1.x.y.z',
    emailMasked: 'ab***@qq.com',
    emailVerifiedAt: now
  });
  assert.equal(emailUser.phoneHash, null);
  assert.equal(emailUser.emailMasked, 'ab***@qq.com');
  assert.equal((await store.findUserByEmailHash('e1')).id, 'u_m');
  assert.equal(await store.findUserByEmailHash('nope'), null);
  assert.equal(await store.findUserByPhoneHash(null), null, 'a missing phone never matches');
  // A second phone-less account is fine; a second account on the same email is not.
  await store.createUser({
    ...base,
    id: 'u_n',
    phoneHash: null,
    phoneMasked: '',
    phoneLast4: '',
    primaryProfileId: 'p_n',
    emailHash: 'e2',
    emailEnc: 'v1',
    emailMasked: 'cd***@qq.com'
  });
  await assert.rejects(
    store.createUser({ ...base, id: 'u_o', phoneHash: 'h7', primaryProfileId: 'p_o', emailHash: 'e1', emailEnc: 'v1', emailMasked: 'x' }),
    (/** @type {any} */ e) => e.code === 'EMAIL_TAKEN'
  );
  await assert.rejects(store.updateUser('u_n', { emailHash: 'e1' }), (/** @type {any} */ e) => e.code === 'EMAIL_TAKEN');
  // Legacy phone-only account adds an email.
  const added = await store.updateUser('u_d', { emailHash: 'e3', emailEnc: 'v1.a', emailMasked: 'ef***@163.com', emailVerifiedAt: now });
  assert.equal(added.emailHash, 'e3');
  assert.ok(added.emailVerifiedAt);
  assert.equal((await store.listUsers({ emailHash: 'e3' }))[0].id, 'u_d');
  await store.updateUser('u_m', { status: 'deleted' });
  assert.equal(await store.findUserByEmailHash('e1'), null, 'a deleted account frees the email');

  const expires = new Date(Date.now() + 15 * 60000).toISOString();
  const c1 = await store.createEmailCode({
    id: 'c1',
    purpose: 'register',
    emailHash: 'e9',
    emailEnc: 'v1.q',
    codeHash: 'k1',
    expiresAt: expires,
    createdAt: now
  });
  assert.equal(c1.attempts, 0);
  assert.equal(c1.consumedAt, null);
  assert.equal((await store.latestEmailCode('register', 'e9')).id, 'c1');
  assert.equal(await store.latestEmailCode('reset', 'e9'), null, 'codes are bound to their purpose');
  assert.equal((await store.updateEmailCode('c1', { attempts: 2 })).attempts, 2);
  const later2 = new Date(Date.now() + 1000).toISOString();
  await store.createEmailCode({ id: 'c2', purpose: 'register', emailHash: 'e9', codeHash: 'k2', expiresAt: expires, createdAt: later2 });
  assert.equal((await store.latestEmailCode('register', 'e9')).id, 'c2');
  assert.equal(await store.countEmailCodesSince('e9', now), 2);
  const consumed = await store.updateEmailCode('c2', { consumedAt: later2 });
  assert.ok(consumed.consumedAt);
  assert.equal(consumed.attempts, 0);
}

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
}

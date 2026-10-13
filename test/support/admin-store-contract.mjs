// One behaviour contract for both admin stores (JSONL in unit tests, PostgreSQL in accounts-store-regression).
import assert from 'node:assert/strict';

/**
 * @param {any} store
 * @param {{ label?: string, appendOnly?: () => Promise<void>, seedReport?: (id: string) => Promise<void> }} [options]
 */
export async function runAdminStoreContract(store, { label = 'store', appendOnly, seedReport } = {}) {
  // config versions: optimistic concurrency, newest first
  assert.equal(await store.latestConfig(), null, `${label}: empty config`);
  const v1 = await store.insertConfigVersion(
    {
      overrides: { 'generation.homeCities': ['苏州'] },
      secrets: {},
      changes: [{ key: 'generation.homeCities' }],
      actor: 'root',
      note: 'first',
      restoredFrom: null
    },
    0
  );
  assert.equal(v1.version, 1);
  await assert.rejects(store.insertConfigVersion({ overrides: {}, secrets: {}, changes: [], actor: 'b', note: 'stale', restoredFrom: null }, 0), {
    code: 'ADMIN_CONFIG_CONFLICT'
  });
  const v2 = await store.insertConfigVersion(
    { overrides: {}, secrets: { 'enrich.apiKey': 'enc:x' }, changes: [], actor: 'root', note: 'restore', restoredFrom: 1 },
    1
  );
  assert.equal(v2.version, 2);
  assert.equal((await store.latestConfig()).version, 2);
  assert.deepEqual((await store.getConfigVersion(1)).overrides, { 'generation.homeCities': ['苏州'] });
  assert.equal((await store.getConfigVersion(2)).restoredFrom, 1);
  assert.deepEqual(
    (await store.listConfigVersions(10)).map((v) => v.version),
    [2, 1]
  );

  // admin accounts
  const admin = await store.createAdmin({ id: 'adm_contract', username: 'contract', passwordHash: 'h', totpSecretEnc: 'enc', role: 'admin' });
  assert.equal(admin.status, 'active');
  assert.equal(admin.totpConfirmed, false);
  await assert.rejects(store.createAdmin({ id: 'adm_dup', username: 'contract', passwordHash: 'h', totpSecretEnc: 'enc', role: 'operator' }), {
    code: 'ADMIN_USERNAME_TAKEN'
  });
  assert.equal((await store.findAdminByUsername('contract')).id, 'adm_contract');
  const updated = await store.updateAdmin('adm_contract', { totpConfirmed: true, failedAttempts: 2, backupCodeHashes: [{ hash: 'b1', usedAt: null }] });
  assert.equal(updated.totpConfirmed, true);
  assert.equal(updated.failedAttempts, 2);
  assert.equal((await store.getAdmin('adm_contract')).backupCodeHashes.length, 1);
  assert.equal((await store.listAdmins()).length, 1);
  // a TOTP step is accepted once, and never an older one
  assert.equal(await store.consumeTotpStep('adm_contract', 100), true);
  assert.equal(await store.consumeTotpStep('adm_contract', 100), false);
  assert.equal(await store.consumeTotpStep('adm_contract', 99), false);
  assert.equal(await store.consumeTotpStep('adm_contract', 101), true);

  // sessions
  const now = Date.now();
  await store.createSession({
    sidHash: 'sid1',
    adminId: 'adm_contract',
    csrfHash: 'c',
    expiresAt: new Date(now + 60000).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    createdAt: new Date(now).toISOString()
  });
  await store.createSession({
    sidHash: 'sid2',
    adminId: 'adm_contract',
    csrfHash: 'c',
    expiresAt: new Date(now + 60000).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    createdAt: new Date(now).toISOString()
  });
  assert.equal((await store.getSession('sid1')).adminId, 'adm_contract');
  await store.touchSession('sid1', new Date(now + 1000).toISOString());
  assert.equal(Date.parse((await store.getSession('sid1')).lastSeenAt), now + 1000);
  await store.deleteSession('sid1');
  assert.equal(await store.getSession('sid1'), null);
  await store.deleteAdminSessions('adm_contract');
  assert.equal(await store.getSession('sid2'), null);

  // audit: filter by action prefix, newest first
  for (const [i, action] of ['login', 'config.save', 'config.test-run'].entries()) {
    await store.addAudit({
      id: `aud_${i}`,
      actor: 'contract',
      role: 'admin',
      action,
      target: 't',
      detail: { i },
      ip: '127.0.0.1',
      createdAt: new Date(now + i).toISOString()
    });
  }
  assert.deepEqual(
    (await store.listAudit({ limit: 10, action: 'config.' })).map((e) => e.action),
    ['config.test-run', 'config.save']
  );
  assert.deepEqual((await store.listAudit({ limit: 1 }))[0].detail, { i: 2 });
  if (appendOnly) await appendOnly();

  // invites: max uses, expiry, revoke
  await store.createInvite({ id: 'inv_a', codeHash: 'hash-a', label: 'a', maxUses: 2, expiresAt: null, createdBy: 'contract' });
  await store.createInvite({
    id: 'inv_old',
    codeHash: 'hash-old',
    label: 'old',
    maxUses: 5,
    expiresAt: new Date(now - 1000).toISOString(),
    createdBy: 'contract'
  });
  assert.equal((await store.consumeInvite('hash-a')).used, 1);
  assert.equal((await store.consumeInvite('hash-a')).used, 2);
  assert.equal(await store.consumeInvite('hash-a'), null);
  assert.equal(await store.consumeInvite('hash-old'), null);
  assert.ok((await store.revokeInvite('inv_old')).revokedAt);
  assert.equal(await store.revokeInvite('inv_missing'), null);
  assert.equal((await store.listInvites()).length, 2);

  // corrections, report states, verified facts, quota resets
  await store.addCorrection({
    id: 'cor_1',
    routebookId: 'rb1',
    stopKey: 's1',
    field: 'price',
    action: 'reset',
    value: '',
    sourceUrl: '',
    reportId: null,
    reason: '来源过期了',
    actor: 'contract',
    createdAt: new Date(now).toISOString()
  });
  assert.equal((await store.listCorrections('rb1')).length, 1);
  assert.equal((await store.listCorrections('rb-other')).length, 0);
  // PostgreSQL keeps the state on the enrich_reports row itself, so the report has to exist first.
  if (seedReport) await seedReport('rep_1');
  await store.setReportState('rep_1', { status: 'resolved', resolvedBy: 'contract', resolvedAt: new Date(now).toISOString() });
  assert.equal((await store.reportStates()).get('rep_1').status, 'resolved');
  const fact = {
    cacheKey: '苏州|示例|price',
    city: '苏州',
    place: '示例',
    field: 'price',
    value: '示例值',
    sources: [{ url: 'https://example.org' }],
    scope: 'cache-key',
    verifiedBy: 'contract',
    verifiedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString()
  };
  await store.putVerifiedFact(fact);
  assert.equal((await store.getVerifiedFact(fact.cacheKey)).value, '示例值');
  assert.equal(await store.getVerifiedFact(fact.cacheKey, now + 2 * 86400000), null, 'expired facts are not served');
  assert.equal((await store.listVerifiedFacts()).length, 1);
  await store.deleteVerifiedFact(fact.cacheKey);
  assert.equal(await store.getVerifiedFact(fact.cacheKey), null);
  assert.equal(await store.quotaResetAt('p1'), null);
  await store.setQuotaReset('p1', new Date(now).toISOString(), 'contract');
  assert.equal(Date.parse(await store.quotaResetAt('p1')), now);
  await store.notifyConfigChanged(2);
}

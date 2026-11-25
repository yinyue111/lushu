import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PENDING_LOGOUT_RETRIES,
  OFFLINE_LOGOUT_TEXT,
  PENDING_LOGOUT_KEY,
  attachAccountToDevice,
  clearPendingLogout,
  executeLogout,
  isLogoutSettledError,
  readPendingLogout,
  retryPendingLogout,
  savePendingLogout
} from '../../src/lib/account.js';
import { logout as logoutApi, logoutAll as logoutAllApi } from '../../src/lib/accountApi.js';
import { getProfile, replaceProfile } from '../../src/lib/profile.js';
import { getStoredRoutebooks, saveRoutebook } from '../../src/lib/storage.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    }
  };
}

function installGlobals() {
  const local = createMemoryStorage();
  const session = createMemoryStorage();
  const deletedCaches = [];
  globalThis.localStorage = /** @type {any} */ (local);
  globalThis.sessionStorage = /** @type {any} */ (session);
  globalThis.caches = /** @type {any} */ ({
    async delete(name) {
      deletedCaches.push(name);
      return true;
    }
  });
  return { local, session, deletedCaches };
}

test('OFFLINE_LOGOUT_TEXT matches exact required copy', () => {
  assert.equal(OFFLINE_LOGOUT_TEXT, '网络不通，本机资料已清掉；联网后请再退出一次，才算彻底退出');
  assert.equal(OFFLINE_LOGOUT_TEXT.includes('没能连上服务器'), false);
});

test('pending logout storage helpers persist, upgrade everywhere flag, and clear cleanly', () => {
  const { local } = installGlobals();
  assert.equal(readPendingLogout(), null);

  local.setItem(PENDING_LOGOUT_KEY, '{broken-json');
  assert.equal(readPendingLogout(), null);

  const saved = savePendingLogout({ everywhere: false });
  assert.equal(saved.everywhere, false);
  assert.deepEqual(readPendingLogout()?.everywhere, false);

  savePendingLogout({ everywhere: true });
  assert.equal(readPendingLogout()?.everywhere, true);

  // Subsequent single-device retry attempt keeps everywhere=true until settled or cleared.
  savePendingLogout({ everywhere: false });
  assert.equal(readPendingLogout()?.everywhere, true);

  clearPendingLogout();
  assert.equal(readPendingLogout(), null);
});

test('offline or 5xx logout still wipes local routebooks, profile, and SW cache while queuing pending logout', async () => {
  const { local, deletedCaches } = installGlobals();
  replaceProfile({ id: 'prof_acc_1', accountUserId: 'u_1', creatorName: '小王' });
  saveRoutebook({
    id: 'rb_local_1',
    publicId: 'rb_local_1',
    profileId: 'prof_acc_1',
    city: '杭州',
    title: '西湖一日散步',
    stops: [{ id: 's1', name: '断桥' }]
  });
  local.setItem('trusted-routebook:favorites:prof_acc_1', JSON.stringify([{ routeId: 'rb_local_1', profileId: 'prof_acc_1' }]));
  assert.equal(getStoredRoutebooks('prof_acc_1').length, 1);

  const result = await executeLogout({
    everywhere: false,
    accountProfileId: 'prof_acc_1',
    remoteLogout: async () => {
      throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    }
  });

  assert.equal(result.settled, false);
  assert.equal(result.toast, OFFLINE_LOGOUT_TEXT);
  assert.equal(getStoredRoutebooks('prof_acc_1').length, 0);
  assert.equal(local.getItem('trusted-routebook:favorites:prof_acc_1'), null);
  assert.notEqual(getProfile().id, 'prof_acc_1');
  assert.equal(Boolean(getProfile().accountUserId), false);
  assert.deepEqual(readPendingLogout()?.everywhere, false);
  assert.ok(deletedCaches.includes('trusted-routebook-pwa-routebook-data-v1'));
});

test('accountApi logout and logoutAll clear offline SW routebook cache even when fetch fails', async () => {
  const { deletedCaches } = installGlobals();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    await assert.rejects(() => logoutApi());
    await assert.rejects(() => logoutAllApi());
    assert.equal(deletedCaches.filter((name) => name === 'trusted-routebook-pwa-routebook-data-v1').length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP 401 on logout or pending retry treats session as already logged out and clears marker', async () => {
  installGlobals();
  assert.equal(isLogoutSettledError({ status: 401 }), true);
  assert.equal(isLogoutSettledError({ status: 503 }), false);
  assert.equal(isLogoutSettledError(new Error('offline')), false);

  savePendingLogout({ everywhere: true });
  const failedRetry = await retryPendingLogout({
    accountProfileId: 'prof_acc_2',
    remoteLogout: async () => {
      throw Object.assign(new Error('Bad Gateway'), { status: 502 });
    }
  });
  assert.equal(failedRetry.settled, false);
  assert.equal(failedRetry.pending, true);
  assert.equal(readPendingLogout()?.everywhere, true);

  const settled401 = await retryPendingLogout({
    accountProfileId: 'prof_acc_2',
    remoteLogout: async (everywhere) => {
      assert.equal(everywhere, true);
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }
  });
  assert.equal(settled401.settled, true);
  assert.equal(settled401.pending, false);
  assert.equal(settled401.toast, '已在所有设备上退出登录');
  assert.equal(readPendingLogout(), null);

  const direct401 = await executeLogout({
    everywhere: false,
    accountProfileId: 'prof_acc_2',
    remoteLogout: async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }
  });
  assert.equal(direct401.settled, true);
  assert.equal(direct401.toast, '已退出登录');
  assert.equal(readPendingLogout(), null);
});

test('re-authenticating cancels queued pending logout and prevents stale in-flight retry from logging out', async () => {
  installGlobals();
  savePendingLogout({ everywhere: true });
  assert.equal(readPendingLogout()?.everywhere, true);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ claimed: 0, skipped: 0, profileOwnedElsewhere: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  try {
    await attachAccountToDevice({ id: 'u_new', profileId: 'prof_new', phoneMasked: '138****0001' });
    assert.equal(readPendingLogout(), null);
    assert.equal(getProfile().id, 'prof_new');

    // Even if an earlier retry was mid-flight when login happened, isCancelled prevents detachment.
    savePendingLogout({ everywhere: false });
    clearPendingLogout();
    const cancelled = await retryPendingLogout({
      accountProfileId: 'prof_new',
      remoteLogout: async () => ({ ok: true }),
      isCancelled: () => true
    });
    assert.equal(cancelled.settled, false);
    assert.equal(getProfile().id, 'prof_new');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retryPendingLogout caps consecutive failed retries at MAX_PENDING_LOGOUT_RETRIES (3) and clears marker', async () => {
  installGlobals();
  assert.equal(MAX_PENDING_LOGOUT_RETRIES, 3);
  savePendingLogout({ everywhere: false });

  const r1 = await retryPendingLogout({
    remoteLogout: async () => {
      throw Object.assign(new Error('502 Bad Gateway'), { status: 502 });
    }
  });
  assert.equal(r1.pending, true);
  assert.equal(r1.attempts, 1);
  assert.equal(readPendingLogout()?.attempts, 1);

  const r2 = await retryPendingLogout({
    remoteLogout: async () => {
      throw new TypeError('Failed to fetch');
    }
  });
  assert.equal(r2.pending, true);
  assert.equal(r2.attempts, 2);
  assert.equal(readPendingLogout()?.attempts, 2);

  const r3 = await retryPendingLogout({
    remoteLogout: async () => {
      throw Object.assign(new Error('503 Unavailable'), { status: 503 });
    }
  });
  assert.equal(r3.settled, false);
  assert.equal(r3.pending, false);
  assert.equal(r3.dropped, true);
  assert.equal(r3.attempts, 3);
  assert.equal(readPendingLogout(), null);
});

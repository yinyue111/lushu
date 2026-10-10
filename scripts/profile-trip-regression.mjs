import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticServerEnv } from './lib/hermetic-env.mjs';

const directory = await mkdtemp(join(tmpdir(), 'lushu-profile-trip-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = /** @type {import('node:net').AddressInfo} */ (probe.address()).port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs', '--production'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: hermeticServerEnv({
    ROUTEBOOK_DATA_DIR: directory,
    PORT: String(port),
    HOST: '127.0.0.1',
    PROFILE_ID_SECRET: 'profile-trip-regression-secret',
    ROUTEBOOK_ADMIN_TOKEN: 'profile-trip-admin',
    ALLOW_LOCAL_ADMIN_BYPASS: 'false',
    ALLOW_LOCAL_API_BYPASS: 'false',
    RATE_LIMIT_MAX: '1000',
    RATE_LIMIT_CORE_WRITE_MAX: '1000',
    RATE_LIMIT_PUBLIC_READ_MAX: '1000'
  })
});
let logs = '';
child.stdout.on('data', (data) => {
  logs += data;
});
child.stderr.on('data', (data) => {
  logs += data;
});

/** @param {string} path @param {{method?: string, body?: any, profile?: any, admin?: boolean}} options */
async function request(path, { method = 'GET', body, profile, admin = false } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(profile ? { 'x-routebook-profile-id': profile.id, 'x-routebook-profile-token': profile.profileAccessToken } : {}),
      ...(admin ? { 'x-routebook-admin-token': 'profile-trip-admin' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

try {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited: ${logs}`);
    try {
      if ((await request('/live')).status === 200) break;
    } catch {
      /* Wait for isolated server. */
    }
    if (attempt === 149) throw new Error(`server did not start: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const registration = { id: 'p_local_trip_fixture', creatorName: '隐私测试旅行者', pendingRegistrationSecret: `preg_${'a'.repeat(43)}` };
  const first = await request('/profile', { method: 'POST', body: registration });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  let profile = first.data.profile;
  const replay = await request('/profile', { method: 'POST', body: registration });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.profile.id, profile.id, 'lost registration response must not create another account');
  assert.equal(replay.data.profile.profileAccessToken, profile.profileAccessToken);
  const issued = await request('/profile/recovery-code', { method: 'POST', body: { profileId: profile.id }, profile });
  assert.equal(issued.status, 200);
  const code = JSON.parse(Buffer.from(issued.data.recoveryCode.slice(5), 'base64url').toString());
  assert.equal(code.version, 2);
  assert.equal(code.profileAccessToken, undefined, 'new recovery codes are scoped signed proofs, not embedded access tokens');
  const recoveryPayload = { id: profile.id, recoveryNonce: code.nonce, recoveryExpiresAt: code.expiresAt, recoveryProof: code.proof };
  const recovered = await request('/profile', { method: 'POST', body: recoveryPayload });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.notEqual(recovered.data.profile.profileAccessToken, profile.profileAccessToken);
  assert.equal((await request(`/profile/export?profileId=${profile.id}`, { profile })).status, 403, 'old device token revoked');
  profile = recovered.data.profile;
  const used = await request('/profile', { method: 'POST', body: recoveryPayload });
  assert.equal(used.data.code, 'RECOVERY_CODE_USED');

  const routeId = 'hangzhou-westlake-tea';
  const shared = await request(`/share/${routeId}`);
  assert.equal(shared.status, 200);
  const stops = shared.data.routebook.stops.slice(0, 3);
  const ownedRouteId = 'profile-delete-owned-route';
  const ownedDraft = {
    id: ownedRouteId,
    publicId: ownedRouteId,
    city: '杭州',
    title: '删除屏障测试路书',
    stops,
    profileId: profile.id,
    editToken: 'rt_deletion_barrier_test_token_12345',
    expectedVersion: 0
  };
  const ownedSaved = await request('/routebooks', { method: 'POST', profile, body: ownedDraft });
  assert.equal(ownedSaved.status, 200, JSON.stringify(ownedSaved.data));
  const tokenOnlySaved = await request('/routebooks', { method: 'POST', body: { ...ownedDraft, profileId: 'anonymous', expectedVersion: 1 } });
  assert.equal(tokenOnlySaved.status, 200, JSON.stringify(tokenOnlySaved.data));
  assert.equal(tokenOnlySaved.data.routebook.profileId, profile.id, 'edit token permits edits, not owner transfer to anonymous');
  const tripPath = `/trip-sessions/${routeId}`;
  assert.equal((await request(`${tripPath}?profileId=${profile.id}`, { profile })).data.session, null);
  const firstTrip = await request(tripPath, {
    method: 'POST',
    profile,
    body: { profileId: profile.id, stops, currentStopId: String(stops[0].id), expectedRevision: 0 }
  });
  assert.equal(firstTrip.status, 200, JSON.stringify(firstTrip.data));
  assert.equal(firstTrip.data.session.revision, 1);
  const concurrent = await Promise.all(
    [1, 2].map(() => request(tripPath, { method: 'POST', profile, body: { profileId: profile.id, stops: [...stops].reverse(), expectedRevision: 1 } }))
  );
  assert.deepEqual(concurrent.map((item) => item.status).sort(), [200, 409]);
  assert.equal(concurrent.find((item) => item.status === 409).data.code, 'TRIP_SESSION_CONFLICT');
  assert.equal((await request(`${tripPath}?profileId=someone_else`, { profile })).status, 403);
  const cloud = await request(`${tripPath}?profileId=${profile.id}`, { profile });
  assert.equal(cloud.data.session.revision, 2);

  const photo = await request('/checkin-photos', {
    method: 'POST',
    profile,
    body: {
      profileId: profile.id,
      routeId,
      clientLocalId: 'photo-profile-delete',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6WQAAAAASUVORK5CYII='
    }
  });
  assert.equal(photo.status, 200, JSON.stringify(photo.data));
  const photoId = photo.data.photo.id;
  assert.equal((await fetch(`${base}/api/checkin-photos/${photoId}`)).status, 404, 'unattached upload is private');
  assert.equal(
    (
      await fetch(`${base}/api/checkin-photos/${photoId}`, {
        headers: { 'x-routebook-profile-id': profile.id, 'x-routebook-profile-token': profile.profileAccessToken }
      })
    ).status,
    200,
    'owner can read private upload using profile credentials'
  );
  assert.equal(
    (await fetch(`${base}/api/checkin-photos/${photoId}`, { headers: { 'x-routebook-admin-token': 'profile-trip-admin' } })).status,
    200,
    'administrator can audit a private upload'
  );
  assert.equal(
    (
      await fetch(`${base}/api/checkin-photos/${photoId}`, {
        headers: { 'x-routebook-profile-id': profile.id, 'x-routebook-profile-token': first.data.profile.profileAccessToken }
      })
    ).status,
    404,
    'revoked owner credentials cannot read a private upload'
  );
  const privatePhotoCheckin = await request('/checkins', {
    method: 'POST',
    profile,
    body: { profileId: profile.id, routeId: ownedRouteId, stopId: stops[0].id, photoId, clientLocalId: 'private-photo-witness' }
  });
  assert.equal(privatePhotoCheckin.status, 200, JSON.stringify(privatePhotoCheckin.data));
  assert.equal((await fetch(`${base}/api/checkin-photos/${photoId}`)).status, 404, 'a checkin for another private route cannot make the photo public');
  const publicPhotoCheckin = await request('/checkins', {
    method: 'POST',
    profile,
    body: { profileId: profile.id, routeId, stopId: stops[0].id, photoId, clientLocalId: 'public-photo-witness' }
  });
  assert.equal(publicPhotoCheckin.status, 200, JSON.stringify(publicPhotoCheckin.data));
  assert.equal((await fetch(`${base}/api/checkin-photos/${photoId}`)).status, 200);
  const exclusion = await request(`/ops/checkins/${publicPhotoCheckin.data.checkin.id}/audits`, {
    method: 'POST',
    admin: true,
    body: { action: 'exclude', reason: '图片证据审核发现需要暂时排除' }
  });
  assert.equal(exclusion.status, 200, JSON.stringify(exclusion.data));
  assert.equal(
    (await fetch(`${base}/api/checkin-photos/${photoId}`)).status,
    404,
    'excluded public sample must not leave its evidence photo publicly accessible'
  );
  const restoration = await request(`/ops/checkins/${publicPhotoCheckin.data.checkin.id}/audits`, {
    method: 'POST',
    admin: true,
    body: { action: 'restore', reason: '图片证据经过重新检查允许恢复' }
  });
  assert.equal(restoration.status, 200, JSON.stringify(restoration.data));
  assert.equal((await fetch(`${base}/api/checkin-photos/${photoId}`)).status, 200);
  for (const marker of [{ deleted: true }, { tombstone: true }, { deletedAt: new Date().toISOString() }]) {
    // Isolated fixture mutation models future checkin withdrawal/imported tombstones.
    await appendFile(join(directory, 'checkins.jsonl'), `${JSON.stringify({ ...publicPhotoCheckin.data.checkin, ...marker })}\n`);
    assert.equal((await fetch(`${base}/api/checkin-photos/${photoId}`)).status, 404, 'an obsolete live version cannot override the latest withdrawal marker');
    await appendFile(join(directory, 'checkins.jsonl'), `${JSON.stringify(publicPhotoCheckin.data.checkin)}\n`);
    assert.equal((await fetch(`${base}/api/checkin-photos/${photoId}`)).status, 200);
  }
  const photoResponse = await fetch(`${base}/api/checkin-photos/${photoId}`, { headers: { 'x-routebook-admin-token': 'profile-trip-admin' } });
  assert.equal(photoResponse.status, 200);
  assert.match(photoResponse.headers.get('cache-control'), /no-store/);
  const exported = await request(`/profile/export?profileId=${profile.id}`, { profile });
  assert.equal(exported.status, 200, JSON.stringify(exported.data));
  assert.equal(exported.data.export.tripSessions.length, 2);
  assert.equal(exported.data.export.photos.length, 1);
  assert.ok(exported.data.export.photos[0].contentBase64);
  assert.equal(exported.data.export.profile.accessTokenHash, undefined);
  assert.equal(exported.data.export.profile.usedRecoveryNonces, undefined);
  assert.equal((await request('/profile', { method: 'DELETE', profile, body: { profileId: profile.id } })).status, 400);
  const removed = await request('/profile', { method: 'DELETE', profile, body: { profileId: profile.id, confirmation: 'DELETE' } });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await request('/profile', { method: 'DELETE', profile, body: { profileId: profile.id, confirmation: 'DELETE' } })).data.alreadyDeleted, true);
  assert.equal((await request('/profile', { method: 'POST', body: profile })).status, 410);
  assert.equal((await request(`${tripPath}?profileId=${profile.id}`, { profile })).status, 410);
  assert.equal((await request(`/profile/export?profileId=${profile.id}`, { profile })).status, 410);
  assert.equal((await fetch(`${base}/api/checkin-photos/${photoId}`, { headers: { 'x-routebook-admin-token': 'profile-trip-admin' } })).status, 404);
  const staleTokenSave = await request('/routebooks', { method: 'POST', body: { ...ownedDraft, profileId: 'anonymous', expectedVersion: 2 } });
  // Deleted with the profile: the id is tombstoned, so the stale copy gets a clear 410, not a generic 403.
  assert.equal(staleTokenSave.status, 410, JSON.stringify(staleTokenSave.data));
  assert.equal(staleTokenSave.data.code, 'ROUTEBOOK_DELETED');
  const adminBooksAfterDeletion = await request('/routebooks', { admin: true });
  assert.equal(adminBooksAfterDeletion.status, 200);
  assert.equal(
    adminBooksAfterDeletion.data.routebooks.some((book) => book.id === ownedRouteId),
    false,
    'tombstones never enter normal routebook lists'
  );
  assert.equal((await request(`/routebooks/${ownedRouteId}`, { admin: true })).status, 404);
  const tripRows = await readFile(join(directory, 'trip-sessions.jsonl'), 'utf8');
  assert.equal(tripRows.trim(), '', 'deletion physically removes trip history');
  const profileRows = await readFile(join(directory, 'profiles.jsonl'), 'utf8');
  assert.ok(!profileRows.includes('隐私测试旅行者'));
  assert.ok(!profileRows.includes(code.proof));
  console.log('profile/trip regression passed: registration replay, one-use recovery, owner isolation, CAS, export, delete and photo 404');
} finally {
  if (child.exitCode == null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await rm(directory, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRouteTrustPresentation } from '../src/lib/trust.js';

const APP_ID = 'trusted-routebook';
const ADMIN_TOKEN = 'p0-regression-admin';
const PUBLIC_TOKEN = 'p0-regression-public';
const IDENTITY_SECRET = 'p0-regression-identity-secret';
const CURATED_IDS = [
  'hangzhou-westlake-tea',
  'shanghai-wukang-anfu',
  'suzhou-pingjiang-garden'
];

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function findAvailablePort(startPort = 5399) {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolve(findAvailablePort(startPort + 1));
        return;
      }
      reject(error);
    });
    server.listen(startPort, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 30000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fetchJson(`${baseUrl}/api/health`);
      if (result.response.ok && result.data.appId === APP_ID && result.data.ready) return;
      lastError = new Error(`health response: ${JSON.stringify(result.data)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`P0 regression server did not become ready: ${lastError?.message ?? 'unknown error'}`);
}

async function waitForLive(baseUrl, timeoutMs = 30000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fetchJson(`${baseUrl}/api/live`);
      if (result.response.ok && result.data.live) return;
      lastError = new Error(`live response: ${JSON.stringify(result.data)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`P0 not-ready server did not become live: ${lastError?.message ?? 'unknown error'}`);
}

function adminHeaders() {
  return { 'x-routebook-admin-token': ADMIN_TOKEN };
}

function profileHeaders(profile) {
  return {
    'content-type': 'application/json',
    'x-routebook-profile-id': profile.id,
    'x-routebook-profile-token': profile.profileAccessToken
  };
}

function identityProof(subject) {
  const issuedAt = new Date().toISOString();
  const nonce = `p0-${Date.now()}-${subject.slice(-4)}`;
  const payload = `${APP_ID}:phone:${subject}:${issuedAt}:${nonce}`;
  return {
    type: 'phone',
    subject,
    issuedAt,
    nonce,
    signature: createHmac('sha256', IDENTITY_SECRET).update(payload).digest('hex')
  };
}

function shanghaiDate(offsetDays = 0) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  const base = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return new Date(base + offsetDays * 86400000).toISOString().slice(0, 10);
}

function assertTrustPresentationGuards() {
  for (const displayScore of [null, undefined, '', '   ', -1, 101]) {
    const trust = getRouteTrustPresentation({
      trustMeta: { source: 'verified-feedback', sampleCount: 3, displayScore }
    });
    assert.equal(trust.verified, false, `displayScore=${String(displayScore)} must stay unverified`);
    assert.equal(trust.score, null);
  }
  const nonCanonical = getRouteTrustPresentation({
    trustMeta: { source: 'manual', sampleCount: 3, displayScore: 88 }
  });
  assert.equal(nonCanonical.verified, false, 'only verified-feedback may unlock a public score');
  const verifiedZero = getRouteTrustPresentation({
    trustMeta: { source: 'verified-feedback', sampleCount: 3, displayScore: 0 }
  });
  assert.equal(verifiedZero.verified, true, 'an explicit in-range zero is a valid score');
  assert.equal(verifiedZero.score, 0);
  const verified = getRouteTrustPresentation({
    trustMeta: { source: 'verified-feedback', sampleCount: 3, displayScore: '88' }
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.score, 88);
}

function routePayload({ id, city, title, stops, travelDate = '' }) {
  return {
    id,
    publicId: id,
    city,
    title,
    summary: 'P0 回归使用的隔离路书。',
    ...(travelDate ? { travelDate, constraints: { date: travelDate } } : {}),
    days: ['Day 1'],
    stops: stops.map((stop, index) => ({
      id: `${id}-stop-${index + 1}`,
      day: 'Day 1',
      time: index ? '11:00' : '09:00',
      area: '测试片区',
      stay: '60 分钟',
      cost: '免费',
      verify: 'P0 回归站点',
      risk: '无',
      score: 82,
      ...stop
    }))
  };
}

function assertApiRequestId(result, label) {
  const headerRequestId = result.response.headers.get('x-request-id');
  assert.ok(headerRequestId, `${label} should return x-request-id`);
  assert.equal(result.data.requestId, headerRequestId, `${label} body/header request IDs should match`);
}

async function saveRoute(baseUrl, payload) {
  const result = await fetchJson(`${baseUrl}/api/routebooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(result.response.status, 200, `save ${payload.id}: ${JSON.stringify(result.data)}`);
  assert.equal(result.data.routebook?.publicId, payload.id);
  return result.data.routebook;
}

async function getRoute(baseUrl, routeId) {
  const result = await fetchJson(`${baseUrl}/api/routebooks/${encodeURIComponent(routeId)}`, {
    headers: adminHeaders()
  });
  assert.equal(result.response.status, 200, `get ${routeId}: ${JSON.stringify(result.data)}`);
  return result.data.routebook;
}

async function createProfile(baseUrl, { localId, subject = '' }) {
  const result = await fetchJson(`${baseUrl}/api/profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: localId,
      homeCity: '杭州',
      ...(subject ? { identity: identityProof(subject) } : {})
    })
  });
  assert.equal(result.response.status, 200, `create profile: ${JSON.stringify(result.data)}`);
  assert.ok(result.data.profile?.id);
  assert.ok(result.data.profile?.profileAccessToken);
  return result.data.profile;
}

async function submitCheckin(baseUrl, profile, routebook, stop, clientLocalId, extra = {}) {
  return fetchJson(`${baseUrl}/api/checkins`, {
    method: 'POST',
    headers: profileHeaders(profile),
    body: JSON.stringify({
      profileId: profile.id,
      routeId: routebook.publicId,
      routeTitle: routebook.title,
      city: routebook.city,
      stopId: stop.id,
      stopName: stop.name,
      clientLocalId,
      status: 'visited',
      worth: '值得',
      crowd: '适中',
      gps: {
        lat: Number(stop.lat),
        lng: Number(stop.lng),
        accuracy: 20
      },
      ...extra
    })
  });
}

async function recordJourneyEvent(baseUrl, profile, routebook, surface) {
  const result = await fetchJson(`${baseUrl}/api/exposures`, {
    method: 'POST',
    headers: profileHeaders(profile),
    body: JSON.stringify({
      profileId: profile.id,
      surface,
      itemType: 'journey-event',
      itemId: routebook.publicId,
      routeId: routebook.publicId,
      routeTitle: routebook.title,
      city: routebook.city,
      travelDate: routebook.travelDate || routebook.constraints?.date || routebook.provider?.travelDate || ''
    })
  });
  assert.equal(result.response.status, 200, `${surface}: ${JSON.stringify(result.data)}`);
  return result.data.exposure;
}

function stopByName(routebook, name) {
  const stop = routebook.stops?.find((item) => item.name === name);
  assert.ok(stop, `${routebook.publicId} should contain ${name}`);
  return stop;
}

function assertNoPrivateRouteFields(routebook, label) {
  assert.equal(Object.hasOwn(routebook, 'editToken'), false, `${label} leaked editToken`);
  assert.equal(Object.hasOwn(routebook, 'profileId'), false, `${label} leaked profileId`);
  assert.equal(Object.hasOwn(routebook, 'constraints'), false, `${label} leaked private constraints`);
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

async function assertNotReadyEndpoint(projectRoot, dataDir) {
  const port = await findAvailablePort(Number(process.env.P0_NOT_READY_TEST_PORT ?? 5499));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      ROUTEBOOK_DATA_DIR: join(dataDir, 'not-ready'),
      PROFILE_ID_SECRET: 'p0-not-ready-profile-secret',
      CODEX_CONFIG_PATH: join(dataDir, 'missing-config.toml'),
      CODEX_AUTH_PATH: join(dataDir, 'missing-auth.json'),
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForLive(baseUrl);
    const ready = await fetchJson(`${baseUrl}/api/ready`);
    assert.equal(ready.response.status, 503, JSON.stringify(ready.data));
    assert.equal(ready.data.ready, false);
    assert.deepEqual(Object.keys(ready.data).sort(), ['appId', 'checks', 'ok', 'ready', 'reasonCodes', 'requestId']);
    assert.deepEqual(ready.data.checks.storage, { ready: true, code: 'READY' });
    assert.equal(ready.data.checks.runtime?.ready, false);
    assert.ok(['MODEL_RUNTIME_NOT_READY', 'MODEL_RUNTIME_CHECK_FAILED'].includes(ready.data.checks.runtime?.code));
    assert.deepEqual(ready.data.reasonCodes, [ready.data.checks.runtime.code]);
    const serialized = JSON.stringify(ready.data);
    for (const forbidden of ['provider', 'model', 'baseUrl', 'apiKey', 'OPENAI_API_KEY']) {
      assert.equal(serialized.includes(forbidden), false, `/api/ready must not expose ${forbidden}`);
    }
    assertApiRequestId(ready, 'not-ready');
  } finally {
    await stopChild(child);
  }
}

async function main() {
  assertTrustPresentationGuards();
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-p0-'));
  const port = await findAvailablePort(Number(process.env.P0_TEST_PORT ?? 5399));
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      ROUTEBOOK_DATA_DIR: dataDir,
      ROUTEBOOK_ADMIN_TOKEN: ADMIN_TOKEN,
      ROUTEBOOK_API_TOKEN: PUBLIC_TOKEN,
      ALLOW_PUBLIC_MODEL_PROXY: 'true',
      PROFILE_ID_SECRET: 'p0-regression-profile-secret',
      PROFILE_IDENTITY_ASSERTION_SECRET: IDENTITY_SECRET,
      REQUIRE_LOCAL_ADMIN_TOKEN: 'true',
      ALLOW_LOCAL_ADMIN_BYPASS: 'false',
      RATE_LIMIT_MAX: '500',
      RATE_LIMIT_WINDOW_MS: '60000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForHealth(baseUrl);

    const health = await fetchJson(`${baseUrl}/api/health`);
    assert.equal(health.response.status, 200);
    assertApiRequestId(health, 'health');
    const live = await fetchJson(`${baseUrl}/api/live`);
    assert.equal(live.response.status, 200);
    assert.equal(live.data.live, true);
    assert.deepEqual(Object.keys(live.data).sort(), ['appId', 'live', 'ok', 'requestId']);
    assertApiRequestId(live, 'live');
    const ready = await fetchJson(`${baseUrl}/api/ready`);
    assert.equal(ready.response.status, 200, JSON.stringify(ready.data));
    assert.equal(ready.data.ready, true);
    assert.deepEqual(Object.keys(ready.data).sort(), ['appId', 'checks', 'ok', 'ready', 'reasonCodes', 'requestId']);
    assert.deepEqual(ready.data.checks, {
      storage: { ready: true, code: 'READY' },
      runtime: { ready: true, code: 'READY' }
    });
    assert.deepEqual(ready.data.reasonCodes, []);
    assertApiRequestId(ready, 'ready');
    const missingApi = await fetchJson(`${baseUrl}/api/p0-request-id-not-found`);
    assert.equal(missingApi.response.status, 404);
    assertApiRequestId(missingApi, 'API error');
    await assertNotReadyEndpoint(projectRoot, dataDir);

    let firstCurated = null;
    for (const routeId of CURATED_IDS) {
      const detail = await fetchJson(`${baseUrl}/api/routebooks/${routeId}`);
      assert.equal(detail.response.status, 200, `curated detail ${routeId}: ${JSON.stringify(detail.data)}`);
      assert.equal(detail.data.routebook?.publishStatus, 'featured');
      assert.ok(detail.data.routebook?.stops?.every((stop) => stop.poiId));
      assert.equal(detail.data.routebook?.trustScore, null, 'public routes below the sample threshold must hide route scores');
      assert.equal(detail.data.routebook?.trustMeta?.predictionScore, null, 'public routes must not leak prediction scores');
      assert.equal(detail.data.routebook?.stops?.every((stop) => stop.score == null && stop.poiTrust?.score == null), true);
      assertNoPrivateRouteFields(detail.data.routebook, `curated detail ${routeId}`);

      const share = await fetchJson(`${baseUrl}/api/share/${routeId}`);
      assert.equal(share.response.status, 200, `curated share ${routeId}: ${JSON.stringify(share.data)}`);
      assert.equal(share.data.routebook?.publishStatus, 'featured');
      assertNoPrivateRouteFields(share.data.routebook, `curated share ${routeId}`);
      firstCurated ??= detail.data.routebook;
    }

    const reservedSave = await fetchJson(`${baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(firstCurated)
    });
    assert.equal(reservedSave.response.status, 403);
    assert.equal(reservedSave.data.code, 'CURATED_ROUTE_ID_RESERVED');

    const copiedCurated = await fetchJson(`${baseUrl}/api/routebooks/${CURATED_IDS[0]}/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'p0-curated-copy-session', surface: 'public-share' })
    });
    assert.equal(copiedCurated.response.status, 200, JSON.stringify(copiedCurated.data));
    assertNoPrivateRouteFields(copiedCurated.data.routebook, 'curated copy response');

    const routeA = await saveRoute(baseUrl, routePayload({
      id: 'p0-route-a',
      city: '杭州',
      title: 'P0 路线 A',
      travelDate: shanghaiDate(0),
      stops: [
        { name: '柳浪闻莺', lat: 30.242, lng: 120.1617 },
        { name: '茅家埠', lat: 30.2468, lng: 120.1139 }
      ]
    }));
    const routeB = await saveRoute(baseUrl, routePayload({
      id: 'p0-route-b',
      city: '杭州',
      title: 'P0 路线 B',
      travelDate: shanghaiDate(10),
      stops: [
        { name: '柳浪闻莺', lat: 30.242, lng: 120.1617 },
        { name: '南宋御街', lat: 30.2432, lng: 120.1696 }
      ]
    }));
    const otherCityRoute = await saveRoute(baseUrl, routePayload({
      id: 'p0-route-other-city',
      city: '上海',
      title: 'P0 同名跨城路线',
      stops: [
        { name: '柳浪闻莺', lat: 31.2304, lng: 121.4737 },
        { name: '测试街区', lat: 31.228, lng: 121.47 }
      ]
    }));
    const partialNameRoute = await saveRoute(baseUrl, routePayload({
      id: 'p0-route-partial-name',
      city: '杭州',
      title: 'P0 部分名称路线',
      travelDate: '2026-02-30',
      stops: [
        { name: '柳浪闻莺东门', lat: 30.241, lng: 120.163 },
        { name: '测试路口', lat: 30.244, lng: 120.166 }
      ]
    }));
    assert.equal(partialNameRoute.travelDate, '', 'impossible calendar dates must be rejected');
    assert.equal(partialNameRoute.constraints?.date, '', 'invalid constraint dates must not persist');
    assert.equal(partialNameRoute.provider?.travelDate, undefined, 'invalid provider date snapshots must not persist');

    const stopA = stopByName(routeA, '柳浪闻莺');
    const stopB = stopByName(routeB, '柳浪闻莺');
    assert.equal(stopA.poiId, stopB.poiId, 'same POI should have a stable cross-route poiId');

    const ownedProfile = await createProfile(baseUrl, { localId: 'p0-owned-profile' });
    assert.equal(ownedProfile.identityBound, false);
    const ownedCheckin = await submitCheckin(
      baseUrl,
      ownedProfile,
      routeA,
      stopA,
      'p0-owned-checkin',
      { poiId: 'poi-client-forged' }
    );
    assert.equal(ownedCheckin.response.status, 200, JSON.stringify(ownedCheckin.data));
    assert.equal(ownedCheckin.data.checkin?.trustState, 'profile-owned');
    assert.equal(ownedCheckin.data.checkin?.serverResolvedStop, true);
    assert.equal(ownedCheckin.data.checkin?.poiId, stopA.poiId);
    assert.notEqual(ownedCheckin.data.checkin?.poiId, 'poi-client-forged');

    let routeBAfterFeedback = await getRoute(baseUrl, routeB.publicId);
    assert.equal(stopByName(routeBAfterFeedback, '柳浪闻莺').poiTrust?.sampleCount, 1, 'profile-owned with valid GPS counts as one deduped public POI sample');

    const attestedProfile = await createProfile(baseUrl, {
      localId: 'p0-attested-profile',
      subject: '13900000001'
    });
    assert.equal(attestedProfile.identityBound, true);
    const attestedCheckinA = await submitCheckin(
      baseUrl,
      attestedProfile,
      routeA,
      stopA,
      'p0-attested-route-a',
      { poiId: 'poi-client-forged-again' }
    );
    assert.equal(attestedCheckinA.response.status, 200, JSON.stringify(attestedCheckinA.data));
    assert.equal(attestedCheckinA.data.checkin?.trustState, 'profile-attested');
    assert.equal(attestedCheckinA.data.checkin?.poiId, stopA.poiId);

    const concurrentClientLocalId = 'p0-concurrent-client-local-id';
    const concurrentResults = await Promise.all(Array.from({ length: 8 }, () => submitCheckin(
      baseUrl,
      attestedProfile,
      routeA,
      stopA,
      concurrentClientLocalId
    )));
    assert.equal(concurrentResults.every((result) => result.response.status === 200), true);
    assert.equal(new Set(concurrentResults.map((result) => result.data.checkin?.id)).size, 1, 'concurrent retries must return one checkin ID');
    assert.equal(concurrentResults.filter((result) => result.data.deduplicated === false).length, 1, 'only one concurrent request may persist');
    assert.equal(concurrentResults.filter((result) => result.data.deduplicated === true).length, 7, 'the remaining concurrent requests must deduplicate');
    const concurrentPersistedRows = (await readFile(join(dataDir, 'checkins.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.profileId === attestedProfile.id && row.routeId === routeA.publicId && row.clientLocalId === concurrentClientLocalId);
    assert.equal(concurrentPersistedRows.length, 1, 'concurrent clientLocalId retries must persist exactly one JSONL row');

    routeBAfterFeedback = await getRoute(baseUrl, routeB.publicId);
    const crossRoutePoiTrust = stopByName(routeBAfterFeedback, '柳浪闻莺').poiTrust;
    assert.equal(crossRoutePoiTrust?.scope, 'cross-route-poi');
    assert.equal(crossRoutePoiTrust?.sampleCount, 2, 'route B should inherit the deduped POI samples (owned + attested identities) from route A');
    assert.equal(routeBAfterFeedback.trustMeta?.sampleCount, 0, 'route B must not inherit route-level trust samples from route A');

    const otherCityAfterFeedback = await getRoute(baseUrl, otherCityRoute.publicId);
    assert.equal(stopByName(otherCityAfterFeedback, '柳浪闻莺').poiTrust?.sampleCount, 0, 'same name in another city must not share POI feedback');
    const partialAfterFeedback = await getRoute(baseUrl, partialNameRoute.publicId);
    assert.equal(stopByName(partialAfterFeedback, '柳浪闻莺东门').poiTrust?.sampleCount, 0, 'partial POI names must not share feedback');

    const attestedCheckinB = await submitCheckin(
      baseUrl,
      attestedProfile,
      routeB,
      stopB,
      'p0-attested-route-b'
    );
    assert.equal(attestedCheckinB.response.status, 200, JSON.stringify(attestedCheckinB.data));

    const historicalProfile = await createProfile(baseUrl, {
      localId: 'p0-historical-attested-profile',
      subject: '13900000002'
    });
    await appendFile(join(dataDir, 'checkins.jsonl'), `${JSON.stringify({
      id: 'p0-historical-eligible-checkin',
      trustState: 'profile-attested',
      profileId: historicalProfile.id,
      routeId: routeA.publicId,
      clientLocalId: 'p0-historical-client-local-id',
      routeTitle: routeA.title,
      city: routeA.city,
      localStopKey: stopA.id,
      stopId: stopA.id,
      poiId: stopA.poiId,
      stopName: stopA.name,
      serverResolvedStop: true,
      status: 'visited',
      worth: '值得',
      arrival: { valid: true, confidence: 'valid' },
      createdAt: `${shanghaiDate(-45)}T04:00:00.000Z`
    })}\n`, 'utf8');

    const journeyPairs = [
      [ownedProfile, routeA],
      [attestedProfile, routeA],
      [attestedProfile, routeB],
      [historicalProfile, routeA]
    ];
    for (const surface of ['routebook-save', 'routebook-save', 'trip-open', 'trip-open']) {
      for (const [profile, routebook] of journeyPairs) {
        await recordJourneyEvent(baseUrl, profile, routebook, surface);
      }
    }
    await appendFile(join(dataDir, 'exposures.jsonl'), `${JSON.stringify({
      id: 'p0-legacy-journey-without-date',
      profileId: 'p0-legacy-profile',
      surface: 'routebook-save',
      itemType: 'journey-event',
      itemId: routeA.publicId,
      routeId: routeA.publicId,
      routeTitle: routeA.title,
      city: routeA.city,
      createdAt: new Date().toISOString()
    })}\n`, 'utf8');
    const editedRouteA = await saveRoute(baseUrl, {
      ...routeA,
      expectedVersion: routeA.version,
      travelDate: shanghaiDate(30),
      constraints: { ...routeA.constraints, date: shanghaiDate(30) }
    });
    assert.equal(editedRouteA.travelDate, shanghaiDate(30), 'route date edit should persist after journey events');
    const importAnalysis = await fetchJson(`${baseUrl}/api/import-guide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-routebook-token': PUBLIC_TOKEN },
      body: JSON.stringify({
        urls: ['http://127.0.0.1:1/private-source', 'http://[fe80::1]/private-source']
      })
    });
    assert.equal(importAnalysis.response.status, 200, JSON.stringify(importAnalysis.data));
    assert.equal(importAnalysis.data.sources?.every((source) => source.status === 'failed'), true);
    const dashboard = await fetchJson(`${baseUrl}/api/dashboard`, { headers: adminHeaders() });
    assert.equal(dashboard.response.status, 200, JSON.stringify(dashboard.data));
    const funnel = dashboard.data.dashboard?.funnel;
    assert.equal(funnel?.savedRoutebooks, 5, 'generic saves include the legacy profile-route event');
    assert.equal(funnel?.travelDateSavedRoutebooks, 4, 'date denominator must exclude legacy events without a frozen date');
    assert.equal(funnel?.savedAnyTripOpenedJourneys, 4, 'all saved journey keys were opened at some time');
    assert.equal(funnel?.savedTripOpenedJourneys, 3, 'historical opens must use their frozen date even after the route date is edited');
    assert.equal(funnel?.tripDayOpenRate, 75);
    assert.equal(funnel?.validCheckinJourneys, 2, 'in-window visited + valid GPS checkins from durable identities (owned or attested) qualify');
    assert.equal(funnel?.effectiveExecutedRoutebooks, 2, 'out-of-window, skipped/replaced and historical rows must not count as effective execution');
    assert.equal(funnel?.effectiveExecutionRate, 50);
    assert.equal(funnel?.checkinRate, 50);
    assert.equal(funnel?.travelDayCheckinRate, 66.7);
    assert.equal(funnel?.importAnalysisAttempts, 2);
    assert.equal(funnel?.importAnalysisSucceeded, 0);
    assert.equal(funnel?.importAnalysisFailed, 2);
    assert.equal(funnel?.importAnalysisSuccessRate, 0);
    assert.equal(funnel?.legacyJourneyEventsMissingTravelDate, 1);
    assert.equal(dashboard.data.dashboard?.metricDefinitions?.tripDayOpen?.timezone, 'Asia/Shanghai');
    assert.equal(dashboard.data.dashboard?.metricDefinitions?.tripDayOpen?.windowDaysBefore, 1);
    assert.equal(dashboard.data.dashboard?.metricDefinitions?.effectiveExecution?.timezone, 'Asia/Shanghai');
    assert.equal(dashboard.data.dashboard?.byCity?.every((item) => Object.hasOwn(item, 'avgPredictionScore') && !Object.hasOwn(item, 'avgTrust')), true);
    assert.equal(dashboard.data.dashboard?.topCreators?.every((item) => Object.hasOwn(item, 'avgPredictionScore') && !Object.hasOwn(item, 'avgTrust')), true);

    routeBAfterFeedback = await getRoute(baseUrl, routeB.publicId);
    assert.equal(stopByName(routeBAfterFeedback, '柳浪闻莺').poiTrust?.sampleCount, 2, 'one identity contributes at most one sample per POI across routes; the historical row stays outside the 30-day window');
    assert.equal(routeBAfterFeedback.trustMeta?.sampleCount, 1, 'route B should count its own verified identity sample');

    const routeLog = await readFile(join(dataDir, 'routebooks.jsonl'), 'utf8');
    for (const curatedId of CURATED_IDS) {
      assert.equal(routeLog.includes(`\"publicId\":\"${curatedId}\"`), false, `curated route ${curatedId} must not be persisted as a user draft`);
    }
    const exposureLog = await readFile(join(dataDir, 'exposures.jsonl'), 'utf8');
    assert.ok(exposureLog.includes(`\"routeId\":\"${CURATED_IDS[0]}\"`), 'curated copy should record an exposure event');
    const journeyRows = exposureLog.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.itemType === 'journey-event');
    assert.equal(journeyRows.filter((row) => row.id !== 'p0-legacy-journey-without-date').every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.travelDate)), true, 'new journey events must persist a travel-date snapshot');

    console.log(JSON.stringify({
      ok: true,
      curatedRoutes: CURATED_IDS.length,
      stablePoiId: stopA.poiId,
      crossRoutePoiSamples: stopByName(routeBAfterFeedback, '柳浪闻莺').poiTrust.sampleCount,
      routeBSamples: routeBAfterFeedback.trustMeta.sampleCount,
      identityStates: ['profile-owned', 'profile-attested'],
      effectiveExecutedRoutebooks: funnel.effectiveExecutedRoutebooks,
      concurrentCheckinRows: concurrentPersistedRows.length,
      requestIdVerified: true
    }));
  } catch (error) {
    if (output.length) error.message += `\nServer output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopChild(child);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

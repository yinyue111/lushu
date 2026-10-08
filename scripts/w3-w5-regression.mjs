import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticServerEnv } from './lib/hermetic-env.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ADMIN_TOKEN = 'w3-w5-admin-token';

async function findAvailablePort(startPort = 5699) {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', (/** @type {NodeJS.ErrnoException} */ error) => {
      if (error.code === 'EADDRINUSE') {
        resolve(findAvailablePort(startPort + 1));
        return;
      }
      reject(error);
    });
    server.listen(startPort, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(address.port));
    });
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function adminHeaders(json = false) {
  return {
    'x-routebook-admin-token': ADMIN_TOKEN,
    ...(json ? { 'content-type': 'application/json' } : {})
  };
}

function assertRequestId(result, label) {
  const requestId = result.response.headers.get('x-request-id');
  assert.ok(requestId, `${label} should include x-request-id`);
  assert.equal(result.data.requestId, requestId, `${label} should echo requestId in the body`);
}

function isoDay(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

async function waitForLive(baseUrl, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await fetchJson(`${baseUrl}/api/live`);
      if (result.response.ok && result.data.live) return;
      lastError = new Error(JSON.stringify(result.data));
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`W3-W5 regression server did not become live: ${lastError?.message ?? 'unknown error'}`);
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function approvedPoi({ poiId, city, name, lat, lng, validUntil }) {
  const evidenceId = `${poiId}-evidence`;
  return {
    poiId,
    city,
    name,
    location: { lat, lng, address: `${city}测试地址` },
    reviewStatus: 'approved',
    sourceType: 'official',
    evidence: [
      {
        id: evidenceId,
        type: 'web',
        sourceType: 'official',
        reviewStatus: 'approved',
        url: `https://example.com/${poiId}`,
        title: `${name}官方信息`,
        capturedAt: isoDay(0)
      }
    ],
    facts: [
      {
        id: `${poiId}-fact`,
        field: '开放时间',
        value: '09:00-17:00',
        sourceType: 'official',
        reviewStatus: 'approved',
        validFrom: isoDay(-90),
        validUntil,
        verifiedAt: isoDay(0),
        evidenceIds: [evidenceId]
      }
    ],
    audits: [
      {
        id: `${poiId}-review`,
        action: 'review',
        reviewStatus: 'approved',
        note: '隔离回归审核',
        createdAt: isoDay(0),
        actorType: 'admin'
      }
    ]
  };
}

function pendingPoi() {
  return {
    poiId: 'poi-test-pending-suzhou',
    city: '苏州',
    name: '苏州待审核测试点',
    location: { lat: 31.3, lng: 120.62 },
    reviewStatus: 'pending',
    sourceType: 'editorial',
    facts: [
      {
        id: 'poi-test-pending-suzhou-fact',
        field: '预约要求',
        value: '待运营复核',
        sourceType: 'editorial',
        reviewStatus: 'pending',
        validUntil: isoDay(20),
        evidenceIds: []
      }
    ],
    evidence: [],
    audits: []
  };
}

function concurrentApprovedPoi(index) {
  const poiId = 'poi-test-concurrent-hangzhou';
  const row = approvedPoi({
    poiId,
    city: '杭州',
    name: '杭州并发合并测试点',
    lat: 30.27,
    lng: 120.19,
    validUntil: isoDay(60)
  });
  const evidenceId = `${poiId}-evidence-${index}`;
  row.evidence[0] = {
    ...row.evidence[0],
    id: evidenceId,
    url: `https://example.com/${poiId}/${index}`
  };
  row.facts[0] = {
    ...row.facts[0],
    id: `${poiId}-fact-${index}`,
    field: `并发字段 ${index}`,
    value: `并发值 ${index}`,
    evidenceIds: [evidenceId]
  };
  return row;
}

function concurrentBaselinePoi() {
  return {
    poiId: 'poi-test-concurrent-hangzhou',
    city: '杭州',
    name: '杭州并发合并测试点',
    location: { lat: 30.27, lng: 120.19 },
    reviewStatus: 'pending',
    sourceType: 'editorial',
    facts: [],
    evidence: [],
    audits: []
  };
}

function routePayload(id, extra = {}) {
  return {
    id,
    publicId: id,
    city: '杭州',
    title: 'W3-W5 版本回归路书',
    summary: '隔离数据目录中的版本回归样本。',
    days: ['Day 1'],
    stops: [
      {
        id: `${id}-1`,
        day: 'Day 1',
        time: '09:00',
        name: '柳浪闻莺',
        area: '西湖',
        stay: '60 分钟',
        cost: '免费',
        verify: '回归验证',
        risk: '无',
        score: 82,
        lat: 30.242,
        lng: 120.1617
      },
      {
        id: `${id}-2`,
        day: 'Day 1',
        time: '11:00',
        name: '南宋御街',
        area: '上城',
        stay: '60 分钟',
        cost: '免费',
        verify: '回归验证',
        risk: '无',
        score: 80,
        lat: 30.2432,
        lng: 120.1696
      }
    ],
    ...extra
  };
}

async function lineCount(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'trusted-routebook-w3-w5-'));
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const poiLogPath = join(dataDir, 'pois.jsonl');
  const routebookLogPath = join(dataDir, 'routebooks.jsonl');
  const routebookAuditLogPath = join(dataDir, 'routebook-audits.jsonl');
  const exposureLogPath = join(dataDir, 'exposures.jsonl');
  const legacyRows = [
    { id: 'legacy-route', publicId: 'legacy-route', city: '杭州', title: '历史路书 v1', publishStatus: 'draft', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'legacy-route', publicId: 'legacy-route', city: '杭州', title: '历史路书 v2', publishStatus: 'published', updatedAt: '2026-01-02T00:00:00.000Z' }
  ];
  await writeFile(routebookLogPath, `${legacyRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const legacyAudits = [
    { id: 'legacy-audit-1', routebookId: 'legacy-route', event: 'created', version: 1, publishStatus: 'draft', createdAt: '2026-01-01T00:00:00.000Z' },
    {
      id: 'legacy-audit-2',
      routebookId: 'legacy-route',
      event: 'published',
      version: 2,
      parentVersion: 1,
      publishStatus: 'published',
      createdAt: '2026-01-02T00:00:00.000Z'
    }
  ];
  await writeFile(routebookAuditLogPath, `${legacyAudits.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const serverEnv = {
    ...hermeticServerEnv(),
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    ROUTEBOOK_DATA_DIR: dataDir,
    ROUTEBOOK_ADMIN_TOKEN: ADMIN_TOKEN,
    ROUTEBOOK_API_TOKEN: 'w3-w5-public-token',
    PROFILE_ID_SECRET: 'w3-w5-profile-secret',
    REQUIRE_LOCAL_ADMIN_TOKEN: 'true',
    ALLOW_LOCAL_ADMIN_BYPASS: 'false',
    ALLOW_LOCAL_API_BYPASS: 'true',
    RATE_LIMIT_MAX: '1000',
    CODEX_CONFIG_PATH: join(dataDir, 'missing-config.toml'),
    CODEX_AUTH_PATH: join(dataDir, 'missing-auth.json')
  };
  let logs = '';
  const startServer = () => {
    const childProcess = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    childProcess.stdout.on('data', (chunk) => {
      logs += chunk.toString();
    });
    childProcess.stderr.on('data', (chunk) => {
      logs += chunk.toString();
    });
    return childProcess;
  };
  let child = startServer();

  try {
    await waitForLive(baseUrl);

    const unauthorized = await fetchJson(`${baseUrl}/api/poi-coverage`);
    assert.equal(unauthorized.response.status, 403);
    assert.equal(unauthorized.data.code, 'ADMIN_TOKEN_REQUIRED');
    assertRequestId(unauthorized, 'admin protection');

    const emptyDashboard = await fetchJson(`${baseUrl}/api/dashboard`, { headers: adminHeaders() });
    assert.equal(emptyDashboard.response.status, 200);
    for (const metric of [
      'generationSuccessRate',
      'saveRate',
      'editRate',
      'tripDayOpenRate',
      'effectiveExecutionRate',
      'checkinRate',
      'travelDayCheckinRate',
      'shareRate',
      'importAnalysisSuccessRate',
      'clickThroughRate'
    ]) {
      assert.equal(emptyDashboard.data.dashboard.funnel[metric], null, `${metric} must be null when its denominator is zero`);
    }

    const initialCoverage = await fetchJson(`${baseUrl}/api/poi-coverage`, { headers: adminHeaders() });
    assert.equal(initialCoverage.response.status, 200);
    assert.equal(initialCoverage.data.totals.totalPois, 16);
    assert.equal(initialCoverage.data.totals.approvedPois, 0);
    assert.equal(initialCoverage.data.totals.evidenceBackedPois, 0);
    assert.equal(initialCoverage.data.totals.pendingReview, 16);
    assert.equal(initialCoverage.data.totals.verifiedCoveragePercent, 0);
    assert.equal(initialCoverage.data.totals.currentFactPercent, null);
    assert.deepEqual(
      initialCoverage.data.cities.map((item) => [item.city, item.totalPois]),
      [
        ['杭州', 10],
        ['上海', 3],
        ['苏州', 3]
      ]
    );

    const noWriteRow = approvedPoi({
      poiId: 'poi-test-no-write',
      city: '杭州',
      name: '杭州校验不写入测试点',
      lat: 30.25,
      lng: 120.17,
      validUntil: isoDay(60)
    });
    const validateNoWrite = await fetchJson(`${baseUrl}/api/pois/validate`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ content: JSON.stringify(noWriteRow) })
    });
    assert.equal(validateNoWrite.response.status, 200);
    assert.equal(validateNoWrite.data.canCommit, true);
    assert.equal(validateNoWrite.data.rows[0].status, 'new');
    assert.match(validateNoWrite.data.batchId, /^poi-batch-v2-[a-f0-9]{16}-[a-f0-9]{16}$/);
    assert.match(validateNoWrite.data.commitToken, /^poi-commit-v2\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    assert.match(validateNoWrite.data.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(await lineCount(poiLogPath), 0, 'validate must not create a POI log');

    const commitWithoutToken = await fetchJson(`${baseUrl}/api/pois/upsert`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ rows: validateNoWrite.data.rows.map((row) => row.normalized), batchId: validateNoWrite.data.batchId })
    });
    assert.equal(commitWithoutToken.response.status, 400);
    assert.equal(commitWithoutToken.data.code, 'COMMIT_TOKEN_REQUIRED');
    const forgedCommitToken = `${validateNoWrite.data.commitToken.slice(0, -1)}${validateNoWrite.data.commitToken.endsWith('0') ? '1' : '0'}`;
    const commitWithForgedToken = await fetchJson(`${baseUrl}/api/pois/upsert`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({
        rows: validateNoWrite.data.rows.map((row) => row.normalized),
        batchId: validateNoWrite.data.batchId,
        commitToken: forgedCommitToken
      })
    });
    assert.equal(commitWithForgedToken.response.status, 409);
    assert.equal(commitWithForgedToken.data.code, 'COMMIT_TOKEN_INVALID');
    assert.equal(await lineCount(poiLogPath), 0, 'missing or forged commit token must not write');

    const emptyShellEvidence = approvedPoi({
      poiId: 'poi-test-empty-shell-evidence',
      city: '杭州',
      name: '杭州空壳证据测试点',
      lat: 30.25,
      lng: 120.17,
      validUntil: isoDay(60)
    });
    delete emptyShellEvidence.evidence[0].url;
    delete emptyShellEvidence.evidence[0].capturedAt;
    const emptyShellValidation = await fetchJson(`${baseUrl}/api/pois/validate`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ rows: [emptyShellEvidence] })
    });
    assert.equal(emptyShellValidation.response.status, 200);
    assert.equal(emptyShellValidation.data.canCommit, false);
    const emptyShellErrorCodes = new Set(emptyShellValidation.data.rows[0].errors.map((error) => error.code));
    assert.ok(emptyShellErrorCodes.has('AUDITABLE_EVIDENCE_SOURCE_REQUIRED'));
    assert.ok(emptyShellErrorCodes.has('EVIDENCE_CAPTURED_AT_REQUIRED'));
    assert.equal(await lineCount(poiLogPath), 0, 'empty-shell approved evidence must not be persisted');

    const controlledDocumentEvidence = approvedPoi({
      poiId: 'poi-test-controlled-document',
      city: '杭州',
      name: '杭州受控文档证据测试点',
      lat: 30.25,
      lng: 120.17,
      validUntil: isoDay(60)
    });
    delete controlledDocumentEvidence.evidence[0].url;
    controlledDocumentEvidence.evidence[0].documentId = 'cms-poi-2026-0001';
    const controlledDocumentValidation = await fetchJson(`${baseUrl}/api/pois/validate`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ rows: [controlledDocumentEvidence] })
    });
    assert.equal(controlledDocumentValidation.response.status, 200);
    assert.equal(controlledDocumentValidation.data.canCommit, true, JSON.stringify(controlledDocumentValidation.data.rows));

    const malformedContent = [
      JSON.stringify({
        poiId: 'poi-test-invalid',
        city: '北京',
        name: '错误样本',
        location: { lat: 39.9, lng: 116.4 },
        reviewStatus: 'verified',
        evidence: [{ id: 'bad-evidence', type: 'web', url: 'javascript:alert(1)', reviewStatus: 'approved' }],
        facts: [{ field: '开放时间', value: '未知', reviewStatus: 'approved', validUntil: 'not-a-date', evidenceIds: ['missing-evidence'] }]
      }),
      '{bad-json'
    ].join('\n');
    const malformed = await fetchJson(`${baseUrl}/api/pois/validate`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ content: malformedContent })
    });
    assert.equal(malformed.response.status, 200);
    assert.equal(malformed.data.canCommit, false);
    assert.equal(malformed.data.summary.error, 2);
    const errorCodes = new Set(malformed.data.rows.flatMap((row) => row.errors.map((error) => error.code)));
    for (const code of [
      'UNSUPPORTED_OPERATIONAL_CITY',
      'INVALID_POI_STATUS',
      'INVALID_HTTP_URL',
      'INVALID_DATE',
      'UNKNOWN_EVIDENCE_REFERENCE',
      'INVALID_JSON'
    ]) {
      assert.ok(errorCodes.has(code), `missing stable validation code ${code}`);
    }
    assert.equal(await lineCount(poiLogPath), 0);

    const strictCommit = await fetchJson(`${baseUrl}/api/pois/upsert`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ content: malformedContent, batchId: malformed.data.batchId, commitToken: malformed.data.commitToken })
    });
    assert.equal(strictCommit.response.status, 400);
    assert.equal(strictCommit.data.code, 'POI_BATCH_INVALID');
    assert.equal(await lineCount(poiLogPath), 0, 'invalid batch must not partially write');

    const rows = [
      approvedPoi({
        poiId: 'poi-test-fresh-hangzhou',
        city: '杭州',
        name: '杭州新鲜事实测试点',
        lat: 30.26,
        lng: 120.18,
        validUntil: isoDay(60)
      }),
      approvedPoi({
        poiId: 'poi-test-stale-shanghai',
        city: '上海',
        name: '上海过期事实测试点',
        lat: 31.23,
        lng: 121.47,
        validUntil: isoDay(-2)
      }),
      pendingPoi()
    ];
    const validation = await fetchJson(`${baseUrl}/api/pois/validate`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ rows })
    });
    assert.equal(validation.response.status, 200);
    assert.equal(validation.data.canCommit, true, JSON.stringify(validation.data.rows));
    assert.deepEqual(
      validation.data.rows.map((row) => row.status),
      ['new', 'new', 'new']
    );

    const committed = await fetchJson(`${baseUrl}/api/pois/upsert`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({
        rows: validation.data.rows.map((row) => row.normalized),
        batchId: validation.data.batchId,
        commitToken: validation.data.commitToken
      })
    });
    assert.equal(committed.response.status, 200);
    assert.equal(committed.data.replayed, false);
    assert.equal(await lineCount(poiLogPath), 1, 'one batch must be one JSONL append');

    const replayed = await fetchJson(`${baseUrl}/api/pois/upsert`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({
        rows: validation.data.rows.map((row) => row.normalized),
        batchId: validation.data.batchId,
        commitToken: validation.data.commitToken
      })
    });
    assert.equal(replayed.response.status, 200);
    assert.equal(replayed.data.replayed, true);
    assert.equal(await lineCount(poiLogPath), 1, 'batch replay must not append duplicate facts/evidence/audits');

    const freshFilter = await fetchJson(`${baseUrl}/api/pois?freshnessState=fresh`, { headers: adminHeaders() });
    assert.equal(freshFilter.response.status, 200);
    assert.equal(freshFilter.data.total, 1);
    assert.equal(freshFilter.data.pois[0].poiId, 'poi-test-fresh-hangzhou');
    assert.equal(freshFilter.data.pois[0].trustState, 'verified');

    const pendingSuzhou = await fetchJson(`${baseUrl}/api/pois?city=苏州&reviewStatus=pending`, { headers: adminHeaders() });
    assert.equal(pendingSuzhou.response.status, 200);
    assert.equal(pendingSuzhou.data.total, 4, 'three honest seeds plus one operational pending row');
    assert.ok(pendingSuzhou.data.pois.every((poi) => poi.reviewStatus === 'pending'));

    const coverage = await fetchJson(`${baseUrl}/api/poi-coverage`, { headers: adminHeaders() });
    assert.equal(coverage.response.status, 200);
    assert.equal(coverage.data.totals.totalPois, 19);
    assert.equal(coverage.data.totals.approvedPois, 2);
    assert.equal(coverage.data.totals.evidenceBackedPois, 2);
    assert.equal(coverage.data.totals.verifiedPois, 1);
    assert.equal(coverage.data.totals.freshFacts, 1);
    assert.equal(coverage.data.totals.staleFacts, 1);
    assert.equal(coverage.data.totals.pendingFacts, 1);
    assert.equal(coverage.data.totals.trustStates.verified, 1);
    assert.equal(coverage.data.totals.trustStates.stale, 1);
    assert.equal(coverage.data.totals.pendingReview, 17);

    const restartRow = approvedPoi({
      poiId: 'poi-test-restart-token',
      city: '杭州',
      name: '杭州跨重启令牌测试点',
      lat: 30.29,
      lng: 120.21,
      validUntil: isoDay(60)
    });
    const restartValidation = await fetchJson(`${baseUrl}/api/pois/validate`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ rows: [restartRow] })
    });
    assert.equal(restartValidation.data.canCommit, true);
    await stopServer(child);
    child = startServer();
    await waitForLive(baseUrl);
    const restartCommit = await fetchJson(`${baseUrl}/api/pois/upsert`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({
        rows: restartValidation.data.rows.map((row) => row.normalized),
        batchId: restartValidation.data.batchId,
        commitToken: restartValidation.data.commitToken
      })
    });
    assert.equal(restartCommit.response.status, 200, JSON.stringify(restartCommit.data));
    assert.equal(restartCommit.data.replayed, false);

    const staleWinnerRow = approvedPoi({
      poiId: 'poi-test-stale-write-guard',
      city: '杭州',
      name: '杭州过期写入保护测试点',
      lat: 30.28,
      lng: 120.2,
      validUntil: isoDay(60)
    });
    staleWinnerRow.facts[0].value = '赢家事实值';
    const staleLoserRow = structuredClone(staleWinnerRow);
    staleLoserRow.facts[0].value = '过期批次事实值';
    const [staleWinnerValidation, staleLoserValidation] = await Promise.all(
      [staleWinnerRow, staleLoserRow].map((row) =>
        fetchJson(`${baseUrl}/api/pois/validate`, {
          method: 'POST',
          headers: adminHeaders(true),
          body: JSON.stringify({ rows: [row] })
        })
      )
    );
    assert.ok(staleWinnerValidation.data.canCommit && staleLoserValidation.data.canCommit);
    const staleWinnerCommit = await fetchJson(`${baseUrl}/api/pois/upsert`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({
        rows: staleWinnerValidation.data.rows.map((row) => row.normalized),
        batchId: staleWinnerValidation.data.batchId,
        commitToken: staleWinnerValidation.data.commitToken
      })
    });
    assert.equal(staleWinnerCommit.response.status, 200);
    const poiLinesBeforeStaleCommit = await lineCount(poiLogPath);
    const staleCommit = await fetchJson(`${baseUrl}/api/pois/upsert`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({
        rows: staleLoserValidation.data.rows.map((row) => row.normalized),
        batchId: staleLoserValidation.data.batchId,
        commitToken: staleLoserValidation.data.commitToken
      })
    });
    assert.equal(staleCommit.response.status, 409);
    assert.equal(staleCommit.data.code, 'POI_BATCH_STALE');
    assert.equal(await lineCount(poiLogPath), poiLinesBeforeStaleCommit, 'stale batch must not append a POI envelope');
    const staleGuardList = await fetchJson(`${baseUrl}/api/pois?city=${encodeURIComponent('杭州')}`, { headers: adminHeaders() });
    const staleGuardPoi = staleGuardList.data.pois.find((poi) => poi.poiId === 'poi-test-stale-write-guard');
    assert.equal(staleGuardPoi.facts.find((fact) => fact.id === staleWinnerRow.facts[0].id)?.value, '赢家事实值');

    const concurrentBaselineValidation = await fetchJson(`${baseUrl}/api/pois/validate`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ rows: [concurrentBaselinePoi()] })
    });
    assert.equal(concurrentBaselineValidation.data.canCommit, true, JSON.stringify(concurrentBaselineValidation.data.rows));
    const concurrentBaselineCommit = await fetchJson(`${baseUrl}/api/pois/upsert`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({
        rows: concurrentBaselineValidation.data.rows.map((row) => row.normalized),
        batchId: concurrentBaselineValidation.data.batchId,
        commitToken: concurrentBaselineValidation.data.commitToken
      })
    });
    assert.equal(concurrentBaselineCommit.response.status, 200);

    const concurrentValidations = await Promise.all(
      [1, 2].map(async (index) => {
        const result = await fetchJson(`${baseUrl}/api/pois/validate`, {
          method: 'POST',
          headers: adminHeaders(true),
          body: JSON.stringify({ rows: [concurrentApprovedPoi(index)] })
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.data.canCommit, true, JSON.stringify(result.data.rows));
        return result.data;
      })
    );
    assert.notEqual(concurrentValidations[0].batchId, concurrentValidations[1].batchId);
    const concurrentCommits = await Promise.all(
      concurrentValidations.map((batch) =>
        fetchJson(`${baseUrl}/api/pois/upsert`, {
          method: 'POST',
          headers: adminHeaders(true),
          body: JSON.stringify({ rows: batch.rows.map((row) => row.normalized), batchId: batch.batchId, commitToken: batch.commitToken })
        })
      )
    );
    assert.ok(
      concurrentCommits.every((result) => result.response.status === 200),
      JSON.stringify(concurrentCommits.map((result) => result.data))
    );
    const concurrentPoiList = await fetchJson(`${baseUrl}/api/pois?city=${encodeURIComponent('杭州')}`, { headers: adminHeaders() });
    const concurrentPoi = concurrentPoiList.data.pois.find((poi) => poi.poiId === 'poi-test-concurrent-hangzhou');
    assert.ok(concurrentPoi, 'concurrently committed POI must exist');
    assert.deepEqual(concurrentPoi.facts.map((fact) => fact.id).sort(), ['poi-test-concurrent-hangzhou-fact-1', 'poi-test-concurrent-hangzhou-fact-2']);
    assert.deepEqual(concurrentPoi.evidence.map((evidence) => evidence.id).sort(), [
      'poi-test-concurrent-hangzhou-evidence-1',
      'poi-test-concurrent-hangzhou-evidence-2'
    ]);

    const legacyUnauthorized = await fetchJson(`${baseUrl}/api/routebooks/legacy-route/versions`);
    assert.equal(legacyUnauthorized.response.status, 403);
    const legacyHistory = await fetchJson(`${baseUrl}/api/routebooks/legacy-route/versions`, { headers: adminHeaders() });
    assert.equal(legacyHistory.response.status, 200);
    assert.deepEqual(
      legacyHistory.data.versions.map((row) => row.version),
      [1, 2]
    );
    assert.ok(legacyHistory.data.versions.every((row) => row.derived));
    assert.deepEqual(
      legacyHistory.data.audits.map((row) => row.event),
      ['created', 'published']
    );

    await rm(routebookAuditLogPath, { force: true });
    await mkdir(routebookAuditLogPath);
    assert.equal((await stat(routebookAuditLogPath)).isDirectory(), true, 'legacy audit sink must be unavailable for writes');

    const routebookLinesBeforeInvalidCreate = await lineCount(routebookLogPath);
    const invalidCreateVersion = await fetchJson(`${baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(routePayload('w3-w5-version-route', { expectedVersion: 1 }))
    });
    assert.equal(invalidCreateVersion.response.status, 409);
    assert.equal(invalidCreateVersion.data.code, 'VERSION_CONFLICT');
    assert.equal(invalidCreateVersion.data.currentVersion, 0);
    assert.equal(await lineCount(routebookLogPath), routebookLinesBeforeInvalidCreate, 'failed create must not append a routebook');

    const created = await fetchJson(`${baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(routePayload('w3-w5-version-route'))
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.data.routebook.version, 1);
    assert.equal(created.data.routebook.schemaVersion, 2);
    const editToken = created.data.routebook.editToken;
    assert.ok(editToken);

    const routebookLinesBeforeMissingSaveVersion = await lineCount(routebookLogPath);
    const missingSaveVersion = await fetchJson(`${baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(routePayload('w3-w5-version-route', { editToken, title: '不应写入的缺版本保存' }))
    });
    assert.equal(missingSaveVersion.response.status, 409);
    assert.equal(missingSaveVersion.data.code, 'EXPECTED_VERSION_REQUIRED');
    assert.equal(missingSaveVersion.data.currentVersion, 1);
    assert.equal(await lineCount(routebookLogPath), routebookLinesBeforeMissingSaveVersion);

    const saved = await fetchJson(`${baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        routePayload('w3-w5-version-route', {
          title: 'W3-W5 版本回归路书已编辑',
          editToken,
          expectedVersion: 1,
          editReason: '修改标题'
        })
      )
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.data.routebook.version, 2);
    assert.equal(saved.data.routebook.parentVersion, 1);

    const conflict = await fetchJson(`${baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        routePayload('w3-w5-version-route', {
          editToken,
          expectedVersion: 1
        })
      )
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.data.code, 'VERSION_CONFLICT');
    assert.equal(conflict.data.currentVersion, 2);
    assertRequestId(conflict, 'version conflict');

    const routebookLinesBeforeMissingVariantVersion = await lineCount(routebookLogPath);
    const missingVariantVersion = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/variants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        editToken,
        variant: {
          id: 'w3-w5-missing-version-variant',
          mode: '雨天',
          stops: routePayload('w3-w5-version-route').stops
        }
      })
    });
    assert.equal(missingVariantVersion.response.status, 409);
    assert.equal(missingVariantVersion.data.code, 'EXPECTED_VERSION_REQUIRED');
    assert.equal(missingVariantVersion.data.currentVersion, 2);
    assert.equal(await lineCount(routebookLogPath), routebookLinesBeforeMissingVariantVersion);

    const variant = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/variants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        editToken,
        expectedVersion: 2,
        variant: {
          id: 'w3-w5-variant',
          mode: '少走路',
          summary: '隔离回归路线变体',
          days: ['Day 1'],
          stops: routePayload('w3-w5-version-route').stops
        }
      })
    });
    assert.equal(variant.response.status, 200);
    assert.equal(variant.data.routebook.version, 3);

    const routebookLinesBeforeMissingPublishVersion = await lineCount(routebookLogPath);
    const missingPublishVersion = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editToken })
    });
    assert.equal(missingPublishVersion.response.status, 409);
    assert.equal(missingPublishVersion.data.code, 'EXPECTED_VERSION_REQUIRED');
    assert.equal(missingPublishVersion.data.currentVersion, 3);
    assert.equal(await lineCount(routebookLogPath), routebookLinesBeforeMissingPublishVersion);

    const published = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editToken, expectedVersion: 3 })
    });
    assert.equal(published.response.status, 200);
    assert.equal(published.data.routebook.version, 4);
    assert.equal(published.data.routebook.publishStatus, 'published');
    assert.ok(published.data.routebook.publishedAt);

    const routebookLinesBeforeCopies = await lineCount(routebookLogPath);
    const exposureLinesBeforeCopies = await lineCount(exposureLogPath);
    const firstCopy = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'w3-w5-copy-actor-1' })
    });
    assert.equal(firstCopy.response.status, 200);
    assert.equal(firstCopy.data.copyCount, 1);
    assert.equal(firstCopy.data.routebook.copyCount, 1);
    assert.equal(await lineCount(exposureLogPath), exposureLinesBeforeCopies + 1);
    const repeatedCopy = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'w3-w5-copy-actor-1' })
    });
    assert.equal(repeatedCopy.response.status, 200);
    assert.equal(repeatedCopy.data.copyCount, 1);
    assert.equal(await lineCount(exposureLogPath), exposureLinesBeforeCopies + 1, 'same actor copy must be idempotent');
    const secondActorCopy = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'w3-w5-copy-actor-2' })
    });
    assert.equal(secondActorCopy.response.status, 200);
    assert.equal(secondActorCopy.data.copyCount, 2);
    assert.equal(await lineCount(exposureLogPath), exposureLinesBeforeCopies + 2);
    assert.equal(await lineCount(routebookLogPath), routebookLinesBeforeCopies, 'copy must not append a same-version routebook snapshot');
    const historyAfterCopies = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/versions`, { headers: adminHeaders() });
    assert.equal(historyAfterCopies.data.currentVersion, 4);
    assert.equal(historyAfterCopies.data.audits.length, 4);

    const routebookLinesBeforeMissingStatusVersion = await lineCount(routebookLogPath);
    const missingStatusVersion = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/status`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ publishStatus: 'archived' })
    });
    assert.equal(missingStatusVersion.response.status, 409);
    assert.equal(missingStatusVersion.data.code, 'EXPECTED_VERSION_REQUIRED');
    assert.equal(missingStatusVersion.data.currentVersion, 4);
    assert.equal(await lineCount(routebookLogPath), routebookLinesBeforeMissingStatusVersion);

    const archived = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/status`, {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ publishStatus: 'archived', expectedVersion: 4, changeReason: '回归归档' })
    });
    assert.equal(archived.response.status, 200);
    assert.equal(archived.data.routebook.version, 5);
    assert.equal(archived.data.routebook.parentVersion, 4);
    assert.ok(archived.data.routebook.archivedAt);

    const history = await fetchJson(`${baseUrl}/api/routebooks/w3-w5-version-route/versions`, { headers: adminHeaders() });
    assert.equal(history.response.status, 200);
    assert.equal(history.data.currentVersion, 5);
    assert.deepEqual(
      history.data.versions.map((row) => row.version),
      [1, 2, 3, 4, 5]
    );
    assert.equal(history.data.audits.length, 5);
    assert.deepEqual(
      history.data.audits.map((row) => row.event),
      ['created', 'draft-saved', 'variant-saved', 'published', 'status-changed']
    );
    const routebookSnapshots = (await readFile(routebookLogPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.publicId === 'w3-w5-version-route');
    assert.equal(routebookSnapshots.length, 5);
    assert.ok(
      routebookSnapshots.every((row) => row.versionAudit?.version === row.version),
      'every version snapshot must carry its audit in the same JSONL record'
    );
    assert.deepEqual(
      routebookSnapshots.map((row) => row.versionAudit.event),
      ['created', 'draft-saved', 'variant-saved', 'published', 'status-changed']
    );
    assert.equal((await stat(routebookAuditLogPath)).isDirectory(), true, 'new mutations must not depend on the legacy audit sink');

    await access(poiLogPath);
    console.log(
      JSON.stringify(
        {
          ok: true,
          isolatedDataDir: dataDir,
          seedPois: initialCoverage.data.totals.totalPois,
          committedPois: committed.data.summary.total,
          poiLogLines: await lineCount(poiLogPath),
          coverage: {
            totalPois: coverage.data.totals.totalPois,
            verifiedPois: coverage.data.totals.verifiedPois,
            staleFacts: coverage.data.totals.staleFacts,
            pendingReview: coverage.data.totals.pendingReview
          },
          routebookVersion: history.data.currentVersion,
          routebookAuditEvents: history.data.audits.length,
          embeddedRoutebookAuditEvents: routebookSnapshots.length,
          concurrentPoiFacts: concurrentPoi.facts.length
        },
        null,
        2
      )
    );
  } finally {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
    if (child.exitCode && child.exitCode !== 0) {
      console.error(logs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

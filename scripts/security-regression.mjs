import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticServerEnv } from './lib/hermetic-env.mjs';

const PORT = Number(process.env.SECURITY_TEST_PORT ?? 5199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'security-regression-admin';
const PUBLIC_TOKEN = 'security-regression-public';
const IDENTITY_ASSERTION_SECRET = 'security-regression-identity-secret';

function fetchJson(url, options = {}) {
  return fetch(url, options).then(async (response) => ({
    response,
    data: await response.json().catch(() => ({}))
  }));
}

function shanghaiDate() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function waitForHealth(baseUrl = BASE_URL, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const { response } = await fetchJson(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Security test server did not become ready');
}

function assertSecurityHeaders(response, { csp, label }) {
  const nosniff = response.headers.get('x-content-type-options');
  const frameOptions = response.headers.get('x-frame-options');
  const referrerPolicy = response.headers.get('referrer-policy');
  const contentSecurityPolicy = response.headers.get('content-security-policy');
  if (nosniff !== 'nosniff') {
    throw new Error(`${label} should set x-content-type-options=nosniff, got ${nosniff}`);
  }
  if (frameOptions !== 'DENY') {
    throw new Error(`${label} should set x-frame-options=DENY, got ${frameOptions}`);
  }
  if (!referrerPolicy) {
    throw new Error(`${label} should set referrer-policy`);
  }
  if (csp && !contentSecurityPolicy?.includes("default-src 'self'")) {
    throw new Error(`${label} should set content-security-policy, got ${contentSecurityPolicy}`);
  }
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'routebook-security-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...hermeticServerEnv(),
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ROUTEBOOK_DATA_DIR: dataDir,
	      RATE_LIMIT_MAX: '420',
      // rank9 分桶后核心写（routebooks/checkins 等）默认 24/分；本脚本的
      // 「列表唯一性」用例要对同一路书连续 205 次编辑（压测型用例），与原
      // RATE_LIMIT_MAX 同步放宽核心写配额，不改变限流断言语义。
      RATE_LIMIT_CORE_WRITE_MAX: '420',
      RATE_LIMIT_WINDOW_MS: '60000',
      REQUIRE_LOCAL_ADMIN_TOKEN: 'true',
	      ROUTEBOOK_ADMIN_TOKEN: ADMIN_TOKEN,
	      PROFILE_ID_SECRET: 'security-regression-profile-secret',
	      PROFILE_IDENTITY_ASSERTION_SECRET: IDENTITY_ASSERTION_SECRET,
	      ALLOW_PUBLIC_MODEL_PROXY: 'true',
      ROUTEBOOK_API_TOKEN: PUBLIC_TOKEN,
      TRUST_PROXY_HEADERS: 'true',
      IMPORT_TIMEOUT_MS: '3000',
      VITE_HMR_PORT: '24799'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
	  const stderr = [];
	  let originalProducts = null;
	  const targetFailures = [];
	  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    await waitForHealth();
    const healthHeaders = await fetch(`${BASE_URL}/api/health`);
    assertSecurityHeaders(healthHeaders, { csp: false, label: 'API health' });
    const localLogsDenied = await fetchJson(`${BASE_URL}/api/logs`);
    if (localLogsDenied.response.status !== 403) {
      throw new Error(`Local sensitive reads should require admin token when REQUIRE_LOCAL_ADMIN_TOKEN=true, got HTTP ${localLogsDenied.response.status}`);
    }
    const indexHeaders = await fetch(`${BASE_URL}/`);
    assertSecurityHeaders(indexHeaders, { csp: true, label: 'static index' });
    const csp = indexHeaders.headers.get('content-security-policy') ?? '';
    if (csp.includes('https://images.unsplash.com')) {
      throw new Error(`Static CSP should not allow removed Unsplash assets, got ${csp}`);
    }
	    if (/127\.0\.0\.1:\*|ws:\/\/127\.0\.0\.1:\*/.test(csp)) {
	      throw new Error(`Production CSP should not allow localhost or ws connect-src, got ${csp}`);
	    }
	    const missingAsset = await fetch(`${BASE_URL}/assets/not-found.js`);
	    recordTargetFailure(
	      targetFailures,
	      missingAsset.status === 404 && !String(missingAsset.headers.get('content-type') ?? '').includes('text/html'),
	      `[SR-07] Missing asset should return HTTP 404 instead of the SPA index, got HTTP ${missingAsset.status} (${missingAsset.headers.get('content-type')})`
	    );
	    originalProducts = await fetchJson(`${BASE_URL}/api/products`);
    if (!originalProducts.response.ok) {
      throw new Error(`Product config preflight failed: ${JSON.stringify(originalProducts.data)}`);
    }

    const productBody = {
      products: [{ title: '安全回归商品', poi: '西湖', city: '杭州', url: 'https://example.com/product' }]
    };
    const denied = await fetchJson(`${BASE_URL}/api/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(productBody)
    });
    if (denied.response.status !== 403) {
      throw new Error(`Admin write without token should be denied, got HTTP ${denied.response.status}`);
    }
    const allowed = await fetchJson(`${BASE_URL}/api/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-routebook-admin-token': ADMIN_TOKEN },
      body: JSON.stringify(productBody)
    });
    if (!allowed.response.ok || allowed.data.products?.[0]?.url !== productBody.products[0].url) {
      throw new Error(`Admin write with token failed: ${JSON.stringify(allowed.data)}`);
    }

    const unsafeProduct = await fetchJson(`${BASE_URL}/api/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-routebook-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ products: [{ title: '坏链接商品', poi: '西湖', city: '杭州', url: 'javascript:alert(1)' }] })
    });
    if (unsafeProduct.response.status !== 400) {
      throw new Error(`Unsafe product URL should be rejected, got HTTP ${unsafeProduct.response.status}`);
    }

    const template = {
      city: '杭州',
      title: '安全回归路书',
      summary: '用于验证草稿、发布和归档的公开边界。',
      profileId: 'security-owner',
      constraints: { date: shanghaiDate(), base: '西湖边私有住宿', budget: '人均 900' },
      importedSources: [{ url: 'https://example.com/private-guide', platform: '小红书', excerpt: '私有攻略摘要' }],
      logs: [{ stage: '私有生成日志', input: '用户输入', result: '内部结果', status: '通过' }],
      provider: { name: 'security-provider', model: 'private-model', baseUrl: 'https://private-provider.example.com' },
      stops: [
	        { id: 'a', day: 'Day 1', time: '09:00', name: '柳浪闻莺', area: '西湖', lat: 30.242, lng: 120.1617, score: 80 },
        { id: 'b', day: 'Day 1', time: '11:00', name: '灵隐寺', area: '西湖', lat: 30.24, lng: 120.102, score: 82, geoConfidence: 45 }
      ],
      days: ['Day 1']
    };
    const saved = await fetchJson(`${BASE_URL}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(template)
    });
    if (!saved.response.ok || !saved.data.routebook?.publicId) {
      throw new Error(`Routebook draft save failed: ${JSON.stringify(saved.data)}`);
    }
    const routeId = saved.data.routebook.publicId;
    const ownerEditToken = saved.data.routebook.editToken;
    if (!ownerEditToken) {
      throw new Error(`Routebook draft save should return an owner edit token on local API: ${JSON.stringify(saved.data.routebook)}`);
    }
    const lowGeoStop = saved.data.routebook.stops.find((stop) => stop.geoConfidence < 60);
    if (!lowGeoStop?.navigationDisabled) {
      throw new Error(`Low-confidence coordinates should disable navigation: ${JSON.stringify(saved.data.routebook.stops)}`);
    }
	    const unverifiedProfile = await fetchJson(`${BASE_URL}/api/profile`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        profileId: 'local-profile-to-bind',
	        phone: '13800000000',
	        homeCity: '杭州'
	      })
	    });
	    if (!unverifiedProfile.response.ok || unverifiedProfile.data.profile?.id === 'local-profile-to-bind' || unverifiedProfile.data.profile?.previousLocalId !== 'local-profile-to-bind' || unverifiedProfile.data.profile?.identityBound || !unverifiedProfile.data.profile?.identityBindingRequired || !unverifiedProfile.data.profile?.profileAccessToken) {
	      throw new Error(`Bare phone/openid should not bind a stable identity: ${JSON.stringify(unverifiedProfile.data)}`);
	    }
    const arbitraryProfileClaim = await fetchJson(`${BASE_URL}/api/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'security-owner', homeCity: '杭州' })
    });
    if (!arbitraryProfileClaim.response.ok || arbitraryProfileClaim.data.profile?.id === 'security-owner' || arbitraryProfileClaim.data.profile?.previousLocalId !== 'security-owner') {
      throw new Error(`Arbitrary profileId should be migrated to a server-issued id, not tokenized in place: ${JSON.stringify(arbitraryProfileClaim.data)}`);
    }
    const claimedOwnerRead = await fetchJson(`${BASE_URL}/api/routebooks?profileId=security-owner`, {
      headers: {
        'x-routebook-profile-id': arbitraryProfileClaim.data.profile.id,
        'x-routebook-profile-token': arbitraryProfileClaim.data.profile.profileAccessToken
      }
    });
    if (claimedOwnerRead.response.status !== 403) {
      throw new Error(`Server-issued token for migrated local profile should not read arbitrary previousLocalId assets, got HTTP ${claimedOwnerRead.response.status}`);
    }
	    const verifiedIdentity = createIdentityProof('phone', '13800000000');
	    const boundProfile = await fetchJson(`${BASE_URL}/api/profile`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        profileId: 'local-profile-to-bind',
	        identity: verifiedIdentity,
	        homeCity: '杭州'
	      })
	    });
	    if (!boundProfile.response.ok || boundProfile.data.profile?.id === 'local-profile-to-bind' || !boundProfile.data.profile?.identityBound) {
	      throw new Error(`Verified identity assertion should replace local profileId: ${JSON.stringify(boundProfile.data)}`);
	    }
    if (!boundProfile.data.profile?.profileAccessToken) {
      throw new Error(`Profile binding should return owner read token: ${JSON.stringify(boundProfile.data)}`);
    }
	    const boundDraft = await fetchJson(`${BASE_URL}/api/routebooks`, {
	      method: 'POST',
	      headers: profileHeaders(boundProfile.data.profile),
      body: JSON.stringify({
        ...template,
        title: '已绑定用户私有草稿',
        profileId: boundProfile.data.profile.id,
        constraints: { date: '2026-07-20', base: '西湖边某酒店' },
        importedSources: [{ url: 'https://example.com/private-guide', platform: 'xhs' }]
      })
    });
    if (!boundDraft.response.ok || !boundDraft.data.routebook?.publicId) {
      throw new Error(`Bound profile draft should save: ${JSON.stringify(boundDraft.data)}`);
    }
    const boundDraftId = boundDraft.data.routebook.publicId;
    const boundDraftDenied = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(boundDraftId)}`, {
      headers: { 'x-forwarded-for': '203.0.113.201' }
    });
    if (boundDraftDenied.response.status !== 404) {
      throw new Error(`Private bound draft should be hidden without owner token, got HTTP ${boundDraftDenied.response.status}`);
    }
    const boundDraftOwnerRead = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(boundDraftId)}`, {
      headers: {
        'x-routebook-profile-id': boundProfile.data.profile.id,
        'x-routebook-profile-token': boundProfile.data.profile.profileAccessToken,
        'x-forwarded-for': '203.0.113.201'
      }
    });
    if (!boundDraftOwnerRead.response.ok || !boundDraftOwnerRead.data.routebook?.editToken || boundDraftOwnerRead.data.routebook?.constraints?.base !== '西湖边某酒店') {
      throw new Error(`Owner token should read full private draft: ${JSON.stringify(boundDraftOwnerRead.data)}`);
    }
    const ownerScopedRead = await fetchJson(`${BASE_URL}/api/checkins?profileId=${encodeURIComponent(boundProfile.data.profile.id)}`, {
      headers: {
        'x-routebook-profile-id': boundProfile.data.profile.id,
        'x-routebook-profile-token': boundProfile.data.profile.profileAccessToken
      }
    });
    if (!ownerScopedRead.response.ok) {
      throw new Error(`Profile owner token should allow scoped reads: ${JSON.stringify(ownerScopedRead.data)}`);
    }
	    const hijackedProfile = await fetchJson(`${BASE_URL}/api/profile`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        phone: '13800000000',
	        homeCity: '上海'
	      })
	    });
	    if (!hijackedProfile.response.ok || hijackedProfile.data.profile?.id === boundProfile.data.profile.id || hijackedProfile.data.profile?.identityBound) {
	      throw new Error(`Bare phone should not recover or reset an existing stable profile: ${JSON.stringify(hijackedProfile.data)}`);
	    }
    const tokenProfileUpdate = await fetchJson(`${BASE_URL}/api/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: boundProfile.data.profile.id,
        profileAccessToken: boundProfile.data.profile.profileAccessToken,
        homeCity: '上海',
        preferredCities: ['上海', '苏州'],
        budget: '人均 1600',
        themes: ['建筑', 'Citywalk'],
        creatorName: '跨设备测试用户'
      })
    });
		    if (!tokenProfileUpdate.response.ok || tokenProfileUpdate.data.profile?.id !== boundProfile.data.profile.id || !tokenProfileUpdate.data.profile?.identityBound || tokenProfileUpdate.data.profile?.creatorName !== '跨设备测试用户') {
		      throw new Error(`Existing stable profile should update with current token: ${JSON.stringify(tokenProfileUpdate.data)}`);
		    }
		    const recoveredProfile = await fetchJson(`${BASE_URL}/api/profile`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({
		        id: boundProfile.data.profile.id,
		        profileAccessToken: boundProfile.data.profile.profileAccessToken
		      })
		    });
		    if (!recoveredProfile.response.ok || recoveredProfile.data.profile?.homeCity !== '上海' || recoveredProfile.data.profile?.budget !== '人均 1600' || recoveredProfile.data.profile?.creatorName !== '跨设备测试用户' || !recoveredProfile.data.profile?.preferredCities?.includes('苏州') || !recoveredProfile.data.profile?.themes?.includes('建筑') || !recoveredProfile.data.profile?.identityBound) {
		      throw new Error(`Token-only profile recovery should preserve stored preferences and identity: ${JSON.stringify(recoveredProfile.data)}`);
		    }
		    const wrongRecoveryToken = await fetchJson(`${BASE_URL}/api/profile`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({
		        id: boundProfile.data.profile.id,
		        profileAccessToken: 'invalid-profile-token-123456'
		      })
		    });
		    if (wrongRecoveryToken.response.status !== 403) {
		      throw new Error(`Profile recovery with the wrong token should be denied, got HTTP ${wrongRecoveryToken.response.status}`);
		    }
	    const secondBoundProfile = await createVerifiedProfile(BASE_URL, {
	      localProfileId: 'security-profile-two',
	      subject: '13800000001'
	    });
	    const thirdBoundProfile = await createVerifiedProfile(BASE_URL, {
	      localProfileId: 'security-profile-three',
	      subject: '13800000002'
	    });

	    const farCoordinateRoute = await fetchJson(`${BASE_URL}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...template,
        title: '坐标安全回归路书',
        profileId: 'coordinate-owner',
        stops: [
          { id: 'nyc', day: 'Day 1', time: '09:00', name: '杭州错误纽约坐标', area: '西湖', lat: 40.7128, lng: -74.006, score: 95, geoConfidence: 95 },
          { id: 'fallback', day: 'Day 1', time: '11:00', name: '缺失坐标点', area: '西湖', score: 80 }
        ]
      })
    });
    const farStop = farCoordinateRoute.data.routebook?.stops?.find((stop) => stop.id === 'nyc');
    const fallbackStop = farCoordinateRoute.data.routebook?.stops?.find((stop) => stop.id === 'fallback');
    if (!farCoordinateRoute.response.ok || !farStop?.navigationDisabled || farStop.geoConfidence >= 60 || !fallbackStop?.navigationDisabled || fallbackStop.geoConfidence >= 60) {
      throw new Error(`Out-of-city and missing coordinates should be fuzzy/non-navigable: ${JSON.stringify(farCoordinateRoute.data.routebook?.stops)}`);
    }
    const modelCoordinateRoute = await fetchJson(`${BASE_URL}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...template,
        title: '模型坐标必须降级',
        profileId: 'model-coordinate-owner',
	        stops: template.stops.map((stop) => ({
	          ...stop,
	          name: `模型坐标点-${stop.id}`,
	          coordinateSource: 'model',
          geoConfidence: 95
        }))
      })
    });
	    if (!modelCoordinateRoute.response.ok || modelCoordinateRoute.data.routebook?.stops?.some((stop) => !stop.navigationDisabled || stop.geoConfidence >= 60)) {
	      throw new Error(`Unverified model coordinates should stay fuzzy/non-navigable: ${JSON.stringify(modelCoordinateRoute.data.routebook?.stops)}`);
	    }
	    const forgedCoordinateProvenanceRoute = await fetchJson(`${BASE_URL}/api/routebooks`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        ...template,
	        title: '伪造坐标来源证明必须降级',
	        profileId: 'forged-coordinate-provenance-owner',
	        stops: template.stops.map((stop) => ({
	          ...stop,
	          name: `伪造坐标来源点-${stop.id}`,
	          coordinateSource: 'amap-geocode',
	          coordinatePrecision: 'exact',
	          geoConfidence: 99,
	          coordinateProvenance: {
	            provider: 'amap',
	            verified: true,
	            signature: 'client-forged-signature'
	          }
	        }))
	      })
	    });
	    recordTargetFailure(
	      targetFailures,
	      forgedCoordinateProvenanceRoute.response.ok && forgedCoordinateProvenanceRoute.data.routebook?.stops?.every((stop) => stop.navigationDisabled && stop.geoConfidence < 60),
	      `[SR-05] Client-forged coordinate provenance should be downgraded to fuzzy/non-navigable coordinates: ${JSON.stringify(forgedCoordinateProvenanceRoute.data.routebook?.stops)}`
	    );
	    const unsignedImportedSourceRoute = await fetchJson(`${BASE_URL}/api/routebooks`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        ...template,
	        title: '未签名导入来源必须降级',
	        profileId: 'unsigned-import-source-owner',
	        importedSources: [{
	          url: 'https://example.com/client-claimed-trusted-guide',
	          platform: 'client-claimed-platform',
	          status: 'fetched',
	          title: '客户端声称已验证的来源',
	          trustScore: 99,
	          signals: ['客户端声称正文完整', '客户端声称来源可靠'],
	          fetchedAt: new Date().toISOString()
	        }]
	      })
	    });
	    const unsignedSource = unsignedImportedSourceRoute.data.routebook?.importedSources?.[0];
	    recordTargetFailure(
	      targetFailures,
	      unsignedImportedSourceRoute.response.ok && Number(unsignedSource?.trustScore) <= 50 && Number(unsignedImportedSourceRoute.data.routebook?.sourceSummary?.averageTrust) <= 50,
	      `[SR-06] Unsigned imported source should not retain a client-claimed high trust score: ${JSON.stringify({ source: unsignedSource, sourceSummary: unsignedImportedSourceRoute.data.routebook?.sourceSummary })}`
	    );
	    const statusEscalation = await fetchJson(`${BASE_URL}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...template,
        title: '试图直接发布的路书',
        publishStatus: 'featured',
        provider: { name: 'curation' },
        profileId: 'status-escalation-owner'
      })
    });
    if (!statusEscalation.response.ok || statusEscalation.data.routebook?.publishStatus !== 'draft') {
      throw new Error(`Direct routebook save should force draft status: ${JSON.stringify(statusEscalation.data)}`);
    }
    const oversizedRoute = await fetchJson(`${BASE_URL}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...template,
        title: '超大路书应被拒绝',
        profileId: 'oversized-owner',
        provider: { padding: 'x'.repeat(1024 * 1024) }
      })
    });
    if (oversizedRoute.response.status !== 413) {
      throw new Error(`Oversized routebook payload should be rejected, got HTTP ${oversizedRoute.response.status}`);
    }
    const bodyLimitProbe = 'x'.repeat(1024 * 1024 + 32 * 1024);
    const oversizedProfile = await fetchJson(`${BASE_URL}/api/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ homeCity: '杭州', padding: bodyLimitProbe })
    });
    if (oversizedProfile.response.status !== 413 || oversizedProfile.data?.code !== 'PAYLOAD_TOO_LARGE') {
      throw new Error(`Generic JSON endpoints should keep the 1 MiB limit: ${JSON.stringify({ status: oversizedProfile.response.status, data: oversizedProfile.data })}`);
    }
    const largeOcrEnvelope = await fetchJson(`${BASE_URL}/api/ocr-guide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-routebook-token': PUBLIC_TOKEN },
      body: JSON.stringify({ images: [], padding: bodyLimitProbe })
    });
    if (largeOcrEnvelope.response.status !== 400 || largeOcrEnvelope.data?.code !== 'OCR_IMAGE_REQUIRED') {
      throw new Error(`OCR endpoint should accept its larger envelope before validating images: ${JSON.stringify({ status: largeOcrEnvelope.response.status, data: largeOcrEnvelope.data })}`);
    }
    const paddedRoute = await fetchJson(`${BASE_URL}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...template,
        title: '字段归一化路书',
        profileId: 'padding-owner',
        provider: { name: 'client', padding: 'x'.repeat(10000) },
        logs: [{ stage: '阶段', input: '输入', result: '结果', status: '通过', padding: 'x'.repeat(10000) }]
      })
    });
    if (!paddedRoute.response.ok || paddedRoute.data.routebook?.provider?.padding || paddedRoute.data.routebook?.logs?.[0]?.padding) {
      throw new Error(`Routebook storage should strip unrecognized provider/log padding: ${JSON.stringify(paddedRoute.data.routebook)}`);
    }
    await assertRoutebookListKeepsOlderUniqueRoutes(BASE_URL, template);
    const overwriteDenied = await fetchJson(`${BASE_URL}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...template,
        publicId: routeId,
        id: routeId,
        title: '恶意覆盖路书',
        profileId: 'other-profile'
      })
    });
	    if (overwriteDenied.response.status !== 403) {
	      throw new Error(`Cross-profile routebook overwrite should be denied, got HTTP ${overwriteDenied.response.status}`);
	    }
	    const spoofedCreatorRoute = await fetchJson(`${BASE_URL}/api/routebooks`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        ...template,
	        title: '伪造官方作者的路书',
	        profileId: 'creator-spoof-owner',
	        creator: { id: 'official-curation', name: '可信路书编辑部', sourceAuthorization: 'self-owned' },
	        sourceAuthorization: 'self-owned'
	      })
	    });
		    if (!spoofedCreatorRoute.response.ok || spoofedCreatorRoute.data.routebook?.creator?.id !== spoofedCreatorRoute.data.routebook?.profileId || spoofedCreatorRoute.data.routebook?.creator?.id === 'official-curation' || spoofedCreatorRoute.data.routebook?.sourceAuthorization !== 'user-generated') {
		      throw new Error(`User route save should force creator/sourceAuthorization to profile ownership: ${JSON.stringify(spoofedCreatorRoute.data.routebook)}`);
		    }
	    const spoofedProfileDenied = await fetchJson(`${BASE_URL}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...template,
        publicId: routeId,
        id: routeId,
        title: '同 profileId 但没有编辑令牌',
        profileId: 'security-owner'
      })
    });
    if (spoofedProfileDenied.response.status !== 403) {
      throw new Error(`Same-profile routebook overwrite without edit token should be denied, got HTTP ${spoofedProfileDenied.response.status}`);
    }
    const variantDraft = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}/variants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId: 'security-owner',
        editToken: ownerEditToken,
        expectedVersion: 1,
        variant: {
          mode: '少走路',
          stops: template.stops
        }
      })
    });
    if (!variantDraft.response.ok || !variantDraft.data.variant?.id) {
      throw new Error(`Owner draft variant should save: ${JSON.stringify(variantDraft.data)}`);
    }
    const draftShare = await fetchJson(`${BASE_URL}/api/share/${encodeURIComponent(routeId)}`);
    if (draftShare.response.status !== 404) {
      throw new Error(`Draft share should be hidden, got HTTP ${draftShare.response.status}`);
    }
    const remoteDraftRoutebook = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}`, {
      headers: {
        'x-routebook-token': PUBLIC_TOKEN,
        'x-forwarded-for': '203.0.113.200'
      }
    });
    if (remoteDraftRoutebook.response.status !== 404) {
      throw new Error(`Remote draft routebook should be hidden, got HTTP ${remoteDraftRoutebook.response.status}`);
    }
    const selfPublished = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'security-owner', editToken: ownerEditToken, expectedVersion: 2 })
    });
    if (!selfPublished.response.ok || selfPublished.data.routebook?.publishStatus !== 'published' || !selfPublished.data.shareUrl) {
      throw new Error(`Owner publish endpoint should publish draft: ${JSON.stringify(selfPublished.data)}`);
    }
	    const ownerCheckin = await fetchJson(`${BASE_URL}/api/checkins`, {
	      method: 'POST',
	      headers: profileHeaders(boundProfile.data.profile),
	      body: JSON.stringify({
	        profileId: boundProfile.data.profile.id,
	        routeId,
        routeTitle: template.title,
        city: template.city,
        stopId: 'a',
        stopName: '柳浪闻莺',
        editToken: ownerEditToken,
        worth: '值得',
        queue: '5 分钟',
        cost: '0 元',
	        crowd: '适中',
	        comment: '现场可执行',
	        photoName: 'private-arrival-evidence.jpg',
	        gps: { lat: 30.242, lng: 120.1617, accuracy: 35 }
	      })
	    });
			    if (!ownerCheckin.response.ok || !ownerCheckin.data.checkin?.arrival?.valid) {
			      throw new Error(`Authenticated profile checkin should save a valid GPS arrival: ${JSON.stringify(ownerCheckin.data)}`);
		    }
		    for (const surface of ['routebook-save', 'routebook-save', 'trip-open', 'trip-open']) {
		      const eventResult = await fetchJson(`${BASE_URL}/api/exposures`, {
		        method: 'POST',
		        headers: profileHeaders(boundProfile.data.profile),
		        body: JSON.stringify({
		          profileId: boundProfile.data.profile.id,
		          surface,
		          itemType: 'journey-event',
		          itemId: routeId,
	          routeId,
	          routeTitle: template.title,
	          city: template.city,
	          travelDate: template.constraints.date
		        })
		      });
		      if (!eventResult.response.ok) {
		        throw new Error(`Journey event should be recorded: ${JSON.stringify(eventResult.data)}`);
		      }
		    }
		    const journeyDashboard = await fetchJson(`${BASE_URL}/api/dashboard`, {
		      headers: { 'x-routebook-admin-token': ADMIN_TOKEN }
		    });
		    const journeyFunnel = journeyDashboard.data.dashboard?.funnel;
		    if (!journeyDashboard.response.ok || journeyFunnel?.savedRoutebooks !== 1 || journeyFunnel?.travelDateSavedRoutebooks !== 1 || journeyFunnel?.tripOpenedJourneys !== 1 || journeyFunnel?.validCheckinJourneys !== 1 || journeyFunnel?.savedTripOpenedJourneys !== 1 || journeyFunnel?.tripDayOpenRate !== 100 || journeyFunnel?.effectiveExecutedRoutebooks !== 1 || journeyFunnel?.effectiveExecutionRate !== 100 || journeyFunnel?.checkinRate !== 100) {
		      throw new Error(`Journey funnel should deduplicate profile-route events and stay within 100%: ${JSON.stringify(journeyFunnel)}`);
		    }
		    recordTargetFailure(
	      targetFailures,
	      ownerCheckin.data.checkin?.trustState === 'profile-attested',
	      `[SR-03] Checkin with a valid profile token should be profile-attested: ${JSON.stringify(ownerCheckin.data.checkin)}`
	    );
    const refreshedAfterCheckin = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}`);
    if (!refreshedAfterCheckin.response.ok || refreshedAfterCheckin.data.routebook?.feedbackSummary?.attestedCheckinCount < 1) {
      throw new Error(`Route trust feedback should include attested checkin: ${JSON.stringify(refreshedAfterCheckin.data)}`);
    }
    if (!refreshedAfterCheckin.data.routebook?.trustMeta || refreshedAfterCheckin.data.routebook.trustMeta.sampleCount < 1) {
      throw new Error(`Route trust metadata should expose feedback weighting: ${JSON.stringify(refreshedAfterCheckin.data.routebook?.trustMeta)}`);
    }
		    const poiTrust = refreshedAfterCheckin.data.routebook.stops?.find((stop) => stop.id === 'a')?.poiTrust;
		    if (!poiTrust || poiTrust.validArrivals < 1 || !poiTrust.latestVerifiedAt) {
		      throw new Error(`POI trust should aggregate valid checkins: ${JSON.stringify(refreshedAfterCheckin.data.routebook.stops)}`);
		    }
		    const publicStopAfterOneSample = refreshedAfterCheckin.data.routebook.stops?.find((stop) => stop.id === 'a');
		    recordTargetFailure(
		      targetFailures,
		      refreshedAfterCheckin.data.routebook?.trustScore == null &&
		        refreshedAfterCheckin.data.routebook?.trustMeta?.predictionScore == null &&
		        refreshedAfterCheckin.data.routebook?.trustMeta?.feedbackScore == null &&
		        publicStopAfterOneSample?.score == null &&
		        publicStopAfterOneSample?.poiTrust?.score == null,
		      `[SR-04] Public route and POI prediction scores must stay hidden below three independent valid profiles: ${JSON.stringify(refreshedAfterCheckin.data.routebook)}`
		    );
		    const shareAfterOneSample = await fetchJson(`${BASE_URL}/api/share/${encodeURIComponent(routeId)}`);
		    recordTargetFailure(
		      targetFailures,
		      shareAfterOneSample.response.ok &&
		        shareAfterOneSample.data.share?.trustScore == null &&
		        shareAfterOneSample.data.routebook?.trustScore == null &&
		        shareAfterOneSample.data.routebook?.stops?.find((stop) => stop.id === 'a')?.poiTrust?.score == null,
		      `[SR-04] Public share serialization must hide sub-threshold scores: ${JSON.stringify(shareAfterOneSample.data)}`
		    );
		    const privateAfterOneSample = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}`, {
		      headers: { 'x-routebook-admin-token': ADMIN_TOKEN }
		    });
		    recordTargetFailure(
		      targetFailures,
		      privateAfterOneSample.response.ok &&
		        Number.isFinite(privateAfterOneSample.data.routebook?.trustScore) &&
		        Number.isFinite(privateAfterOneSample.data.routebook?.trustMeta?.predictionScore) &&
		        Number.isFinite(privateAfterOneSample.data.routebook?.stops?.find((stop) => stop.id === 'a')?.score) &&
		        Number.isFinite(privateAfterOneSample.data.routebook?.stops?.find((stop) => stop.id === 'a')?.poiTrust?.score),
		      `[SR-04] Private/admin reads should preserve internal prediction inputs: ${JSON.stringify(privateAfterOneSample.data.routebook)}`
		    );
		    const firstVerifiedAt = refreshedAfterCheckin.data.routebook.trustMeta.latestVerifiedAt;
		    const feedbackOnlyCheckin = await fetchJson(`${BASE_URL}/api/checkins`, {
		      method: 'POST',
		      headers: profileHeaders(boundProfile.data.profile),
		      body: JSON.stringify({
		        profileId: boundProfile.data.profile.id,
	        routeId,
	        routeTitle: template.title,
	        city: template.city,
	        stopId: 'b',
	        stopName: '灵隐寺',
	        editToken: ownerEditToken,
	        worth: '值得',
	        queue: '无需排队',
	        cost: '0 元',
	        crowd: '适中',
	        comment: '仅普通反馈，没有 GPS',
	        photoName: 'private-feedback-evidence.jpg'
		      })
		    });
			    if (!feedbackOnlyCheckin.response.ok || feedbackOnlyCheckin.data.checkin?.arrival?.valid) {
			      throw new Error(`Authenticated feedback without GPS should not be a valid arrival: ${JSON.stringify(feedbackOnlyCheckin.data)}`);
		    }
	    recordTargetFailure(
	      targetFailures,
	      feedbackOnlyCheckin.data.checkin?.trustState === 'profile-attested',
	      `[SR-03] Feedback with a valid profile token should remain profile-attested: ${JSON.stringify(feedbackOnlyCheckin.data.checkin)}`
	    );
	    const refreshedAfterFeedbackOnly = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}`);
	    const feedbackSummary = refreshedAfterFeedbackOnly.data.routebook?.feedbackSummary;
	    const stopBTrust = refreshedAfterFeedbackOnly.data.routebook?.stops?.find((stop) => stop.id === 'b')?.poiTrust;
	    if (!refreshedAfterFeedbackOnly.response.ok || feedbackSummary?.validArrivalCount !== 1 || refreshedAfterFeedbackOnly.data.routebook?.trustMeta?.sampleCount !== 1) {
	      throw new Error(`Feedback-only checkins should not increase verified samples: ${JSON.stringify(refreshedAfterFeedbackOnly.data.routebook?.trustMeta)}`);
	    }
			    if (refreshedAfterFeedbackOnly.data.routebook?.trustMeta?.latestVerifiedAt !== firstVerifiedAt || stopBTrust?.latestVerifiedAt || stopBTrust?.sampleCount !== 0 || stopBTrust?.score != null) {
			      throw new Error(`Latest verified timestamps should only use valid GPS arrivals: ${JSON.stringify({ trustMeta: refreshedAfterFeedbackOnly.data.routebook?.trustMeta, stopBTrust })}`);
			    }
	    const repeatedProfileCheckins = [];
	    for (let index = 0; index < 2; index += 1) {
	      repeatedProfileCheckins.push(await submitAuthenticatedCheckin(BASE_URL, {
	        profile: boundProfile.data.profile,
	        routeId,
	        routeTitle: template.title,
	        city: template.city,
	        stopId: 'a',
	        stopName: '柳浪闻莺',
	        editToken: ownerEditToken,
	        comment: `同一认证 profile 重复打卡 ${index + 2}`
	      }));
	    }
	    if (repeatedProfileCheckins.some((result) => !result.response.ok || !result.data.checkin?.arrival?.valid)) {
	      throw new Error(`Repeated authenticated profile checkins should save for deduplication testing: ${JSON.stringify(repeatedProfileCheckins.map((result) => result.data))}`);
	    }
	    recordTargetFailure(
	      targetFailures,
	      repeatedProfileCheckins.every((result) => result.data.checkin?.trustState === 'profile-attested'),
	      `[SR-03] Repeated checkins with a valid profile token should be profile-attested: ${JSON.stringify(repeatedProfileCheckins.map((result) => result.data.checkin?.trustState))}`
	    );
	    const afterRepeatedProfileCheckins = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}`);
		    recordTargetFailure(
		      targetFailures,
		      afterRepeatedProfileCheckins.response.ok &&
		        afterRepeatedProfileCheckins.data.routebook?.trustMeta?.displayScore == null &&
		        afterRepeatedProfileCheckins.data.routebook?.trustMeta?.source === 'prediction' &&
		        afterRepeatedProfileCheckins.data.routebook?.stops?.find((stop) => stop.id === 'a')?.poiTrust?.sampleCount === 1,
		      `[SR-04] Repeated arrivals from one authenticated profile must not unlock a verified trust number: ${JSON.stringify(afterRepeatedProfileCheckins.data.routebook?.trustMeta)}`
		    );

		    const skippedArrival = await submitAuthenticatedCheckin(BASE_URL, {
		      profile: secondBoundProfile,
		      routeId,
		      routeTitle: template.title,
		      city: template.city,
		      stopId: 'a',
		      stopName: '柳浪闻莺',
		      status: 'skipped',
		      comment: '跳过状态即使 GPS 有效也不能计入可信样本'
		    });
		    const replacedArrival = await submitAuthenticatedCheckin(BASE_URL, {
		      profile: thirdBoundProfile,
		      routeId,
		      routeTitle: template.title,
		      city: template.city,
		      stopId: 'a',
		      stopName: '柳浪闻莺',
		      status: 'replaced',
		      comment: '替换状态即使 GPS 有效也不能计入可信样本'
		    });
		    if (!skippedArrival.response.ok || !skippedArrival.data.checkin?.arrival?.valid || skippedArrival.data.checkin?.status !== 'skipped' ||
		      !replacedArrival.response.ok || !replacedArrival.data.checkin?.arrival?.valid || replacedArrival.data.checkin?.status !== 'replaced') {
		      throw new Error(`Skipped/replaced GPS rows should persist as non-trust feedback: ${JSON.stringify({ skipped: skippedArrival.data, replaced: replacedArrival.data })}`);
		    }
		    const afterSkippedAndReplaced = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}`);
		    const poiAfterSkippedAndReplaced = afterSkippedAndReplaced.data.routebook?.stops?.find((stop) => stop.id === 'a')?.poiTrust;
		    recordTargetFailure(
		      targetFailures,
		      afterSkippedAndReplaced.response.ok &&
		        afterSkippedAndReplaced.data.routebook?.trustMeta?.sampleCount === 1 &&
		        afterSkippedAndReplaced.data.routebook?.trustMeta?.displayScore == null &&
		        poiAfterSkippedAndReplaced?.sampleCount === 1 &&
		        poiAfterSkippedAndReplaced?.score == null,
		      `[SR-04] Skipped/replaced arrivals must not affect route or POI trust samples: ${JSON.stringify(afterSkippedAndReplaced.data.routebook)}`
		    );

		    const secondProfileCheckin = await submitAuthenticatedCheckin(BASE_URL, {
	      profile: secondBoundProfile,
	      routeId,
	      routeTitle: template.title,
	      city: template.city,
	      stopId: 'a',
	      stopName: '柳浪闻莺',
	      comment: '第二个认证 profile 的真实到达'
	    });
	    if (!secondProfileCheckin.response.ok || !secondProfileCheckin.data.checkin?.arrival?.valid) {
	      throw new Error(`Second authenticated profile checkin should save a valid arrival: ${JSON.stringify(secondProfileCheckin.data)}`);
	    }
	    recordTargetFailure(
	      targetFailures,
	      secondProfileCheckin.data.checkin?.trustState === 'profile-attested',
	      `[SR-03] Second valid profile token should produce profile-attested feedback: ${JSON.stringify(secondProfileCheckin.data.checkin)}`
	    );
		    const afterTwoProfiles = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}`);
		    const poiAfterTwoProfiles = afterTwoProfiles.data.routebook?.stops?.find((stop) => stop.id === 'a')?.poiTrust;
		    recordTargetFailure(
		      targetFailures,
		      afterTwoProfiles.response.ok &&
		        afterTwoProfiles.data.routebook?.trustScore == null &&
		        afterTwoProfiles.data.routebook?.trustMeta?.predictionScore == null &&
		        afterTwoProfiles.data.routebook?.trustMeta?.displayScore == null &&
		        afterTwoProfiles.data.routebook?.trustMeta?.source === 'prediction' &&
		        poiAfterTwoProfiles?.sampleCount === 2 &&
		        poiAfterTwoProfiles?.score == null,
		      `[SR-04] Two authenticated profiles are insufficient to display a verified trust number: ${JSON.stringify(afterTwoProfiles.data.routebook?.trustMeta)}`
		    );

	    const thirdProfileCheckin = await submitAuthenticatedCheckin(BASE_URL, {
	      profile: thirdBoundProfile,
	      routeId,
	      routeTitle: template.title,
	      city: template.city,
	      stopId: 'a',
	      stopName: '柳浪闻莺',
	      comment: '第三个认证 profile 的真实到达'
	    });
	    if (!thirdProfileCheckin.response.ok || !thirdProfileCheckin.data.checkin?.arrival?.valid) {
	      throw new Error(`Third authenticated profile checkin should save a valid arrival: ${JSON.stringify(thirdProfileCheckin.data)}`);
	    }
	    recordTargetFailure(
	      targetFailures,
	      thirdProfileCheckin.data.checkin?.trustState === 'profile-attested',
	      `[SR-03] Third valid profile token should produce profile-attested feedback: ${JSON.stringify(thirdProfileCheckin.data.checkin)}`
	    );
		    const afterThreeProfiles = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}`);
		    const stopAfterThreeProfiles = afterThreeProfiles.data.routebook?.stops?.find((stop) => stop.id === 'a');
		    recordTargetFailure(
		      targetFailures,
		      afterThreeProfiles.response.ok &&
		        Number.isFinite(afterThreeProfiles.data.routebook?.trustScore) &&
		        Number.isFinite(afterThreeProfiles.data.routebook?.trustMeta?.predictionScore) &&
		        Number.isFinite(afterThreeProfiles.data.routebook?.trustMeta?.displayScore) &&
		        afterThreeProfiles.data.routebook?.trustMeta?.source !== 'prediction' &&
		        stopAfterThreeProfiles?.poiTrust?.sampleCount === 3 &&
		        Number.isFinite(stopAfterThreeProfiles?.poiTrust?.score) &&
		        Number.isFinite(stopAfterThreeProfiles?.score),
		      `[SR-04] Three distinct authenticated profiles should unlock a verified trust number: ${JSON.stringify(afterThreeProfiles.data.routebook?.trustMeta)}`
		    );
		    const longStopId = 'stop-12345678-1234-1234-1234-123456789abc';
	    const longLocalStopKey = `${longStopId}-alt-1234567890123`;
	    // 新契约：无 token 的未注册 profileId 打卡不再被静默降级为 anonymous，
	    // 而是返回 403 PROFILE_NOT_REGISTERED。
	    const unregisteredCheckinDenied = await fetchJson(`${BASE_URL}/api/checkins`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        profileId: 'security-owner',
	        routeId,
	        routeTitle: template.title,
	        city: template.city,
	        stopId: 'a',
	        stopName: '柳浪闻莺',
	        worth: '值得'
	      })
	    });
	    if (unregisteredCheckinDenied.response.status !== 403 || unregisteredCheckinDenied.data?.code !== 'PROFILE_NOT_REGISTERED') {
	      throw new Error(`Checkin with unregistered profileId and no token should be denied: ${JSON.stringify({ status: unregisteredCheckinDenied.response.status, data: unregisteredCheckinDenied.data })}`);
	    }
	    const longStopCheckin = await fetchJson(`${BASE_URL}/api/checkins`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        profileId: 'anonymous',
	        routeId,
	        routeTitle: template.title,
	        city: template.city,
	        stopId: longStopId,
	        stopName: '行中临时替代点',
	        localStopKey: longLocalStopKey,
	        clientLocalId: 'security-long-stop-checkin',
	        editToken: ownerEditToken,
	        worth: '值得',
	        queue: '无需排队',
	        cost: '0 元',
	        crowd: '适中',
	        comment: '长 ID 和 localStopKey 应被服务端保留，避免行中新增站点完成态丢失。',
	        target: { lat: 30.244, lng: 120.155 },
	        gps: { lat: 30.244, lng: 120.155, accuracy: 35 }
	      })
	    });
	    if (!longStopCheckin.response.ok || longStopCheckin.data.checkin?.stopId !== longStopId || longStopCheckin.data.checkin?.localStopKey !== longLocalStopKey) {
	      throw new Error(`Checkins should preserve long dynamic stop ids/localStopKey: ${JSON.stringify(longStopCheckin.data)}`);
	    }
	    const duplicateLongStopCheckin = await fetchJson(`${BASE_URL}/api/checkins`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        profileId: 'anonymous',
	        routeId,
	        editToken: ownerEditToken,
	        stopId: longStopId,
	        stopName: '行中临时替代点',
	        localStopKey: longLocalStopKey,
	        clientLocalId: 'security-long-stop-checkin',
	        worth: '值得'
	      })
	    });
	    if (!duplicateLongStopCheckin.response.ok || !duplicateLongStopCheckin.data.deduplicated || duplicateLongStopCheckin.data.checkin?.id !== longStopCheckin.data.checkin?.id) {
	      throw new Error(`Repeated clientLocalId should return the original checkin: ${JSON.stringify(duplicateLongStopCheckin.data)}`);
	    }
	    const ownerOverwritePublished = await fetchJson(`${BASE_URL}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...template,
        publicId: routeId,
        id: routeId,
        title: '同 profileId 伪造覆盖',
        profileId: 'security-owner'
      })
    });
    if (ownerOverwritePublished.response.status !== 403) {
      throw new Error(`Published routebook overwrite with spoofed same profile should be denied, got HTTP ${ownerOverwritePublished.response.status}`);
    }
    const publicVariantDenied = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}/variants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId: 'security-owner',
        variant: {
          mode: '雨天',
          stops: template.stops
        }
      })
    });
    if (publicVariantDenied.response.status !== 403) {
      throw new Error(`Published routebook variant mutation should be denied, got HTTP ${publicVariantDenied.response.status}`);
    }
    const published = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-routebook-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ publishStatus: 'published', expectedVersion: 3 })
    });
    if (!published.response.ok) {
      throw new Error(`Publishing routebook failed: ${JSON.stringify(published.data)}`);
    }
    const publicShare = await fetchJson(`${BASE_URL}/api/share/${encodeURIComponent(routeId)}`);
    if (!publicShare.response.ok || publicShare.data.routebook?.publicId !== routeId) {
      throw new Error(`Published share failed: ${JSON.stringify(publicShare.data)}`);
    }
    assertPublicRoutebookRedacted(publicShare.data.routebook, 'Published share');
    const creatorId = publicShare.data.routebook.creator?.id;
    const creatorProfile = await fetchJson(`${BASE_URL}/api/creators/${encodeURIComponent(creatorId)}`);
    if (!creatorProfile.response.ok || creatorProfile.data.profile?.routebooks?.some((book) => book.editToken || book.profileId)) {
      throw new Error(`Creator profile should not expose route edit tokens/profile ids: ${JSON.stringify(creatorProfile.data)}`);
    }
    const copiedRoute = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'copy-viewer', surface: 'security-regression-copy' })
    });
    if (!copiedRoute.response.ok || copiedRoute.data.routebook?.editToken || copiedRoute.data.routebook?.profileId) {
      throw new Error(`Copy endpoint should return only public route data: ${JSON.stringify(copiedRoute.data)}`);
    }
    const remotePublishedRoutebook = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}`, {
      headers: {
        'x-routebook-token': PUBLIC_TOKEN,
        'x-forwarded-for': '203.0.113.200'
      }
    });
    if (!remotePublishedRoutebook.response.ok || remotePublishedRoutebook.data.routebook?.publicId !== routeId) {
      throw new Error(`Remote published routebook fetch failed: ${JSON.stringify(remotePublishedRoutebook.data)}`);
    }
    assertPublicRoutebookRedacted(remotePublishedRoutebook.data.routebook, 'Remote published routebook');
	    const unauthorizedReviewExport = await fetchJson(`${BASE_URL}/api/reviews`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        routebookId: routeId,
	        profileId: boundProfile.data.profile.id,
	        checkins: [{
	          stopId: 'b',
	          stopName: '灵隐寺',
	          arrival: { valid: true, confidence: 'valid' }
	        }]
	      })
	    });
	    recordTargetFailure(
	      targetFailures,
	      unauthorizedReviewExport.response.status === 403,
	      `[SR-01] Review creation with profileId but without profile token should be denied, got HTTP ${unauthorizedReviewExport.response.status}`
	    );
	    const reviewShare = await fetchJson(`${BASE_URL}/api/reviews`, {
	      method: 'POST',
	      headers: profileHeaders(boundProfile.data.profile),
	      body: JSON.stringify({
	        routebookId: routeId,
	        profileId: boundProfile.data.profile.id,
        reviewId: 'client-forged-review-id',
        routebook: { ...published.data.routebook, title: '伪造标题不应生效', stops: [{ id: 'fake', name: '伪造站点' }, ...(published.data.routebook.stops ?? [])] },
        executionStops: [
          { id: 'fake', name: '伪造执行站点', day: 'Day 1', time: '08:00' },
          { ...published.data.routebook.stops?.[1], day: 'Day 1', time: '10:30', tripStatus: 'visited' },
          { ...published.data.routebook.stops?.[0], day: 'Day 1', time: '09:00', tripStatus: 'visited' }
	        ],
	        checkins: [{
	          stopId: 'b',
	          stopName: '灵隐寺',
          status: 'visited',
          worth: '值得',
          arrivalConfidence: 'valid',
          arrival: { valid: true, confidence: 'valid', label: '有效到达', distanceMeters: 80, accuracy: 30 }
        }]
      })
    });
    if (!reviewShare.response.ok || !reviewShare.data.review?.publicId) {
      throw new Error(`Published review share failed: ${JSON.stringify(reviewShare.data)}`);
    }
    if (reviewShare.data.review.routebook?.title !== published.data.routebook.title || reviewShare.data.review.routebook?.stops?.[0]?.name !== published.data.routebook.stops?.[0]?.name) {
      throw new Error(`Review share should use canonical saved routebook, not request body: ${JSON.stringify(reviewShare.data.review.routebook)}`);
    }
    if (reviewShare.data.review.executionStops?.length !== 2 || reviewShare.data.review.executionStops?.some((stop) => stop.id === 'fake')) {
      throw new Error(`Review execution route should preserve canonical order input and reject forged stops: ${JSON.stringify(reviewShare.data.review.executionStops)}`);
    }
	    if (reviewShare.data.review.routebook?.editToken || reviewShare.data.review.routebook?.profileId) {
	      throw new Error(`Review share response should not expose private route fields: ${JSON.stringify(reviewShare.data.review.routebook)}`);
	    }
	    recordTargetFailure(
	      targetFailures,
	      reviewShare.data.review?.stats?.validArrivalCount === 1 && reviewShare.data.review?.checkins?.every((checkin) => checkin.stopId !== 'b' || checkin.arrival?.valid !== true),
	      `[SR-02] Client-supplied review checkins must not manufacture valid arrivals: ${JSON.stringify({ stats: reviewShare.data.review?.stats, checkins: reviewShare.data.review?.checkins })}`
	    );
    const reviewId = reviewShare.data.review.publicId;
    if (reviewId === 'client-forged-review-id') {
      throw new Error('Review share should ignore caller-provided reviewId');
    }
	    const collisionReview = await fetchJson(`${BASE_URL}/api/reviews`, {
	      method: 'POST',
	      headers: profileHeaders(boundProfile.data.profile),
	      body: JSON.stringify({
	        routebookId: routeId,
	        profileId: boundProfile.data.profile.id,
        reviewId,
        checkins: [{
          stopId: 'b',
          stopName: '灵隐寺',
          status: 'visited',
          worth: '踩坑'
        }]
      })
    });
    if (!collisionReview.response.ok || collisionReview.data.review?.publicId === reviewId) {
      throw new Error(`Review share should not allow caller-selected id collisions: ${JSON.stringify(collisionReview.data)}`);
	    }
	    const publicReview = await fetchJson(`${BASE_URL}/api/reviews/${encodeURIComponent(reviewId)}`);
	    if (!publicReview.response.ok) {
	      throw new Error(`Public review fetch failed: ${JSON.stringify(publicReview.data)}`);
	    }
	    assertPublicReviewWhitelist(reviewShare.data.review, 'Review create response');
	    assertPublicReviewWhitelist(publicReview.data.review, 'Public review response');
	    recordTargetFailure(
	      targetFailures,
	      publicReview.data.review?.stats?.validArrivalCount === 1 && publicReview.data.review?.checkins?.every((checkin) => checkin.stopId !== 'b' || checkin.arrival?.valid !== true),
	      `[SR-02] Persisted public review should contain only server-attested arrivals: ${JSON.stringify({ stats: publicReview.data.review?.stats, checkins: publicReview.data.review?.checkins })}`
	    );
    const archived = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(routeId)}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-routebook-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ publishStatus: 'archived', expectedVersion: 4 })
    });
    if (!archived.response.ok) {
      throw new Error(`Archiving routebook failed: ${JSON.stringify(archived.data)}`);
    }
    const archivedShare = await fetchJson(`${BASE_URL}/api/share/${encodeURIComponent(routeId)}`);
    if (archivedShare.response.status !== 404) {
      throw new Error(`Archived share should be hidden, got HTTP ${archivedShare.response.status}`);
    }
    const archivedReview = await fetchJson(`${BASE_URL}/api/reviews/${encodeURIComponent(reviewId)}`);
    if (archivedReview.response.status !== 404) {
      throw new Error(`Archived route review should be hidden, got HTTP ${archivedReview.response.status}`);
    }

    const legacyId = 'legacy-no-token-route';
    await appendFile(join(dataDir, 'routebooks.jsonl'), `${JSON.stringify({
      ...template,
      id: legacyId,
      publicId: legacyId,
      title: '历史无令牌草稿',
      profileId: 'legacy-owner',
      editToken: '',
      publishStatus: 'draft',
      provider: { name: 'legacy-test' },
      updatedAt: new Date().toISOString()
    })}\n`, 'utf8');
    const legacyPublishDenied = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(legacyId)}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'legacy-owner' })
    });
    if (legacyPublishDenied.response.status !== 403) {
      throw new Error(`Legacy draft publish without migrated edit token should be denied, got HTTP ${legacyPublishDenied.response.status}`);
    }
	    const migratedLegacyDraft = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(legacyId)}`, {
	      headers: { 'x-routebook-admin-token': ADMIN_TOKEN }
	    });
    if (!migratedLegacyDraft.response.ok || !migratedLegacyDraft.data.routebook?.editToken) {
      throw new Error(`Local legacy draft read should mint edit token: ${JSON.stringify(migratedLegacyDraft.data)}`);
    }
    const migratedLegacyPublish = await fetchJson(`${BASE_URL}/api/routebooks/${encodeURIComponent(legacyId)}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId: 'legacy-owner',
        editToken: migratedLegacyDraft.data.routebook.editToken,
        expectedVersion: 1
      })
    });
    if (!migratedLegacyPublish.response.ok || migratedLegacyPublish.data.routebook?.publishStatus !== 'published') {
      throw new Error(`Migrated legacy draft should publish with edit token: ${JSON.stringify(migratedLegacyPublish.data)}`);
    }

    const logsForPrivacy = await fetchJson(`${BASE_URL}/api/logs`, {
      headers: { 'x-routebook-admin-token': ADMIN_TOKEN }
    });
    if (!logsForPrivacy.response.ok) {
      throw new Error(`Local logs fetch failed: ${JSON.stringify(logsForPrivacy.data)}`);
    }
    const leakedLog = (logsForPrivacy.data.logs ?? []).find((log) => Object.hasOwn(log, 'inputSummary') || Object.hasOwn(log, 'error'));
    if (leakedLog) {
      throw new Error(`AI logs should not persist raw input summary or error text: ${JSON.stringify(leakedLog)}`);
    }

    const remoteLogsDenied = await fetchJson(`${BASE_URL}/api/logs`, {
      headers: {
        'x-routebook-token': PUBLIC_TOKEN,
        'x-forwarded-for': '203.0.113.200'
      }
    });
    if (remoteLogsDenied.response.status !== 403) {
      throw new Error(`Remote sensitive logs should require admin token, got HTTP ${remoteLogsDenied.response.status}`);
    }
    const remoteLogsAllowed = await fetchJson(`${BASE_URL}/api/logs`, {
      headers: {
        'x-routebook-token': PUBLIC_TOKEN,
        'x-routebook-admin-token': ADMIN_TOKEN,
        'x-forwarded-for': '203.0.113.200'
      }
    });
    if (!remoteLogsAllowed.response.ok) {
      throw new Error(`Remote sensitive logs with admin token should pass: ${JSON.stringify(remoteLogsAllowed.data)}`);
    }
    const remoteFavoritesDenied = await fetchJson(`${BASE_URL}/api/favorites?profileId=security-owner`, {
      headers: {
        'x-routebook-token': PUBLIC_TOKEN,
        'x-forwarded-for': '203.0.113.200'
      }
    });
    if (remoteFavoritesDenied.response.status !== 403) {
      throw new Error(`Remote favorites read should require admin token, got HTTP ${remoteFavoritesDenied.response.status}`);
    }

    const privateUrlResponse = await fetchJson(`${BASE_URL}/api/import-guide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-routebook-token': PUBLIC_TOKEN },
      body: JSON.stringify({ urls: ['http://127.0.0.1:1/private'] })
    });
    const privateUrlWarning = privateUrlResponse.data.sources?.[0]?.warnings?.join('\n') ?? '';
    if (!privateUrlResponse.response.ok || !/非公网|公网|不可访问/.test(privateUrlWarning)) {
      throw new Error(`Private URL should be reported as unsafe: ${JSON.stringify(privateUrlResponse.data)}`);
    }
    const ipv6LinkLocalResponse = await fetchJson(`${BASE_URL}/api/import-guide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-routebook-token': PUBLIC_TOKEN },
      body: JSON.stringify({ urls: ['http://[fe90::1]/private'] })
    });
    const ipv6Warning = ipv6LinkLocalResponse.data.sources?.[0]?.warnings?.join('\n') ?? '';
    if (!ipv6LinkLocalResponse.response.ok || !/非公网|公网|不可访问/.test(ipv6Warning)) {
      throw new Error(`IPv6 link-local URL should be reported as unsafe: ${JSON.stringify(ipv6LinkLocalResponse.data)}`);
    }

	    await assertUntrustedForwardedForCannotBypassRateLimit(dataDir);
	    if (targetFailures.length) {
	      throw new Error(`Target security regressions failed:\n- ${targetFailures.join('\n- ')}`);
	    }

	    console.log(JSON.stringify({ ok: true, baseUrl: BASE_URL }, null, 2));
  } finally {
    if (originalProducts) {
      await fetchJson(`${BASE_URL}/api/products`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-routebook-admin-token': ADMIN_TOKEN },
        body: JSON.stringify({ products: originalProducts?.data?.products ?? [] })
      }).catch(() => {});
    }
    child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    if (!child.killed && stderr.length) console.error(stderr.join(''));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

function assertPublicRoutebookRedacted(routebook, label) {
  const forbidden = ['profileId', 'editToken', 'constraints', 'travelDate', 'importedSources', 'sourceSummary', 'logs', 'provider'];
  const leaked = forbidden.filter((field) => Object.hasOwn(routebook ?? {}, field));
  if (leaked.length) {
    throw new Error(`${label} should redact private fields (${leaked.join(', ')}): ${JSON.stringify(routebook)}`);
  }
}

function assertPublicReviewWhitelist(review, label) {
  assertExactKeys(review, ['checkins', 'executionStops', 'publicId', 'routebook', 'routebookId', 'stats'], label);
  assertExactKeys(review?.routebook, ['city', 'id', 'publicId', 'stops', 'title'], `${label} routebook`);
  for (const stop of review?.routebook?.stops ?? []) {
    assertExactKeys(stop, ['day', 'id', 'name', 'time'], `${label} route stop`);
  }
  for (const stop of review?.executionStops ?? []) {
    // rank13④ 刻意语义变更：执行站点新增 photoId（照片证据 ID，格式受限白名单字段）。
    assertExactKeys(stop, ['day', 'id', 'name', 'photoId', 'time', 'tripReplacementFor', 'tripStatus'], `${label} execution stop`);
  }
  for (const checkin of review?.checkins ?? []) {
    // rank13④ 刻意语义变更：回顾打卡行新增 photoId（照片本体仍走独立照片接口）。
    assertExactKeys(checkin, [
      'arrival',
      'arrivalConfidence',
      'comment',
      'cost',
      'crowd',
      'localStopKey',
      'photoId',
      'pitfall',
      'poiId',
      'queue',
      'status',
      'stopId',
      'stopName',
      'worth'
    ], `${label} checkin`);
    if (checkin.arrival) {
      assertExactKeys(checkin.arrival, ['confidence', 'label', 'valid'], `${label} arrival`);
    }
  }
  assertExactKeys(review?.stats, [
    'checkinCount',
    'completionRate',
    'feedbackCount',
    'lowConfidenceArrivalCount',
    'pitfallCount',
    'validArrivalCount'
  ], `${label} stats`);
  const serialized = JSON.stringify(review);
  for (const field of ['photoName', 'distanceMeters', 'accuracy', 'createdAt', 'updatedAt', 'profileId', 'editToken', 'provider', 'gps']) {
    if (serialized.includes(`"${field}"`)) {
      throw new Error(`${label} should not expose ${field}: ${serialized}`);
    }
  }
}

function assertExactKeys(value, expected, label) {
  const actualKeys = Object.keys(value ?? {}).sort();
  const expectedKeys = [...expected].sort();
  if (actualKeys.join('\n') !== expectedKeys.join('\n')) {
    throw new Error(`${label} should expose only [${expectedKeys.join(', ')}], got [${actualKeys.join(', ')}]`);
  }
}

async function assertRoutebookListKeepsOlderUniqueRoutes(baseUrl, template) {
  const routeA = await fetchJson(`${baseUrl}/api/routebooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...template,
      title: '列表唯一性 Route A',
      profileId: 'list-owner-a'
    })
  });
  const routeB = await fetchJson(`${baseUrl}/api/routebooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...template,
      title: '列表唯一性 Route B',
      profileId: 'list-owner-b'
    })
  });
  if (!routeA.response.ok || !routeB.response.ok) {
    throw new Error(`List setup routebooks should save: ${JSON.stringify({ a: routeA.data, b: routeB.data })}`);
  }
  let edited = routeB.data.routebook;
  for (let index = 0; index < 205; index += 1) {
    const result = await fetchJson(`${baseUrl}/api/routebooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...edited,
        title: `列表唯一性 Route B edited ${index}`,
        editToken: routeB.data.routebook.editToken,
        expectedVersion: edited.version
      })
    });
    if (!result.response.ok) {
      throw new Error(`Route B repeated edit ${index} should save: ${JSON.stringify(result.data)}`);
    }
    edited = result.data.routebook;
  }
  const listed = await fetchJson(`${baseUrl}/api/routebooks?limit=2`, {
    headers: { 'x-routebook-admin-token': ADMIN_TOKEN }
  });
  const titles = (listed.data.routebooks ?? []).map((item) => item.title);
  if (!listed.response.ok || !titles.some((title) => title.includes('Route A')) || !titles.some((title) => title.includes('Route B'))) {
    throw new Error(`Routebook list should scan past repeated edits to return unique routes: ${JSON.stringify(titles)}`);
  }
}

function createIdentityProof(type, subject) {
  const issuedAt = new Date().toISOString();
  const nonce = `nonce-${Date.now()}`;
  const payload = `trusted-routebook:${type}:${subject}:${issuedAt}:${nonce}`;
  const signature = createHmac('sha256', IDENTITY_ASSERTION_SECRET).update(payload).digest('hex');
	  return { type, subject, issuedAt, nonce, signature };
}

function profileHeaders(profile) {
  return {
    'content-type': 'application/json',
    'x-routebook-profile-id': profile.id,
    'x-routebook-profile-token': profile.profileAccessToken
  };
}

async function createVerifiedProfile(baseUrl, { localProfileId, subject }) {
  const result = await fetchJson(`${baseUrl}/api/profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: localProfileId,
      identity: createIdentityProof('phone', subject),
      homeCity: '杭州'
    })
  });
  if (!result.response.ok || !result.data.profile?.identityBound || !result.data.profile?.profileAccessToken) {
    throw new Error(`Verified profile setup failed for ${localProfileId}: ${JSON.stringify(result.data)}`);
  }
  return result.data.profile;
}

async function submitAuthenticatedCheckin(baseUrl, {
  profile,
  routeId,
  routeTitle,
  city,
  stopId,
  stopName,
  editToken = '',
  status = 'visited',
  comment = ''
}) {
  return fetchJson(`${baseUrl}/api/checkins`, {
    method: 'POST',
    headers: profileHeaders(profile),
    body: JSON.stringify({
      profileId: profile.id,
      routeId,
      routeTitle,
      city,
      stopId,
      stopName,
      editToken,
      status,
      worth: '值得',
      queue: '5 分钟',
      cost: '0 元',
      crowd: '适中',
      comment,
      gps: { lat: 30.242, lng: 120.1617, accuracy: 35 }
    })
  });
}

function recordTargetFailure(failures, condition, message) {
  if (!condition) failures.push(message);
}

async function assertUntrustedForwardedForCannotBypassRateLimit(dataDir) {
  const port = PORT + 1;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...hermeticServerEnv(),
      PORT: String(port),
      HOST: '127.0.0.1',
      ROUTEBOOK_DATA_DIR: dataDir,
      RATE_LIMIT_MAX: '8',
      RATE_LIMIT_WINDOW_MS: '60000',
      IMPORT_TIMEOUT_MS: '3000',
      VITE_HMR_PORT: '24800'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForHealth(baseUrl);
    const rateStatuses = [];
    for (let index = 0; index < 14; index += 1) {
      const result = await fetchJson(`${baseUrl}/api/import-guide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${index}` },
        body: JSON.stringify({ urls: ['http://127.0.0.1:1/not-public'] })
      });
      rateStatuses.push(result.response.status);
      if (result.response.status === 429) break;
    }
    if (!rateStatuses.includes(429)) {
      throw new Error(`X-Forwarded-For should not bypass rate limit when proxy trust is disabled: ${JSON.stringify(rateStatuses)}`);
    }
  } finally {
    child.kill('SIGTERM');
  }
}

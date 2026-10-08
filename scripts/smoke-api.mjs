import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const explicitBaseUrl = process.env.SMOKE_BASE_URL;
const APP_ID = 'trusted-routebook';
const FETCH_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180000);
const SMOKE_PORT = Number(process.env.SMOKE_PORT ?? 5299);
const HEALTH_PROBE_TIMEOUT_MS = Number(process.env.SMOKE_HEALTH_PROBE_TIMEOUT_MS ?? 2000);
const HEALTH_POLL_INTERVAL_MS = Number(process.env.SMOKE_HEALTH_POLL_INTERVAL_MS ?? 300);
// M7: how long to wait for the server to accept connections, and how long to keep
// polling once it reports `ready: false` (model config does not change at runtime,
// so the default is to fail on the first not-ready answer).
const STARTUP_TIMEOUT_MS = Number(process.env.SMOKE_STARTUP_TIMEOUT_MS ?? 30000);
const NOT_READY_GRACE_MS = Number(process.env.SMOKE_NOT_READY_GRACE_MS ?? 0);
const SMOKE_PROFILE_ID = 'smoke-profile';
const SMOKE_ADMIN_TOKEN = 'smoke-admin-token';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId)
  };
}

async function fetchJson(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const timeout = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: timeout.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    timeout.clear();
  }
}

async function discoverBaseUrl(baseUrl, { child = null, childOutput = [], headers = {} } = {}) {
  if (!baseUrl) {
    throw new Error('No smoke base URL resolved');
  }

  const started = Date.now();
  let firstNotReadyAt = null;
  let lastError = null;
  while (Date.now() - started < STARTUP_TIMEOUT_MS) {
    if (child && child.exitCode !== null) {
      throw new Error(`Smoke server exited early with code ${child.exitCode}:\n${childOutput.join('').slice(-4000)}`);
    }
    try {
      const { response, data } = await fetchJson(`${baseUrl}/api/health?smoke=1`, { headers }, HEALTH_PROBE_TIMEOUT_MS);
      if (!response.ok) {
        lastError = new Error(`Health failed: ${JSON.stringify(data)}`);
      } else if (data?.appId !== APP_ID) {
        throw new Error(`Health appId mismatch: ${JSON.stringify(data)}`);
      } else if (!data?.ready) {
        firstNotReadyAt ??= Date.now();
        if (Date.now() - firstNotReadyAt >= NOT_READY_GRACE_MS) {
          throw new Error(
            `Model runtime is not ready: ${data.reason || 'no reason given'}. ` +
              'smoke:api calls a real model; configure OPENAI_BASE_URL / OPENAI_API_KEY (or AI_RUNTIME_FROM_CODEX in development). ' +
              'Set SMOKE_NOT_READY_GRACE_MS to keep polling.'
          );
        }
        lastError = new Error(`API not ready: ${JSON.stringify(data)}`);
      } else {
        return { baseUrl, health: data };
      }
    } catch (error) {
      if (error.message?.startsWith('Model runtime is not ready') || error.message?.startsWith('Health appId mismatch')) throw error;
      lastError = error.name === 'AbortError' ? new Error(`Health probe timed out after ${HEALTH_PROBE_TIMEOUT_MS}ms`) : error;
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(`Health did not become ready after ${STARTUP_TIMEOUT_MS}ms: ${lastError?.message ?? 'unknown error'}`);
}

async function main() {
  if (explicitBaseUrl && !isLocalBaseUrl(explicitBaseUrl)) {
    throw new Error(
      'SMOKE_BASE_URL is mutating and only supports localhost/127.0.0.1 targets. Run npm run smoke:api without SMOKE_BASE_URL for isolated temp-data smoke.'
    );
  }
  if (explicitBaseUrl && process.env.SMOKE_ALLOW_MUTATING_BASE_URL !== 'true') {
    throw new Error(
      'SMOKE_BASE_URL points at an existing local server and would write routebooks/imports/logs. Run npm run smoke:api without SMOKE_BASE_URL for an isolated temp-data smoke, or set SMOKE_ALLOW_MUTATING_BASE_URL=true to opt in for localhost only.'
    );
  }
  let child = null;
  let dataDir = '';
  let activeBaseUrl = explicitBaseUrl;
  const childOutput = [];
  if (!activeBaseUrl) {
    dataDir = await mkdtemp(join(tmpdir(), 'routebook-smoke-'));
    const smokePort = await findAvailablePort(SMOKE_PORT);
    const hmrPort = await findAvailablePort(Number(process.env.VITE_HMR_PORT ?? smokePort + 1000));
    activeBaseUrl = `http://127.0.0.1:${smokePort}`;
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        PORT: String(smokePort),
        HOST: '127.0.0.1',
        ROUTEBOOK_DATA_DIR: dataDir,
        REQUIRE_LOCAL_ADMIN_TOKEN: 'true',
        ROUTEBOOK_ADMIN_TOKEN: SMOKE_ADMIN_TOKEN,
        PROFILE_ID_SECRET: process.env.PROFILE_ID_SECRET ?? 'smoke-profile-id-secret',
        VITE_HMR_PORT: String(hmrPort)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => childOutput.push(chunk.toString()));
    child.stderr.on('data', (chunk) => childOutput.push(chunk.toString()));
    process.env.SMOKE_BASE_URL = activeBaseUrl;
  }
  try {
    const { baseUrl, health } = await discoverBaseUrl(activeBaseUrl, {
      child,
      childOutput,
      headers: child ? { 'x-routebook-admin-token': SMOKE_ADMIN_TOKEN } : {}
    });
    const { response: originalProductsResponse, data: originalProductsData } = await fetchJson(`${baseUrl}/api/products`);
    if (!originalProductsResponse.ok) {
      throw new Error(`Product config preflight failed: ${JSON.stringify(originalProductsData)}`);
    }
    let productConfigUpdatedAt = null;

    try {
      const { response: importResponse, data: importData } = await fetchJson(`${baseUrl}/api/import-guide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://example.com/hangzhou-weekend-route']
        })
      });
      if (!importResponse.ok) throw new Error(`Import failed: ${JSON.stringify(importData)}`);
      if (!Array.isArray(importData.sources) || importData.sources.length !== 1) {
        throw new Error(`Import response has invalid sources: ${JSON.stringify(importData)}`);
      }
      if (!Number.isFinite(Number(importData.sources[0].trustScore))) {
        throw new Error(`Import source missing trustScore: ${JSON.stringify(importData.sources[0])}`);
      }

      const { response, data } = await fetchJson(`${baseUrl}/api/generate-routebook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          city: '成都',
          guide: '周末 2 天 1 晚，人民公园、武侯祠、锦里、太古里，预算人均 900，节奏不要太赶。',
          profileId: SMOKE_PROFILE_ID,
          importedSources: importData.sources,
          constraints: {
            duration: '2 天 1 晚',
            budget: '人均 900',
            tempo: '松弛但不空',
            companion: '朋友',
            mustGo: '人民公园、武侯祠',
            avoid: '排队过久'
          }
        })
      });
      if (!response.ok) throw new Error(`Generate failed: ${JSON.stringify(data)}`);
      if (!Array.isArray(data.stops) || data.stops.length < 3) {
        throw new Error('Generate response has insufficient stops');
      }
      if (data.city !== '成都') {
        throw new Error(`Generate response city mismatch: ${JSON.stringify({ city: data.city, title: data.title })}`);
      }
      if (!Array.isArray(data.days) || data.days.length < 1) {
        throw new Error('Generate response has no days');
      }
      for (const key of ['assets', 'validations', 'metrics', 'logs']) {
        if (!Array.isArray(data[key]) || !data[key].length) {
          throw new Error(`Generate response has empty ${key}`);
        }
      }
      const invalidStop = data.stops.find((stop) => {
        const lat = Number(stop.lat);
        const lng = Number(stop.lng);
        return !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180;
      });
      if (invalidStop) {
        throw new Error(`Generate response has invalid coordinates: ${JSON.stringify(invalidStop)}`);
      }
      if (!data.publicId) {
        throw new Error(`Generate response missing share fields: ${JSON.stringify({ publicId: data.publicId, shareUrl: data.shareUrl })}`);
      }
      if (data.shareUrl) {
        throw new Error(`Draft generation should not expose a public share URL: ${data.shareUrl}`);
      }

      const edited = {
        ...data,
        expectedVersion: data.version,
        stops: data.stops.map((stop, index) => (index === 0 ? { ...stop, cost: '待估算', geoConfidence: 45 } : stop)),
        editReason: 'smoke 重算'
      };
      const { response: saveResponse, data: saveData } = await fetchJson(`${baseUrl}/api/routebooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(edited)
      });
      if (!saveResponse.ok) throw new Error(`Routebook save failed: ${JSON.stringify(saveData)}`);
      if (!saveData.routebook?.publicId) {
        throw new Error(`Routebook save missing share data: ${JSON.stringify(saveData)}`);
      }
      if (!saveData.routebook.editToken) {
        throw new Error(`Routebook save missing edit token for owner publish flow: ${JSON.stringify(saveData.routebook)}`);
      }
      if (saveData.routebook.trustScore === data.trustScore && saveData.routebook.metrics?.find?.((item) => item.label === '定位待复核')?.value === '0 处') {
        throw new Error(`Routebook recalculation did not reflect edited stop: ${JSON.stringify(saveData.routebook.metrics)}`);
      }

      const routeId = saveData.routebook.publicId;
      const { response: draftShareResponse } = await fetchJson(`${baseUrl}/api/share/${encodeURIComponent(routeId)}`);
      if (draftShareResponse.status !== 404) {
        throw new Error(`Draft share should be hidden, got HTTP ${draftShareResponse.status}`);
      }
      const { response: publishResponse, data: publishData } = await fetchJson(`${baseUrl}/api/routebooks/${encodeURIComponent(routeId)}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: SMOKE_PROFILE_ID,
          editToken: saveData.routebook.editToken,
          expectedVersion: saveData.routebook.version
        })
      });
      if (!publishResponse.ok || publishData.routebook?.publishStatus !== 'published') {
        throw new Error(`Routebook publish failed: ${JSON.stringify(publishData)}`);
      }
      const { response: shareResponse, data: shareData } = await fetchJson(`${baseUrl}/api/share/${encodeURIComponent(routeId)}`);
      if (!shareResponse.ok) throw new Error(`Share fetch failed: ${JSON.stringify(shareData)}`);
      if (shareData.routebook?.publicId !== routeId) {
        throw new Error(`Share publicId mismatch: ${JSON.stringify(shareData.share)}`);
      }

      const { response: archiveResponse, data: archiveData } = await fetchJson(`${baseUrl}/api/routebooks/${encodeURIComponent(routeId)}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-routebook-admin-token': SMOKE_ADMIN_TOKEN },
        body: JSON.stringify({
          publishStatus: 'archived',
          expectedVersion: publishData.routebook.version
        })
      });
      if (!archiveResponse.ok || archiveData.routebook?.publishStatus !== 'archived') {
        throw new Error(`Routebook archive failed: ${JSON.stringify(archiveData)}`);
      }
      const { response: archivedShareResponse } = await fetchJson(`${baseUrl}/api/share/${encodeURIComponent(routeId)}`);
      if (archivedShareResponse.status !== 404) {
        throw new Error(`Archived share should be hidden, got HTTP ${archivedShareResponse.status}`);
      }

      const productBody = {
        products: [
          {
            id: `smoke-product-${Date.now()}`,
            title: 'Smoke 商品卡',
            poi: data.stops[0].name,
            city: data.city,
            provider: 'smoke',
            type: '门票',
            price: '1 元',
            url: 'https://example.com/product',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      };
      const { response: productSaveResponse, data: productSaveData } = await fetchJson(`${baseUrl}/api/products`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-routebook-admin-token': SMOKE_ADMIN_TOKEN },
        body: JSON.stringify(productBody)
      });
      if (!productSaveResponse.ok || !productSaveData.products?.length) {
        throw new Error(`Product save failed: ${JSON.stringify(productSaveData)}`);
      }
      const { response: productGetResponse, data: productGetData } = await fetchJson(`${baseUrl}/api/products`);
      if (!productGetResponse.ok || productGetData.updatedAt !== productSaveData.updatedAt) {
        throw new Error(`Product GET should preserve updatedAt: ${JSON.stringify({ saved: productSaveData.updatedAt, read: productGetData.updatedAt })}`);
      }
      productConfigUpdatedAt = productGetData.updatedAt;

      const { response: cmsResponse, data: cmsData } = await fetchJson(`${baseUrl}/api/cms`);
      if (!cmsResponse.ok || !cmsData.config?.defaultCity) {
        throw new Error(`CMS fetch failed: ${JSON.stringify(cmsData)}`);
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            baseUrl,
            provider: health.provider,
            model: health.model,
            importedSourceTrust: importData.averageTrust,
            title: data.title,
            city: data.city,
            stops: data.stops.length,
            firstStop: {
              name: data.stops[0].name,
              lat: data.stops[0].lat,
              lng: data.stops[0].lng
            },
            trustScore: data.trustScore,
            shareUrl: `/share/${routeId}`,
            draftShareHidden: true,
            archivedShareHidden: true,
            productConfigUpdatedAt,
            recalculatedTrustScore: saveData.routebook.trustScore
          },
          null,
          2
        )
      );
    } finally {
      await fetchJson(`${baseUrl}/api/products`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-routebook-admin-token': SMOKE_ADMIN_TOKEN },
        body: JSON.stringify({ products: originalProductsData.products ?? [] })
      });
    }
  } catch (error) {
    if (childOutput.length) {
      console.error(childOutput.join('').trim());
    }
    throw error;
  } finally {
    if (child) child.kill('SIGTERM');
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

function isLocalBaseUrl(value) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function findAvailablePort(preferredPort) {
  const start = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : 0;
  if (start === 0) return probeAvailablePort(0);
  for (let offset = 0; offset < 50; offset += 1) {
    const candidate = start + offset;
    const available = await probeAvailablePort(candidate).catch(() => null);
    if (available) return available;
  }
  return probeAvailablePort(0);
}

function probeAvailablePort(port) {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once('error', rejectPort);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      server.close(() => resolvePort(resolvedPort));
    });
  });
}

// System/config API routes.
import { mkdir, writeFile } from 'node:fs/promises';
import { cities as supportedCities, getRegionForCity, isSupportedCity, regionCityGroups } from '../../src/lib/chinaCities.js';
import { redactBaseUrl } from '../ai/runtime.mjs';
import { normalizeCityName } from '../lib/util.mjs';
import { AMAP_GEOCODE_KEY, APP_ID, CMS_CONFIG_PATH, DATA_DIR, PRODUCT_CONFIG_PATH } from '../config/index.mjs';
import { verifyAdminAccess } from '../auth/request-access.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { route } from '../http/router.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { handleMapTile } from '../http/map-tiles.mjs';
import { loadCodexRuntime } from '../ai/generate.mjs';
import { normalizeCmsConfig, normalizeProductConfig, readCmsConfig, readProductConfig } from '../content/cms.mjs';
import { buildReadinessSnapshot } from '../http/health.mjs';

export const systemRoutes = [
  route('GET', '/api/map-tiles/*', async ({ req, res, url, params }) => {
      enforceRateLimit(req, 'map-tile');
      return await handleMapTile(req, res, url);
    }),
  route('GET', '/api/live', async ({ req, res, url, params }) => {
      return sendJson(res, 200, {
        ok: true,
        appId: APP_ID,
        live: true
      });
    }),
  route('GET', '/api/ready', async ({ req, res, url, params }) => {
      const readiness = await buildReadinessSnapshot();
      return sendJson(res, readiness.ready ? 200 : 503, readiness);
    }),
  route('GET', '/api/health', async ({ req, res, url, params }) => {
      const runtime = await loadCodexRuntime();
      return sendJson(res, 200, {
        ok: true,
        appId: APP_ID,
        provider: runtime.providerName,
        model: runtime.model,
        wireApi: runtime.wireApi,
        baseUrl: redactBaseUrl(runtime.baseUrl),
        ready: runtime.ready,
        reason: runtime.readyReason,
        geocoder: AMAP_GEOCODE_KEY ? 'amap' : 'disabled'
      });
    }),
  route('GET', '/api/cities', async ({ req, res, url, params }) => {
      enforceRateLimit(req, 'public-config');
      const rawQuery = String(url.searchParams.get('q') ?? '').trim();
      const query = rawQuery ? normalizeCityName(rawQuery) : '';
      const matches = !query
        ? supportedCities.slice(0, 80)
        : supportedCities.filter((city) => city.includes(query) || query.includes(city)).slice(0, 80);
      return sendJson(res, 200, {
        ok: true,
        total: supportedCities.length,
        regions: regionCityGroups,
        cities: matches,
        supported: isSupportedCity(query),
        region: getRegionForCity(query)
      });
    }),
  route('GET', '/api/cms', async ({ req, res, url, params }) => {
      enforceRateLimit(req, 'public-config');
      return sendJson(res, 200, {
        ok: true,
        config: await readCmsConfig()
      });
    }),
  route('POST', '/api/cms', async ({ req, res, url, params }) => {
      enforceRateLimit(req);
      verifyAdminAccess(req);
      const config = normalizeCmsConfig(await readJsonBody(req));
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(CMS_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      return sendJson(res, 200, { ok: true, config });
    }),
  route('GET', '/api/products', async ({ req, res, url, params }) => {
      enforceRateLimit(req, 'public-config');
      const config = await readProductConfig();
      return sendJson(res, 200, {
        ok: true,
        products: config.products,
        updatedAt: config.updatedAt
      });
    }),
  route('POST', '/api/products', async ({ req, res, url, params }) => {
      enforceRateLimit(req);
      verifyAdminAccess(req);
      const config = normalizeProductConfig(await readJsonBody(req), { strictUrl: true });
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(PRODUCT_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      return sendJson(res, 200, {
        ok: true,
        products: config.products,
        updatedAt: config.updatedAt
      });
    })
];

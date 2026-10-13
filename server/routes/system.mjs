// System/config API routes.
import { ALLOW_LOCAL_ADMIN_BYPASS, IS_PRODUCTION, AMAP_GEOCODE_KEY, APP_ID, CMS_CONFIG_PATH, PRODUCT_CONFIG_PATH } from '../config/index.mjs';
import { planningAccessState, hasAdminAccess, isLocalRequest, verifyAdminAccess } from '../auth/request-access.mjs';
import { writeConfigDocument } from '../storage/config-documents.mjs';
import { cities as allSupportedCities, getRegionForCity, isCityOpenForGeneration, regionCityGroups as allRegionCityGroups } from '../../src/lib/chinaCities.js';
import { GENERATION_REGION } from '../config/index.mjs';

const supportedCities = allSupportedCities.filter((city) => isCityOpenForGeneration(city, GENERATION_REGION));
const regionCityGroups = allRegionCityGroups
  .map((group) => ({ ...group, cities: group.cities.filter((city) => supportedCities.includes(city)) }))
  .filter((group) => group.cities.length);
const isSupportedCity = (city) => isCityOpenForGeneration(city, GENERATION_REGION);
import { redactBaseUrl } from '../ai/runtime.mjs';
import { normalizeCityName } from '../lib/util.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { NO_POI_CATALOG, route } from '../http/router.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { handleMapTile } from '../http/map-tiles.mjs';
import { loadCodexRuntime } from '../ai/generate.mjs';
import { normalizeCmsConfig, normalizeProductConfig, readCmsConfig, readProductConfig } from '../content/cms.mjs';
import { buildReadinessSnapshot } from '../http/health.mjs';

export const systemRoutes = [
  route(
    'GET',
    '/api/map-tiles/*',
    async ({ req, res, url }) => {
      enforceRateLimit(req, 'map-tile');
      return await handleMapTile(req, res, url);
    },
    NO_POI_CATALOG
  ),
  route(
    'GET',
    '/api/live',
    async ({ res }) => {
      return sendJson(res, 200, {
        ok: true,
        appId: APP_ID,
        live: true
      });
    },
    NO_POI_CATALOG
  ),
  route(
    'GET',
    '/api/ready',
    async ({ res }) => {
      const readiness = await buildReadinessSnapshot();
      return sendJson(res, readiness.ready ? 200 : 503, readiness);
    },
    NO_POI_CATALOG
  ),
  route(
    'GET',
    '/api/health',
    async ({ req, res }) => {
      const runtime = await loadCodexRuntime();
      // `ready` means "this caller can generate now": the model is configured AND the
      // caller has API access (a production deployment without the access code is not ready).
      const access = await planningAccessState(req);
      const ready = runtime.ready && access === 'open';
      const accessReason =
        access === 'needs-login'
          ? '登录后就能生成路书'
          : access === 'needs-access-code'
            ? '需要平台访问码：请在「高级设置」填写访问码'
            : access === 'disabled'
              ? '此部署暂未开放在线生成'
              : '';
      // L5: provider/model/base URL and the precise not-ready reason describe the
      // deployment's configuration; in production only operators get them.
      const detailed = !IS_PRODUCTION || (isLocalRequest(req) && ALLOW_LOCAL_ADMIN_BYPASS) || hasAdminAccess(req);
      if (!detailed) {
        return sendJson(res, 200, {
          ok: true,
          appId: APP_ID,
          ready,
          modelReady: runtime.ready,
          access,
          reason: !runtime.ready ? '模型服务暂未就绪，请稍后再试或联系运营人员' : accessReason
        });
      }
      return sendJson(res, 200, {
        ok: true,
        appId: APP_ID,
        provider: runtime.providerName,
        model: runtime.model,
        wireApi: runtime.wireApi,
        baseUrl: redactBaseUrl(runtime.baseUrl),
        ready,
        modelReady: runtime.ready,
        access,
        reason: !runtime.ready ? runtime.readyReason : accessReason,
        geocoder: AMAP_GEOCODE_KEY ? 'amap' : 'disabled'
      });
    },
    NO_POI_CATALOG
  ),
  route(
    'GET',
    '/api/cities',
    async ({ req, res, url }) => {
      enforceRateLimit(req, 'public-config');
      const rawQuery = String(url.searchParams.get('q') ?? '').trim();
      const query = rawQuery ? normalizeCityName(rawQuery) : '';
      const matches = !query ? supportedCities.slice(0, 80) : supportedCities.filter((city) => city.includes(query) || query.includes(city)).slice(0, 80);
      return sendJson(res, 200, {
        ok: true,
        total: supportedCities.length,
        regions: regionCityGroups,
        cities: matches,
        supported: isSupportedCity(query),
        region: getRegionForCity(query),
        openRegion: GENERATION_REGION
      });
    },
    NO_POI_CATALOG
  ),
  route('GET', '/api/cms', async ({ req, res }) => {
    enforceRateLimit(req, 'public-config');
    return sendJson(res, 200, {
      ok: true,
      config: await readCmsConfig()
    });
  }),
  route('POST', '/api/cms', async ({ req, res }) => {
    enforceRateLimit(req);
    verifyAdminAccess(req);
    const config = normalizeCmsConfig(await readJsonBody(req));
    await writeConfigDocument(CMS_CONFIG_PATH, config);
    return sendJson(res, 200, { ok: true, config });
  }),
  route('GET', '/api/products', async ({ req, res }) => {
    enforceRateLimit(req, 'public-config');
    const config = await readProductConfig();
    return sendJson(res, 200, {
      ok: true,
      products: config.products,
      updatedAt: config.updatedAt
    });
  }),
  route('POST', '/api/products', async ({ req, res }) => {
    enforceRateLimit(req);
    verifyAdminAccess(req);
    const config = normalizeProductConfig(await readJsonBody(req), { strictUrl: true });
    await writeConfigDocument(PRODUCT_CONFIG_PATH, config);
    return sendJson(res, 200, {
      ok: true,
      products: config.products,
      updatedAt: config.updatedAt
    });
  })
];

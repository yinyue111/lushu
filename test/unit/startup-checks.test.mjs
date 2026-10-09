import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEGACY_DEV_PROFILE_SECRET, evaluateStartupSafety, isLoopbackHost, resolveProfileIdSecret } from '../../server/config/startup-checks.mjs';

test('resolveProfileIdSecret keeps the legacy fallback order (stored hashes stay valid)', () => {
  assert.deepEqual(resolveProfileIdSecret({ profileIdSecret: 'explicit', adminToken: 'a', apiToken: 'b', isProduction: true }), {
    secret: 'explicit',
    source: 'explicit'
  });
  assert.deepEqual(resolveProfileIdSecret({ adminToken: 'a', apiToken: 'b', isProduction: true }), { secret: 'a', source: 'legacy-admin-token' });
  assert.deepEqual(resolveProfileIdSecret({ apiToken: 'b', isProduction: true }), { secret: 'b', source: 'legacy-api-token' });
  assert.deepEqual(resolveProfileIdSecret({ isProduction: false }), { secret: LEGACY_DEV_PROFILE_SECRET, source: 'dev-default' });
  assert.deepEqual(resolveProfileIdSecret({ isProduction: true }), { secret: '', source: 'missing' });
});

test('isLoopbackHost', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', '[::1]']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '']) assert.equal(isLoopbackHost(host), false, host);
});

const base = {
  host: '127.0.0.1',
  isProduction: true,
  allowLocalApiBypass: false,
  allowLocalAdminBypass: false,
  trustProxyHeaders: false,
  allowBypassOnPublicHost: false,
  profileSecretSource: 'explicit',
  publicBaseUrl: 'https://routebook.example'
};

test('evaluateStartupSafety: clean production config has no findings', () => {
  assert.deepEqual(evaluateStartupSafety(base), { errors: [], warnings: [] });
});

test('evaluateStartupSafety: production bypass on a public HOST refuses to start (M2)', () => {
  const result = evaluateStartupSafety({ ...base, host: '0.0.0.0', allowLocalAdminBypass: true });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /ALLOW_LOCAL_ADMIN_BYPASS/);
  const overridden = evaluateStartupSafety({ ...base, host: '0.0.0.0', allowLocalAdminBypass: true, allowBypassOnPublicHost: true });
  assert.equal(overridden.errors.length, 0);
  assert.equal(overridden.warnings.length, 1);
});

test('evaluateStartupSafety: dev bypass on a public HOST only warns', () => {
  const result = evaluateStartupSafety({
    ...base,
    isProduction: false,
    host: '0.0.0.0',
    allowLocalApiBypass: true,
    allowLocalAdminBypass: true,
    publicBaseUrl: ''
  });
  assert.equal(result.errors.length, 0);
  assert.match(result.warnings.join('\n'), /ALLOW_LOCAL_API_BYPASS \+ ALLOW_LOCAL_ADMIN_BYPASS/);
});

test('evaluateStartupSafety: legacy secret fallback is deprecated, missing secret is fatal', () => {
  const legacy = evaluateStartupSafety({ ...base, profileSecretSource: 'legacy-admin-token' });
  assert.equal(legacy.errors.length, 0);
  assert.match(legacy.warnings[0], /DEPRECATED.*ROUTEBOOK_ADMIN_TOKEN/);
  const missing = evaluateStartupSafety({ ...base, profileSecretSource: 'missing' });
  assert.match(missing.errors[0], /PROFILE_ID_SECRET must be set/);
  const devPublic = evaluateStartupSafety({ ...base, isProduction: false, host: '0.0.0.0', profileSecretSource: 'dev-default' });
  assert.match(devPublic.warnings.join('\n'), /forgeable/);
});

test('evaluateStartupSafety: production without PUBLIC_BASE_URL warns', () => {
  const result = evaluateStartupSafety({ ...base, publicBaseUrl: '' });
  assert.match(result.warnings.join('\n'), /PUBLIC_BASE_URL/);
});

test('production refuses OSM / keyless basemaps unless explicitly overridden; development allows them', () => {
  const osm = [{ id: 'osm-de' }, { id: 'osm-fr' }];
  const refused = evaluateStartupSafety({ ...base, mapTileProviders: osm });
  assert.ok(refused.errors.some((error) => error.includes('osm-de, osm-fr')));
  const overridden = evaluateStartupSafety({ ...base, mapTileProviders: osm, allowOsmBasemapInProduction: true });
  assert.ok(!overridden.errors.some((error) => error.includes('Basemap')));
  assert.ok(overridden.warnings.some((warning) => warning.includes('ALLOW_OSM_BASEMAP_IN_PRODUCTION')));
  assert.ok(!evaluateStartupSafety({ ...base, mapTileProviders: [{ id: 'tianditu', key: 'k' }] }).errors.some((error) => error.includes('Basemap')));
  assert.ok(evaluateStartupSafety({ ...base, mapTileProviders: [{ id: 'amap', key: '' }] }).errors.some((error) => error.includes('amap')));
  assert.ok(!evaluateStartupSafety({ ...base, mapTileProviders: [{ id: 'amap', key: 'k' }] }).errors.some((error) => error.includes('Basemap')));
  assert.ok(!evaluateStartupSafety({ ...base, isProduction: false, mapTileProviders: osm }).errors.some((error) => error.includes('Basemap')));
});

test('production warns (does not refuse) when the model region or moderation provider is not domestic', () => {
  const result = evaluateStartupSafety({ ...base, aiProviderRegion: '', moderationProvider: 'keyword' });
  assert.ok(result.warnings.some((warning) => warning.includes('AI_PROVIDER_REGION=unset')));
  assert.ok(result.warnings.some((warning) => warning.includes('MODERATION_PROVIDER=keyword')));
  assert.ok(!result.errors.some((error) => error.includes('AI_PROVIDER_REGION')));
  const domestic = evaluateStartupSafety({ ...base, aiProviderRegion: 'domestic', moderationProvider: 'domestic' });
  assert.ok(!domestic.warnings.some((warning) => warning.includes('AI_PROVIDER_REGION') || warning.includes('MODERATION_PROVIDER')));
});

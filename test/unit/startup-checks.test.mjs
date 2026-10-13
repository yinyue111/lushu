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

test('ADMIN_ENABLED in production refuses to start without CONFIG_ENC_KEY', () => {
  const missing = evaluateStartupSafety({ ...base, adminEnabled: true });
  assert.ok(missing.errors.some((e) => /ADMIN_ENABLED=true requires CONFIG_ENC_KEY/.test(e)));
  assert.ok(evaluateStartupSafety({ ...base, adminEnabled: true, configEncKey: 'short' }).errors.some((e) => /at least 32/.test(e)));
  const ok = evaluateStartupSafety({ ...base, adminEnabled: true, configEncKey: 'k'.repeat(32) });
  assert.ok(!ok.errors.some((e) => /CONFIG_ENC_KEY/.test(e)));
  assert.ok(!evaluateStartupSafety({ ...base, adminEnabled: false }).errors.some((e) => /CONFIG_ENC_KEY/.test(e)));
});

test('AI_MODEL_FALLBACK_ORDER: none is off, typos refuse to start', async () => {
  const { parseFallbackOrder } = await import('../../server/config/fallbackOrder.mjs');
  assert.deepEqual(parseFallbackOrder(undefined), { order: ['fast'], invalid: [] });
  assert.deepEqual(parseFallbackOrder('none'), { order: [], invalid: [] });
  assert.deepEqual(parseFallbackOrder('NONE'), { order: [], invalid: [] });
  assert.deepEqual(parseFallbackOrder('fast, deep'), { order: ['fast', 'deep'], invalid: [] });
  assert.deepEqual(parseFallbackOrder('fats'), { order: [], invalid: ['fats'] });
  assert.ok(evaluateStartupSafety({ ...base, aiModelFallbackOrder: 'fats' }).errors.some((e) => /AI_MODEL_FALLBACK_ORDER/.test(e)));
  assert.ok(evaluateStartupSafety({ ...base, isProduction: false, aiModelFallbackOrder: 'fast,x' }).errors.some((e) => /"x"/.test(e)));
  for (const value of [undefined, '', 'none', 'fast'])
    assert.ok(!evaluateStartupSafety({ ...base, aiModelFallbackOrder: value }).errors.some((e) => /AI_MODEL_FALLBACK_ORDER/.test(e)), String(value));
});

test('invite code never falls back to ROUTEBOOK_API_TOKEN', async () => {
  const { spawnSync } = await import('node:child_process');
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./server/config/index.mjs').then((m) => process.stdout.write(JSON.stringify(m.REGISTRATION_INVITE_CODE)))"],
    {
      env: { ...process.env, ROUTEBOOK_API_TOKEN: 'shared-access-code-123', REGISTRATION_INVITE_CODE: '' },
      encoding: 'utf8'
    }
  );
  assert.equal(out.stdout, '""', out.stderr);
});

test('REQUIRE_PINNED_IMAGE refuses a tag, accepts a digest', () => {
  const digest = `ghcr.io/o/lushu-app@sha256:${'a'.repeat(64)}`;
  for (const ref of ['ghcr.io/o/lushu-app:05c904f', 'ghcr.io/o/lushu-app:latest', '', 'x@sha256:short'])
    assert.ok(
      evaluateStartupSafety({ ...base, requirePinnedImage: true, imageRef: ref }).errors.some((e) => /pinned by digest/.test(e)),
      ref
    );
  assert.ok(!evaluateStartupSafety({ ...base, requirePinnedImage: true, imageRef: digest }).errors.some((e) => /pinned by digest/.test(e)));
  assert.ok(!evaluateStartupSafety({ ...base, imageRef: 'tag-only:1' }).errors.some((e) => /pinned by digest/.test(e)), 'off unless required');
});

test('invite mode with no usable invite code warns at startup', async () => {
  const { inviteStartupWarning } = await import('../../server/config/startup-checks.mjs');
  const now = Date.parse('2026-10-14T00:00:00Z');
  assert.match(inviteStartupWarning({ mode: 'invite', invites: [], now }), /nobody can register/);
  const dead = [{ revokedAt: '2026-10-01' }, { expiresAt: '2026-10-13T00:00:00Z' }, { used: 1, maxUses: 1 }];
  assert.match(inviteStartupWarning({ mode: 'invite', invites: dead, now }), /3 admin invite code\(s\), none active/);
  assert.equal(inviteStartupWarning({ mode: 'invite', invites: [...dead, { used: 0, maxUses: 5 }], now }), '');
  assert.equal(inviteStartupWarning({ mode: 'invite', envCode: 'abc', invites: [], now }), '');
  assert.equal(inviteStartupWarning({ mode: 'open', invites: [], now }), '');
  assert.match(inviteStartupWarning({ mode: 'invite', invites: null, now }), /could not be read/);
});

test('TRUSTED_PROXY_CIDRS in production: required, valid, inside the pinned subnet, gateway trusted', async () => {
  const { trustedProxyErrors } = await import('../../server/config/startup-checks.mjs');
  const net = { isProduction: true, trustProxyHeaders: true, networkSubnet: '172.31.80.0/24', networkGateway: '172.31.80.1' };
  const errs = (cidrs, extra = {}) => trustedProxyErrors({ ...net, trustedProxyCidrs: cidrs, ...extra });
  assert.deepEqual(errs('172.31.80.1,127.0.0.1,::1'), []);
  assert.deepEqual(errs('172.31.80.0/24,::1'), []);
  assert.match(errs(undefined)[0], /requires TRUSTED_PROXY_CIDRS/);
  assert.match(errs(' , ')[0], /requires TRUSTED_PROXY_CIDRS/);
  assert.ok(errs('172.31.80.1,not-an-ip').some((e) => /invalid entries \["not-an-ip"\]/.test(e)));
  assert.ok(errs('172.31.80.1,10.0.0.0/33').some((e) => /invalid/.test(e)));
  assert.ok(errs('0.0.0.0/0').some((e) => /must not trust 0.0.0.0\/0/.test(e)));
  assert.ok(errs('172.17.0.1,127.0.0.1').some((e) => /outside APP_NETWORK_SUBNET/.test(e)));
  assert.ok(errs('172.31.80.5,127.0.0.1').some((e) => /does not include the network gateway 172.31.80.1/.test(e)));
  assert.ok(errs('127.0.0.1', { networkSubnet: '172.31.80.0' }).some((e) => /not an IPv4 CIDR/.test(e)));
  assert.ok(errs('172.31.80.1', { networkGateway: '10.0.0.1' }).some((e) => /APP_NETWORK_GATEWAY/.test(e)));
  // No pinned network (npm start behind a local Caddy): loopback only is fine.
  assert.deepEqual(trustedProxyErrors({ isProduction: true, trustProxyHeaders: true, trustedProxyCidrs: '127.0.0.1,::1' }), []);
  // Not production, or not behind a proxy: not checked.
  assert.deepEqual(trustedProxyErrors({ ...net, isProduction: false, trustedProxyCidrs: '' }), []);
  assert.deepEqual(trustedProxyErrors({ ...net, trustProxyHeaders: false, trustedProxyCidrs: '' }), []);
});

test('PROXY_MODE=host|container: which hop must (and must not) be trusted', async () => {
  const { trustedProxyErrors } = await import('../../server/config/startup-checks.mjs');
  const net = { isProduction: true, trustProxyHeaders: true, networkSubnet: '172.31.80.0/24', networkGateway: '172.31.80.1' };
  const host = (cidrs, extra = {}) => trustedProxyErrors({ ...net, trustedProxyCidrs: cidrs, ...extra });
  const ctr = (cidrs, caddyIp = '172.31.80.10', extra = {}) =>
    trustedProxyErrors({ ...net, proxyMode: 'container', caddyIp, trustedProxyCidrs: cidrs, ...extra });
  // host (default and explicit, case-insensitive): unchanged behaviour.
  assert.deepEqual(host('172.31.80.1,127.0.0.1,::1'), []);
  assert.deepEqual(host('172.31.80.1,127.0.0.1,::1', { proxyMode: 'host' }), []);
  assert.deepEqual(host('172.31.80.1,127.0.0.1,::1', { proxyMode: ' HOST ' }), []);
  assert.ok(host('127.0.0.1,::1', { proxyMode: 'host' }).some((e) => /does not include the network gateway/.test(e)));
  // The P1 config (Caddy container .4 while only the gateway is trusted) cannot be expressed in host mode silently:
  assert.ok(host('172.31.80.1,127.0.0.1', { caddyIp: '172.31.80.4' }).some((e) => /CADDY_IP is set .* but PROXY_MODE=host/.test(e)));
  assert.match(host('172.31.80.1', { proxyMode: 'sidecar' })[0], /PROXY_MODE="sidecar" must be host or container/);
  // container: good configs.
  assert.deepEqual(ctr('172.31.80.10,127.0.0.1,::1'), []);
  assert.deepEqual(ctr('172.31.80.10/32'), []);
  assert.deepEqual(ctr('172.31.80.10', '172.31.80.10', { proxyMode: 'Container' }), []);
  // container: CADDY_IP missing / invalid / outside subnet / a range / the gateway.
  assert.ok(ctr('127.0.0.1', '').some((e) => /requires CADDY_IP/.test(e)));
  assert.ok(ctr('127.0.0.1', 'caddy').some((e) => /requires CADDY_IP/.test(e)));
  assert.ok(ctr('10.0.0.4', '10.0.0.4').some((e) => /requires CADDY_IP .* inside APP_NETWORK_SUBNET/.test(e)));
  assert.ok(ctr('172.31.80.0/28', '172.31.80.0/28').some((e) => /single IPv4 address/.test(e)));
  assert.ok(ctr('172.31.80.1', '172.31.80.1').some((e) => /must not be the network gateway/.test(e)));
  // container: trust list misses Caddy, still trusts the gateway (the P1 config), or is broader than Caddy.
  assert.ok(ctr('127.0.0.1,::1').some((e) => /does not include CADDY_IP 172.31.80.10/.test(e)));
  const p1 = ctr('172.31.80.1,127.0.0.1,::1', '172.31.80.4');
  assert.ok(p1.some((e) => /does not include CADDY_IP 172.31.80.4/.test(e)));
  assert.ok(p1.some((e) => /must not include the network gateway 172.31.80.1/.test(e)));
  assert.ok(ctr('172.31.80.10,172.31.80.1').some((e) => /must not include the network gateway/.test(e)));
  const wide = ctr('172.31.80.0/24');
  assert.ok(wide.some((e) => /must not include the network gateway/.test(e)));
  assert.ok(wide.some((e) => /may only contain CADDY_IP .* not \["172.31.80.0\/24"\]/.test(e)));
  assert.ok(ctr('172.31.80.10,172.31.80.20').some((e) => /may only contain CADDY_IP/.test(e)));
  assert.ok(ctr('172.31.80.10,10.0.0.5').some((e) => /outside APP_NETWORK_SUBNET/.test(e)));
  assert.ok(ctr('0.0.0.0/0').some((e) => /must not trust 0.0.0.0\/0/.test(e)));
  // container needs the pinned subnet to check anything.
  assert.ok(
    trustedProxyErrors({
      isProduction: true,
      trustProxyHeaders: true,
      proxyMode: 'container',
      caddyIp: '172.31.80.10',
      trustedProxyCidrs: '172.31.80.10'
    }).some((e) => /requires APP_NETWORK_SUBNET/.test(e))
  );
  // Not production / not behind a proxy: not checked, whatever the mode.
  assert.deepEqual(ctr('', '', { isProduction: false }), []);
  assert.deepEqual(ctr('', '', { trustProxyHeaders: false }), []);
});

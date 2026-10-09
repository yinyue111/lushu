import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../helpers/server.mjs';

function routingKey(env) {
  const script = "const c = await import('./server/config/index.mjs'); process.stdout.write(JSON.stringify(c.AMAP_ROUTING_KEY));";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PROJECT_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', ...env },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('an empty AMAP_ROUTING_KEY= line falls back to the geocode key (prod regression)', () => {
  assert.equal(routingKey({ AMAP_GEOCODE_KEY: 'geo-key', AMAP_ROUTING_KEY: '' }), 'geo-key');
  assert.equal(routingKey({ AMAP_GEOCODE_KEY: 'geo-key' }), 'geo-key');
  assert.equal(routingKey({ AMAP_GEOCODE_KEY: 'geo-key', AMAP_ROUTING_KEY: 'route-key' }), 'route-key');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KNOWN_PLACEHOLDER_TILE_HASHES,
  describeMapTileProviders,
  isPlaceholderTile,
  looksLikeImage,
  resolveMapTileProviders
} from '../../server/http/map-providers.mjs';

const ids = (env) => resolveMapTileProviders(env).providers.map((item) => item.id);

test('map providers: keyless default is the OSM mirrors (CARTO is gone)', () => {
  assert.deepEqual(ids({}), ['osm-de', 'osm-fr']);
});

test('map providers: 天地图 is preferred automatically when TIANDITU_KEY is set', () => {
  assert.deepEqual(ids({ TIANDITU_KEY: 'k' }), ['tianditu', 'osm-de', 'osm-fr']);
});

test('map providers: explicit list, unknown ids and missing keys are skipped', () => {
  const result = resolveMapTileProviders({ MAP_TILE_PROVIDERS: 'tianditu, nope, osm-fr' });
  assert.deepEqual(
    result.providers.map((item) => item.id),
    ['osm-fr']
  );
  assert.deepEqual(
    result.skipped.map((item) => item.id),
    ['tianditu', 'nope']
  );
});

test('map providers: GCJ-02 高德 is never mixed with WGS-84 fallbacks', () => {
  const result = resolveMapTileProviders({ MAP_TILE_PROVIDERS: 'amap,osm-de' });
  assert.deepEqual(
    result.providers.map((item) => item.id),
    ['amap']
  );
  assert.equal(describeMapTileProviders(result.providers).coordinateSystem, 'gcj02');
});

test('map providers: the public description never leaks keys', () => {
  const { providers } = resolveMapTileProviders({ TIANDITU_KEY: 'secret-tk-123' });
  const described = describeMapTileProviders(providers);
  assert.equal(described.provider, 'tianditu');
  assert.equal(described.labels, true);
  assert.doesNotMatch(JSON.stringify(described), /secret-tk-123/);
  assert.match(providers[0].path({ z: 3, x: 6, y: 3, key: '3/6/3' }, 'base', 'secret-tk-123'), /LAYER=vec&.*TILEMATRIX=3&TILEROW=3&TILECOL=6&tk=secret-tk-123/);
  assert.match(providers[0].path({ z: 3, x: 6, y: 3, key: '3/6/3' }, 'labels', 'k'), /^\/cva_w\//);
});

test('placeholder detection: known hashes and tiles identical to the world tile', () => {
  const carto = [...KNOWN_PLACEHOLDER_TILE_HASHES][0];
  assert.equal(isPlaceholderTile({ hash: carto, z: 1 }), true);
  assert.equal(isPlaceholderTile({ hash: 'aaa', z: 13, referenceHash: 'aaa' }), true);
  assert.equal(isPlaceholderTile({ hash: 'aaa', z: 13, referenceHash: 'bbb' }), false);
  assert.equal(isPlaceholderTile({ hash: 'aaa', z: 1, referenceHash: 'aaa' }), false);
  assert.equal(isPlaceholderTile({ hash: 'aaa', z: 13, referenceHash: null }), false);
});

test('placeholder detection: HTML error bodies are not images', () => {
  assert.equal(looksLikeImage(Buffer.from('<html>API KEY REQUIRED</html>')), false);
  assert.equal(looksLikeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), true);
  assert.equal(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), true);
});

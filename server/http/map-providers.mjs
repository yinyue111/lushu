// Basemap providers for the /api/map-tiles proxy.
//
// The provider list is ordered: the proxy tries each one in turn and falls back
// to the next on errors, timeouts or placeholder tiles. Providers are chosen with
// MAP_TILE_PROVIDERS (comma separated ids); without it we use 天地图 when
// TIANDITU_KEY is set and the keyless OpenStreetMap mirrors otherwise.
//
// Route coordinates are stored in WGS-84. 天地图 and OSM use WGS-84-compatible
// tiles; 高德 tiles are GCJ-02, so a provider list never mixes the two systems
// (the browser shifts markers to GCJ-02 when the active provider needs it).

/**
 * @typedef {{ z: number, x: number, y: number, key: string }} TileRequest
 * @typedef {'base' | 'labels'} TileLayer
 * @typedef {{
 *   id: string,
 *   label: string,
 *   attribution: string,
 *   coordinateSystem: 'wgs84' | 'gcj02',
 *   maxZoom: number,
 *   hasLabels: boolean,
 *   keyEnv?: string,
 *   keyRequired?: boolean,
 *   hostname: (tile: TileRequest) => string,
 *   path: (tile: TileRequest, layer: TileLayer, key: string) => string
 * }} MapTileProviderSpec
 * @typedef {MapTileProviderSpec & { key: string }} MapTileProvider
 */

const tiandituPath = (layerName) => (/** @type {TileRequest} */ tile, /** @type {string} */ key) =>
  `/${layerName}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layerName}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles` +
  `&TILEMATRIX=${tile.z}&TILEROW=${tile.y}&TILECOL=${tile.x}&tk=${encodeURIComponent(key)}`;

/** @type {Record<string, MapTileProviderSpec>} */
export const MAP_TILE_PROVIDER_CATALOG = {
  tianditu: {
    id: 'tianditu',
    label: '天地图',
    attribution: '© 天地图',
    coordinateSystem: 'wgs84',
    maxZoom: 18,
    hasLabels: true,
    keyEnv: 'TIANDITU_KEY',
    keyRequired: true,
    hostname: (tile) => `t${(tile.x + tile.y) % 8}.tianditu.gov.cn`,
    path: (tile, layer, key) => (layer === 'labels' ? tiandituPath('cva')(tile, key) : tiandituPath('vec')(tile, key))
  },
  amap: {
    id: 'amap',
    label: '高德地图',
    attribution: '© 高德地图',
    coordinateSystem: 'gcj02',
    maxZoom: 18,
    hasLabels: false,
    keyEnv: 'AMAP_TILE_KEY',
    keyRequired: false,
    hostname: (tile) => `webrd0${((tile.x + tile.y) % 4) + 1}.is.autonavi.com`,
    path: (tile, _layer, key) =>
      `/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tile.x}&y=${tile.y}&z=${tile.z}${key ? `&key=${encodeURIComponent(key)}` : ''}`
  },
  'osm-de': {
    id: 'osm-de',
    label: 'OpenStreetMap',
    attribution: '© OpenStreetMap 贡献者',
    coordinateSystem: 'wgs84',
    maxZoom: 18,
    hasLabels: false,
    hostname: () => 'tile.openstreetmap.de',
    path: (tile) => `/${tile.key}.png`
  },
  'osm-fr': {
    id: 'osm-fr',
    label: 'OpenStreetMap HOT',
    attribution: '© OpenStreetMap 贡献者',
    coordinateSystem: 'wgs84',
    maxZoom: 19,
    hasLabels: false,
    hostname: () => 'a.tile.openstreetmap.fr',
    path: (tile) => `/hot/${tile.key}.png`
  },
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    attribution: '© OpenStreetMap 贡献者',
    coordinateSystem: 'wgs84',
    maxZoom: 19,
    hasLabels: false,
    hostname: () => 'tile.openstreetmap.org',
    path: (tile) => `/${tile.key}.png`
  }
};

export const DEFAULT_KEYLESS_PROVIDERS = ['osm-de', 'osm-fr'];

/**
 * Resolves the ordered provider list from environment variables.
 * @param {Record<string, string | undefined>} env
 * @returns {{ providers: MapTileProvider[], skipped: { id: string, reason: string }[] }}
 */
export function resolveMapTileProviders(env) {
  const requested = String(env.MAP_TILE_PROVIDERS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const tiandituKey = String(env.TIANDITU_KEY ?? '').trim();
  const order = requested.length ? requested : [...(tiandituKey ? ['tianditu'] : []), ...DEFAULT_KEYLESS_PROVIDERS];
  /** @type {MapTileProvider[]} */
  const providers = [];
  /** @type {{ id: string, reason: string }[]} */
  const skipped = [];
  for (const id of order) {
    const spec = MAP_TILE_PROVIDER_CATALOG[id];
    if (!spec) {
      skipped.push({ id, reason: 'unknown provider' });
      continue;
    }
    if (providers.some((item) => item.id === id)) continue;
    const key = spec.keyEnv ? String(env[spec.keyEnv] ?? '').trim() : '';
    if (spec.keyRequired && !key) {
      skipped.push({ id, reason: `${spec.keyEnv} is not set` });
      continue;
    }
    if (providers.length && providers[0].coordinateSystem !== spec.coordinateSystem) {
      skipped.push({ id, reason: `coordinate system ${spec.coordinateSystem} differs from ${providers[0].id}` });
      continue;
    }
    providers.push({ ...spec, key });
  }
  if (!providers.length) {
    for (const id of DEFAULT_KEYLESS_PROVIDERS) providers.push({ ...MAP_TILE_PROVIDER_CATALOG[id], key: '' });
  }
  return { providers, skipped };
}

/**
 * Public, key-free description of the active basemap for the browser.
 * @param {MapTileProvider[]} providers
 */
export function describeMapTileProviders(providers) {
  const primary = providers[0];
  const attributions = [...new Set(providers.map((item) => item.attribution))];
  return {
    provider: primary.id,
    label: primary.label,
    coordinateSystem: primary.coordinateSystem,
    labels: primary.hasLabels,
    maxZoom: Math.min(...providers.map((item) => item.maxZoom)),
    attribution: attributions.join(' / '),
    fallbacks: providers.slice(1).map((item) => item.id)
  };
}

// Bodies some providers return with HTTP 200 instead of a real tile (sha256).
export const KNOWN_PLACEHOLDER_TILE_HASHES = new Set([
  // CARTO basemaps "API KEY REQUIRED" image (2049 bytes), returned for every z/x/y since 2026.
  '69be4aecf9f814ba45d585801a5aa41e79b16fc88eafec5b1954a9f06a69e6be'
]);

/**
 * A real tile at zoom >= 3 is never byte-identical to the provider's world tile
 * (0/0/0). Placeholder images ("API KEY REQUIRED", "no access") are identical
 * for every coordinate, so this catches unknown placeholders too.
 * @param {{ hash: string, z: number, referenceHash?: string | null }} input
 */
export function isPlaceholderTile({ hash, z, referenceHash }) {
  if (KNOWN_PLACEHOLDER_TILE_HASHES.has(hash)) return true;
  return z >= 3 && Boolean(referenceHash) && hash === referenceHash;
}

/**
 * Checks magic bytes so HTML/XML error pages served as 200 are rejected.
 * @param {Buffer} body
 */
export function looksLikeImage(body) {
  if (!body || body.length < 8) return false;
  const png = body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47;
  const jpeg = body[0] === 0xff && body[1] === 0xd8;
  const webp = body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP';
  return png || jpeg || webp;
}

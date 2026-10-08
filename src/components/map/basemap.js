// Shared Leaflet basemap: reads /api/map-tiles/config once, adds the proxied
// base layer (plus 天地图 注记 when available) and converts WGS-84 route
// coordinates for GCJ-02 providers (高德) so markers line up with the tiles.
import L from 'leaflet';

/** @typedef {{ provider: string, coordinateSystem: 'wgs84' | 'gcj02', labels: boolean, maxZoom: number, attribution: string }} BasemapConfig */

/** @type {BasemapConfig} */
const FALLBACK_CONFIG = { provider: 'osm-de', coordinateSystem: 'wgs84', labels: false, maxZoom: 18, attribution: '© OpenStreetMap 贡献者' };
/** @type {Promise<BasemapConfig> | null} */
let configPromise = null;
/** @type {BasemapConfig} */
let resolvedConfig = FALLBACK_CONFIG;

/** @returns {Promise<BasemapConfig>} */
export function loadBasemapConfig() {
  if (!configPromise) {
    configPromise = fetch('/api/map-tiles/config', { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : FALLBACK_CONFIG))
      .then((data) => {
        resolvedConfig = {
          provider: String(data?.provider || FALLBACK_CONFIG.provider),
          coordinateSystem: data?.coordinateSystem === 'gcj02' ? 'gcj02' : 'wgs84',
          labels: Boolean(data?.labels),
          maxZoom: Number(data?.maxZoom) || FALLBACK_CONFIG.maxZoom,
          attribution: String(data?.attribution || FALLBACK_CONFIG.attribution)
        };
        return resolvedConfig;
      })
      .catch(() => FALLBACK_CONFIG);
  }
  return configPromise;
}

/** Last known config (synchronous; falls back to WGS-84 OSM until loaded). */
export function currentBasemapConfig() {
  return resolvedConfig;
}

/**
 * Adds the basemap to a Leaflet map and reports tile health.
 * @param {L.Map} map
 * @param {{ onStatus?: (message: string) => void, onConfig?: (config: BasemapConfig) => void }} [options]
 * @returns {() => void} cleanup
 */
export function addBasemap(map, options = {}) {
  const { onStatus, onConfig } = options;
  let disposed = false;
  /** @type {L.TileLayer[]} */
  const layers = [];
  loadBasemapConfig().then((config) => {
    if (disposed) return;
    let hadTileError = false;
    const base = L.tileLayer('/api/map-tiles/{z}/{x}/{y}.png', {
      maxZoom: config.maxZoom,
      errorTileUrl: '',
      updateWhenIdle: true,
      keepBuffer: 2,
      attribution: escapeHtml(config.attribution)
    });
    base.on('loading', () => onStatus?.('地图加载中…'));
    base.on('load', () => onStatus?.(hadTileError ? '部分地图没加载出来，不影响查看站点和导航。' : ''));
    base.on('tileerror', () => {
      hadTileError = true;
      onStatus?.('地图暂时加载不了，可以继续看站点列表和使用导航。');
    });
    base.addTo(map);
    layers.push(base);
    if (config.labels) {
      const labels = L.tileLayer('/api/map-tiles/labels/{z}/{x}/{y}.png', {
        maxZoom: config.maxZoom,
        errorTileUrl: '',
        updateWhenIdle: true,
        pane: 'overlayPane'
      });
      labels.addTo(map);
      layers.push(labels);
    }
    onConfig?.(config);
  });
  return () => {
    disposed = true;
    layers.forEach((layer) => layer.remove());
    onStatus?.('');
  };
}

/**
 * Route data is WGS-84; shift to GCJ-02 when the basemap uses it.
 * @param {number} lat
 * @param {number} lng
 * @param {BasemapConfig} [config]
 * @returns {[number, number]}
 */
export function toMapLatLng(lat, lng, config = resolvedConfig) {
  if (config.coordinateSystem !== 'gcj02' || outOfChina(lat, lng)) return [lat, lng];
  return wgs84ToGcj02(lat, lng);
}

const A = 6378245.0;
const EE = 0.006693421622965943;

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/** @returns {[number, number]} */
export function wgs84ToGcj02(lat, lng) {
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

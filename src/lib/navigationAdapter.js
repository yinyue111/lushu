// 跨端统一导航描述层：Web 端输出高德 URI，微信小程序 / App 端直接消费 miniProgramLocation 调用 wx.openLocation。
import { amapNameSearchUrl, isNavigableCoordinate } from './coordinates.js';

/**
 * @param {any} stop
 * @param {string} [city]
 * @param {string} [mode]
 */
export function buildStopNavigationDescriptor(stop, city = '', mode = 'walk') {
  const cleanName = String(stop?.name ?? '').trim() || '目的地';
  const cleanCity = String(city || stop?.city || '').trim();
  const navigable = isNavigableCoordinate(stop);

  if (!navigable) {
    return {
      navigable: false,
      webUrl: amapNameSearchUrl(stop, cleanCity),
      miniProgramLocation: null
    };
  }

  const lat = Number(stop.lat);
  const lng = Number(stop.lng);
  const effectiveMode = ['walk', 'car', 'bus'].includes(mode) ? mode : 'walk';
  return {
    navigable: true,
    webUrl: `https://uri.amap.com/navigation?to=${lng},${lat},${encodeURIComponent(cleanName)}&mode=${effectiveMode}&src=trusted-routebook&coordinate=wgs84&callnative=1`,
    miniProgramLocation: {
      latitude: lat,
      longitude: lng,
      name: cleanName,
      address: String(stop?.area || cleanCity || cleanName),
      coordinateSystem: stop?.coordinateSystem || 'WGS84'
    }
  };
}

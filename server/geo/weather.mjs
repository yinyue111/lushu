// Lightweight near-term city weather lookup via AMap Weather API (reuses AMAP_GEOCODE_KEY).
// Never fabricates weather: returns { available: false, forecasts: [] } when unconfigured or unreachable.
import { AMAP_GEOCODE_KEY } from '../config/index.mjs';
import { normalizeCityName, truncateString } from '../lib/util.mjs';

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();
let testFetcher = null;

export function setWeatherFetcherForTests(fn) {
  testFetcher = fn;
  cache.clear();
}

export async function fetchCityWeatherForecast(rawCity, signal) {
  const city = normalizeCityName(rawCity);
  if (!city) return { available: false, city: '', forecasts: [] };

  const now = Date.now();
  const cached = cache.get(city);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  if (!testFetcher && !AMAP_GEOCODE_KEY) {
    return { available: false, city, forecasts: [] };
  }

  try {
    let payload;
    if (testFetcher) {
      payload = await testFetcher(city, signal);
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      signal?.addEventListener('abort', () => controller.abort(), { once: true });
      try {
        const params = new URLSearchParams({
          key: AMAP_GEOCODE_KEY,
          city,
          extensions: 'all',
          output: 'JSON'
        });
        const res = await fetch(`https://restapi.amap.com/v3/weather/weatherInfo?${params.toString()}`, {
          signal: controller.signal
        });
        if (!res.ok) return { available: false, city, forecasts: [] };
        payload = await res.json();
      } finally {
        clearTimeout(timer);
      }
    }

    const casts = payload?.forecasts?.[0]?.casts;
    if (!Array.isArray(casts) || !casts.length) {
      return { available: false, city, forecasts: [] };
    }

    const forecasts = casts.slice(0, 4).map((cast) => {
      const dayweather = truncateString(cast?.dayweather, 24);
      const nightweather = truncateString(cast?.nightweather, 24);
      return {
        date: truncateString(cast?.date, 16),
        dayweather,
        nightweather,
        daytemp: truncateString(cast?.daytemp, 8),
        nighttemp: truncateString(cast?.nighttemp, 8),
        rainy: /雨|雪|雷|雹|台风/.test(`${dayweather}${nightweather}`)
      };
    });

    const value = {
      available: true,
      city,
      updatedAt: new Date(now).toISOString(),
      forecasts
    };
    cache.set(city, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch {
    return { available: false, city, forecasts: [] };
  }
}

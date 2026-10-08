import { Coffee, Landmark, Mountain, ShoppingBag, Sparkles, TreePine, Utensils, Waves, Building2, Moon, Palette } from 'lucide-react';
import { cityStories, defaultCityImage } from '../../lib/content';

// Day colours (direction B): each day owns a two-stop gradient used by day cards,
// map ribbons, numbered pins and day pills. Day N > 5 cycles.
export const DAY_THEMES = [
  { solid: '#e8553d', ink: '#c7432d', from: '#e8553d', to: '#ff9a3c' },
  { solid: '#1f7ae0', ink: '#1666c1', from: '#1f7ae0', to: '#3fc1f0' },
  { solid: '#1e9e6a', ink: '#157a51', from: '#1e9e6a', to: '#9bd24a' },
  { solid: '#7c5cdb', ink: '#6446c4', from: '#7c5cdb', to: '#c07cf0' },
  { solid: '#d9822b', ink: '#9a5512', from: '#d9822b', to: '#ffc93c' }
];

export function dayTheme(index) {
  const i = Number.isFinite(index) && index >= 0 ? index : 0;
  return DAY_THEMES[i % DAY_THEMES.length];
}

export function dayNumber(day, fallbackIndex = 0) {
  const match = String(day ?? '').match(/\d+/);
  return match ? Number(match[0]) : fallbackIndex + 1;
}

// Real city photography bundled in /public/assets (no hotlinking). Only trusted
// cities get photo covers; other cities fall back to a typographic gradient.
const CITY_GALLERY = {
  杭州: ['/assets/hangzhou-west-lake.webp', '/assets/hangzhou-tea.webp', '/assets/old-street.webp', '/assets/local-food.webp'],
  上海: ['/assets/shanghai-street.webp', '/assets/shanghai-bund.webp', '/assets/shanghai-skyline.webp', '/assets/local-food.webp'],
  苏州: ['/assets/suzhou-garden.webp', '/assets/suzhou-water-town.webp', '/assets/old-street.webp', '/assets/local-food.webp']
};

export function cityCover(city) {
  const story = cityStories[city];
  if (story?.image) return story.image;
  return CITY_GALLERY[city]?.[0] ?? null;
}

/** Atmosphere photo for a day card; null for cities without bundled photography. */
export function dayCover(city, index) {
  const gallery = CITY_GALLERY[city];
  if (!gallery?.length) return null;
  return gallery[index % gallery.length];
}

export function hasCityPhotos(city) {
  return Boolean(CITY_GALLERY[city]);
}

export const GENERIC_COVER = defaultCityImage;

// Category inference for stops without photos: gradient tile + lucide icon.
const CATEGORIES = [
  { id: 'night', label: '夜游', test: /夜|灯光|喷泉|酒吧|夜市/, icon: Moon, from: '#2b3a67', to: '#7c5cdb' },
  { id: 'museum', label: '展馆', test: /馆|展|博物|美术|书店|剧场|艺术|画廊/, icon: Palette, from: '#7c5cdb', to: '#c07cf0' },
  { id: 'tea', label: '茶咖', test: /茶|咖啡|甜品|cafe|coffee/i, icon: Coffee, from: '#8a5a2b', to: '#d9a35b' },
  { id: 'food', label: '吃喝', test: /餐|饭|小吃|面|美食|食堂|酒楼|火锅|夜宵/, icon: Utensils, from: '#e8553d', to: '#ffb04a' },
  { id: 'temple', label: '寺庙', test: /寺|庙|塔|教堂|道观|祠/, icon: Landmark, from: '#c7432d', to: '#ffc93c' },
  { id: 'water', label: '湖河', test: /湖|江|河|溪|湿地|水|桥|堤|港|海|滩/, icon: Waves, from: '#1f7ae0', to: '#3fc1f0' },
  { id: 'mountain', label: '山野', test: /山|峰|岭|村|谷/, icon: Mountain, from: '#1e9e6a', to: '#9bd24a' },
  { id: 'garden', label: '园林', test: /园|林|公园|植物|花/, icon: TreePine, from: '#157a51', to: '#5cc48d' },
  { id: 'shopping', label: '逛街', test: /商场|银泰|购物|市集|广场|中心/, icon: ShoppingBag, from: '#d9822b', to: '#ffc93c' },
  { id: 'street', label: '街巷', test: /街|路|巷|弄|里|坊|古镇|老街/, icon: Building2, from: '#5c6370', to: '#a3a9b5' }
];
const FALLBACK_CATEGORY = { id: 'spot', label: '地点', icon: Sparkles, from: '#e8553d', to: '#1f7ae0' };

export function stopCategory(stop) {
  const text = `${stop?.name ?? ''} ${stop?.area ?? ''}`;
  return CATEGORIES.find((item) => item.test.test(text)) ?? CATEGORIES.find((item) => item.test.test(`${stop?.verify ?? ''}`)) ?? FALLBACK_CATEGORY;
}

/** A real photo for the stop, only when the data actually carries one. */
export function stopPhoto(stop) {
  const candidate = stop?.image || stop?.photo || stop?.photoUrl || stop?.coverImage;
  if (typeof candidate !== 'string') return null;
  const url = candidate.trim();
  // Only same-origin assets or uploaded check-in photos; never hotlink third-party images.
  return url.startsWith('/') && !url.startsWith('//') ? url : null;
}

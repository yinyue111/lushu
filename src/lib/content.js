const IMAGE_CACHE_VERSION = '20260731';
const localImage = (path) => `${path}?v=${IMAGE_CACHE_VERSION}`;

export const trustedCities = ['杭州', '上海', '苏州'];

export const cityStories = {
  杭州: {
    city: '杭州',
    kicker: '西湖、寺院、茶山与夜游',
    headline: '把收藏夹里的杭州周末，排成一条真的能走完的路',
    summary: '适合第一次来杭州的朋友、情侣和轻松 Citywalk 用户。核心判断是少绕路、避开高峰、把茶歇和夜景留到体力最合适的时间。',
    seasonNotes: [{ months: [6, 7], text: '梅雨季优先室内茶馆与湖滨短线' }],
    image: localImage('/assets/hangzhou-west-lake.webp'),
    palette: 'warm'
  },
  上海: {
    city: '上海',
    kicker: '街区漫游、展览、咖啡与夜景',
    headline: '从武康路走到安福路，不再被同款攻略带着绕圈',
    summary: '适合半日到一日的街区漫游。把拍照、咖啡、展览和晚餐放在同一条动线上，减少来回折返。',
    seasonNotes: [{ months: [7, 8], text: '暴晒天气建议午后进展馆' }],
    image: localImage('/assets/shanghai-street.webp'),
    palette: 'urban'
  },
  苏州: {
    city: '苏州',
    kicker: '园林、平江路、评弹与夜游',
    headline: '园林不赶场，平江路不踩点，晚上还能顺路看水巷',
    summary: '适合周末轻旅行和亲子慢游。重点核对门票、闭园时间、排队和晚间回酒店动线。',
    seasonNotes: [{ months: [7, 8], text: '暑期建议上午园林、傍晚水巷' }],
    image: localImage('/assets/suzhou-garden.webp'),
    palette: 'garden'
  }
};

export const curatedRoutes = [
  {
    id: 'hangzhou-westlake-tea',
    city: '杭州',
    title: '西湖晨线 + 法喜寺 + 龙井茶歇',
    subtitle: '2 天 1 晚 · 松弛但不空 · 情侣/朋友',
    tags: ['少绕路', '拍照', '茶歇'],
    image: localImage('/assets/hangzhou-tea.webp'),
    summary: '上午把西湖核心段走完，中午避开湖边人流，下午进寺院和茶山，夜晚回到湖滨。',
    stops: [
      {
        day: 'Day 1',
        time: '09:30',
        name: '柳浪闻莺',
        area: '西湖东南',
        stay: '60 分钟',
        cost: '免费',
        verify: '编辑建议：清晨进入湖区，给后续行程留出缓冲',
        risk: '雨天湖边拍照效果下降',
        score: 88,
        lat: 30.242,
        lng: 120.1617
      },
      {
        day: 'Day 1',
        time: '11:00',
        name: '南宋御街',
        area: '上城',
        stay: '90 分钟',
        cost: '80-120 元',
        verify: '餐饮选择多，适合作为午餐缓冲',
        risk: '部分店铺同质化，建议只选 1 家',
        score: 80,
        lat: 30.2432,
        lng: 120.1696
      },
      {
        day: 'Day 1',
        time: '15:00',
        name: '北山街日落线',
        area: '西湖北线',
        stay: '75 分钟',
        cost: '免费',
        verify: '编辑建议：把北线放在傍晚，减少正午暴晒',
        risk: '节假日骑行和车流偏密',
        score: 86,
        lat: 30.2596,
        lng: 120.1472
      },
      {
        day: 'Day 2',
        time: '09:30',
        name: '法喜寺',
        area: '西湖西南',
        stay: '90 分钟',
        cost: '10 元',
        verify: '编辑建议：寺院与茶山安排在同一天，减少跨区折返',
        risk: '开放时间与排队情况需出发前复核',
        score: 84,
        lat: 30.2366,
        lng: 120.0954
      },
      {
        day: 'Day 2',
        time: '12:00',
        name: '龙井茶园',
        area: '龙井',
        stay: '120 分钟',
        cost: '120-220 元',
        verify: '编辑建议：预留茶歇时段并确认具体体验门店',
        risk: '需警惕高价茶叶推销',
        score: 78,
        lat: 30.2248,
        lng: 120.1032
      },
      {
        day: 'Day 2',
        time: '15:30',
        name: '茅家埠',
        area: '西湖西线',
        stay: '75 分钟',
        cost: '免费',
        verify: '比核心湖区更适合慢走',
        risk: '雨天道路湿滑',
        score: 83,
        lat: 30.2468,
        lng: 120.1139
      }
    ]
  },
  {
    id: 'shanghai-wukang-anfu',
    city: '上海',
    title: '武康路到安福路半日 Citywalk',
    subtitle: '1 日 · 少走路 · 拍照/咖啡/展览',
    tags: ['街区', '咖啡', '展览'],
    image: localImage('/assets/shanghai-street.webp'),
    summary: '从武康路低强度进入街区，午后把咖啡和小展馆串起来，傍晚转向安福路晚餐。',
    stops: [
      {
        day: 'Day 1',
        time: '10:00',
        name: '武康路',
        area: '徐汇',
        stay: '80 分钟',
        cost: '免费',
        verify: '编辑建议：上午从街区北段开始，按相邻道路步行',
        risk: '热门机位排队影响体验',
        score: 84,
        lat: 31.2123,
        lng: 121.4382
      },
      {
        day: 'Day 1',
        time: '12:00',
        name: '安福路',
        area: '徐汇',
        stay: '90 分钟',
        cost: '100-180 元',
        verify: '餐饮和咖啡密度高',
        risk: '周末午餐等位较久',
        score: 82,
        lat: 31.217,
        lng: 121.4431
      },
      {
        day: 'Day 1',
        time: '15:00',
        name: '上海展览中心',
        area: '静安',
        stay: '90 分钟',
        cost: '0-100 元',
        verify: '编辑建议：作为室内备选，使用前确认当日展览',
        risk: '展览档期需提前复核',
        score: 78,
        lat: 31.2264,
        lng: 121.4512
      }
    ]
  },
  {
    id: 'suzhou-pingjiang-garden',
    city: '苏州',
    title: '平江路 + 园林 + 夜游水巷',
    subtitle: '1 日 · 亲子/朋友 · 慢节奏',
    tags: ['园林', '夜游', '亲子'],
    image: localImage('/assets/suzhou-water-town.webp'),
    summary: '上午进园林，下午平江路慢走，晚上只保留一段水巷，避免一天塞太满。',
    stops: [
      {
        day: 'Day 1',
        time: '09:30',
        name: '拙政园',
        area: '姑苏',
        stay: '120 分钟',
        cost: '80 元',
        verify: '编辑建议：上午先进入园林，避开下午行程堆叠',
        risk: '旺季门票和人流需复核',
        score: 82,
        lat: 31.3243,
        lng: 120.6252
      },
      {
        day: 'Day 1',
        time: '13:30',
        name: '平江路',
        area: '姑苏',
        stay: '120 分钟',
        cost: '80-160 元',
        verify: '餐饮和评弹选择多',
        risk: '商业街同质化较强',
        score: 78,
        lat: 31.3156,
        lng: 120.6314
      },
      {
        day: 'Day 1',
        time: '19:00',
        name: '山塘街',
        area: '姑苏',
        stay: '90 分钟',
        cost: '免费',
        verify: '编辑建议：只保留一段夜游作为当日收尾',
        risk: '返程打车高峰需预留时间',
        score: 81,
        lat: 31.3267,
        lng: 120.6004
      }
    ]
  }
];

export const inspirationPhotos = [
  { city: '杭州', poi: '西湖', title: '西湖日落', source: '目的地图片', image: localImage('/assets/hangzhou-west-lake.webp') },
  { city: '杭州', poi: '龙井茶园', title: '茶山晨雾', source: '目的地图片', image: localImage('/assets/hangzhou-tea.webp') },
  { city: '上海', poi: '陆家嘴', title: '浦江天际线', source: '目的地图片', image: localImage('/assets/shanghai-skyline.webp') },
  { city: '上海', poi: '外滩', title: '城市水岸', source: '目的地图片', image: localImage('/assets/shanghai-bund.webp') },
  { city: '苏州', poi: '平江路', title: '江南水巷', source: '目的地图片', image: localImage('/assets/suzhou-water-town.webp') },
  { city: '苏州', poi: '姑苏古城', title: '园林与假山', source: '目的地图片', image: localImage('/assets/suzhou-garden.webp') }
];

export const productCards = [
  {
    type: '本地玩乐',
    title: '柳浪闻莺西湖 Citywalk 讲解',
    poi: '柳浪闻莺',
    targetPoi: '柳浪闻莺',
    city: '杭州',
    price: '前往平台查看价格',
    provider: '携程本地玩乐',
    url: 'https://m.ctrip.com/webapp/you/thingstodo/list?keyword=%E8%A5%BF%E6%B9%96%20Citywalk',
    linkType: 'search',
    deepLinkStatus: 'search_fallback',
    analyticsStatus: 'not_collected'
  },
  {
    type: '本地玩乐',
    title: '龙井茶园采茶炒茶体验',
    poi: '龙井茶园',
    targetPoi: '龙井茶园',
    city: '杭州',
    price: '前往平台查看价格',
    provider: '飞猪旅行',
    url: 'https://h5.fliggy.com/search.html?q=%E9%BE%99%E4%BA%95%E8%8C%B6%E5%9B%AD%E4%BD%93%E9%AA%8C',
    linkType: 'search',
    deepLinkStatus: 'search_fallback',
    analyticsStatus: 'not_collected'
  },
  {
    type: '门票',
    title: '拙政园门票预订入口',
    poi: '拙政园',
    targetPoi: '拙政园',
    city: '苏州',
    price: '前往平台查看价格',
    provider: '携程门票',
    url: 'https://m.ctrip.com/webapp/ticket/dest/t140508.html',
    linkType: 'destination_listing',
    deepLinkStatus: 'listing_fallback',
    analyticsStatus: 'not_collected'
  },
  {
    type: '本地玩乐',
    title: '平江路评弹茶馆体验',
    poi: '平江路',
    targetPoi: '平江路',
    city: '苏州',
    price: '前往平台查看价格',
    provider: '美团',
    url: 'https://www.meituan.com/s/%E5%B9%B3%E6%B1%9F%E8%B7%AF/',
    linkType: 'search',
    deepLinkStatus: 'search_fallback',
    analyticsStatus: 'not_collected'
  },
  {
    type: '讲解',
    title: '武康路建筑漫步讲解',
    poi: '武康路',
    targetPoi: '武康路',
    city: '上海',
    price: '前往平台查看价格',
    provider: '携程本地玩乐',
    url: 'https://m.ctrip.com/webapp/you/thingstodo/list?keyword=%E6%AD%A6%E5%BA%B7%E8%B7%AF%20Citywalk',
    linkType: 'search',
    deepLinkStatus: 'search_fallback',
    analyticsStatus: 'not_collected'
  },
  {
    type: '酒店区域',
    title: '杭州湖滨银泰周边住宿',
    poi: '湖滨银泰',
    targetPoi: '湖滨银泰',
    city: '杭州',
    price: '前往平台查看价格',
    provider: '高德酒店区域',
    url: 'https://ditu.amap.com/search?query=%E6%9D%AD%E5%B7%9E%E6%B9%96%E6%BB%A8%E9%85%92%E5%BA%97',
    linkType: 'search',
    deepLinkStatus: 'search_fallback',
    analyticsStatus: 'not_collected'
  }
];

export const defaultCityImage = localImage('/assets/city-aerial.webp');

export const DEFAULT_SEASON_NOTE = '标出要提前确认的开放时间和预约';

/**
 * F21: seasonal copy is month-scoped; outside its months we fall back to a
 * neutral reminder instead of showing e.g. 梅雨季 in October.
 * @param {{ season?: string, seasonNotes?: { months: number[], text: string }[] }} story
 */
export function seasonNoteFor(story, date = new Date()) {
  if (story?.season) return story.season;
  const month = date.getMonth() + 1;
  const note = (story?.seasonNotes ?? []).find((item) => item.months.includes(month));
  return note?.text ?? DEFAULT_SEASON_NOTE;
}

export function getCityStory(city) {
  if (cityStories[city]) return cityStories[city];
  return {
    city,
    // 没有核对过资料的城市：不编城市介绍，只说清楚是 AI 草稿。
    kicker: `${city} · 按你的攻略排`,
    headline: `把${city}攻略，排成按天走的路书`,
    summary: `${city}还没有精选路线和核对过的地点资料。AI 只按你粘贴的攻略和偏好排路线，地点和营业时间出发前要自己确认。`,
    season: 'AI 草稿：地点、营业时间和导航出发前要自己确认',
    image: defaultCityImage,
    palette: 'generic'
  };
}

export function getCityRoutes(city) {
  return curatedRoutes.filter((route) => route.city === city);
}

export function getCityPhotos(city) {
  const photos = inspirationPhotos.filter((photo) => photo.city === city);
  if (photos.length) return photos;
  return [
    { city, poi: `${city}核心商圈`, title: '城市第一站', source: '通用灵感', image: localImage('/assets/city-aerial.webp') },
    { city, poi: `${city}老街/街区`, title: '步行路线线索', source: '通用灵感', image: localImage('/assets/old-street.webp') },
    { city, poi: `${city}本地美食`, title: '餐饮缓冲点', source: '通用灵感', image: localImage('/assets/local-food.webp') }
  ];
}

export function curatedRouteToRoutebook(route) {
  return {
    id: route.id,
    publicId: route.id,
    city: route.city,
    title: route.title,
    summary: route.summary,
    // 精选路线视为已上架的公开内容：分享预览可直接派生 /share/publicId 复制与系统分享，
    // 但仍不允许用户对精选路线执行「发布」。
    publishStatus: 'featured',
    trustScore: null,
    trustMeta: {
      source: 'prediction',
      sampleCount: 0,
      displayScore: null,
      label: '编辑样板 · 待实地核对'
    },
    days: [...new Set(route.stops.map((stop) => stop.day))],
    stops: route.stops.map((stop, index) => ({
      id: index + 1,
      geoConfidence: 70,
      coordinateSystem: 'WGS84',
      coordinateSource: 'editorial-template',
      coordinatePrecision: 'poi',
      ...stop,
      // 服务端只对精选路线里真实存在的站名承认这个来源（server/trust/provenance.mjs）。
      provenance: { origin: 'editorial', name: stop.name }
    })),
    assets: route.tags.map((tag) => ({ label: tag, type: '主题', confidence: 82 })),
    validations: [
      { id: 'verification', label: '实地核对', state: '待打卡', detail: '这是编辑样板，尚无足够有效 GPS 到达样本，执行后会根据真实反馈更新。' },
      { id: 'walk', label: '步行强度', state: '待复核', detail: '站点按相邻片区编排，实际步行与交通时间需按出行日地图复核。' },
      { id: 'budget', label: '预算风险', state: '可控', detail: '餐饮和体验点保留价格区间，现场消费需二次确认。' },
      { id: 'crowd', label: '拥挤风险', state: '需错峰', detail: '热门 POI 建议上午或傍晚执行。' }
    ],
    metrics: [
      { label: '真实打卡', value: '待核对' },
      { label: '主线完成率', value: '待核对' },
      { label: '来源状态', value: '编辑样板' }
    ],
    logs: [],
    provider: {
      name: 'curation',
      model: 'ops-template',
      generatedAt: new Date().toISOString()
    }
  };
}

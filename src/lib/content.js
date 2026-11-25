const IMAGE_CACHE_VERSION = '20260731';
const localImage = (path) => `${path}?v=${IMAGE_CACHE_VERSION}`;

export const trustedCities = ['杭州', '上海', '苏州', '南京'];

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
  },
  南京: {
    city: '南京',
    kicker: '钟山、秦淮河、博物院与老城南漫游',
    headline: '把博物院、梧桐大道和老门东排顺，不再跨城来回折返',
    summary: '适合两日人文漫游。重点提前核对南京博物院等热门场馆预约放票与周一闭馆时间。',
    seasonNotes: [{ months: [10, 11], text: '秋日梧桐季建议早间进钟山片区' }],
    image: localImage('/assets/old-street.webp'),
    palette: 'warm'
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
  },
  {
    id: 'nanjing-museum-qinhuai',
    city: '南京',
    title: '博物院 + 古鸡鸣寺 + 老门东夜秦淮',
    subtitle: '2 天 1 晚 · 人文不绕路 · 朋友/亲子',
    tags: ['人文', '少绕路', '夜游'],
    image: localImage('/assets/old-street.webp'),
    summary: '第一天把城东南京博物院与鸡鸣寺城墙走顺，第二天慢逛老门东街巷并在秦淮河畔收尾。',
    stops: [
      {
        day: 'Day 1',
        time: '09:30',
        name: '南京博物院',
        area: '钟山片区',
        stay: '150 分钟',
        cost: '免费',
        verify: '周一闭馆，需提前在官方公众号预约',
        risk: '节假日名额紧张，建议提前放票日锁定',
        score: 89,
        lat: 32.0405,
        lng: 118.8244
      },
      {
        day: 'Day 1',
        time: '14:30',
        name: '鸡鸣寺',
        area: '玄武湖畔',
        stay: '90 分钟',
        cost: '10 元',
        verify: '编辑建议：游览后可顺路登台城段明城墙远眺玄武湖',
        risk: '春季樱花季与周末香客较多',
        score: 85,
        lat: 32.0608,
        lng: 118.7953
      },
      {
        day: 'Day 2',
        time: '10:30',
        name: '老门东',
        area: '秦淮老城南',
        stay: '120 分钟',
        cost: '免费',
        verify: '编辑建议：金陵小吃集中，适合把早午餐放在这里慢逛',
        risk: '网红小吃店午间可能排队',
        score: 84,
        lat: 32.0135,
        lng: 118.7867
      },
      {
        day: 'Day 2',
        time: '18:00',
        name: '夫子庙秦淮风光带',
        area: '秦淮河',
        stay: '90 分钟',
        cost: '免费',
        verify: '编辑建议：傍晚亮灯后沿河散步即可，游船视现场排队决定',
        risk: '节假日核心商业街人流密集',
        score: 82,
        lat: 32.0206,
        lng: 118.7885
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
  { city: '苏州', poi: '姑苏古城', title: '园林与假山', source: '目的地图片', image: localImage('/assets/suzhou-garden.webp') },
  { city: '南京', poi: '老门东', title: '城南街巷与梧桐', source: '目的地图片', image: localImage('/assets/old-street.webp') }
];

export const defaultCityImage = localImage('/assets/city-aerial.webp');

export const DEFAULT_SEASON_NOTE = '开放时间、预约，出发前帮你标好';

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
    transport: '公交地铁 + 步行',
    constraints: { transport: '公交地铁 + 步行' },
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
      geoConfidence: 88,
      coordinateSystem: 'WGS84',
      coordinateSource: 'known-poi',
      coordinatePrecision: 'exact',
      ...stop,
      // 服务端只对精选路线里真实存在的站名承认这个来源（server/trust/provenance.mjs）。
      provenance: { origin: 'editorial', name: stop.name, reviewedPoi: true }
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

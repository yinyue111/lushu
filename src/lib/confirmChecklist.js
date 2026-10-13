// 「出发前要确认的事」：把每站的待确认拆成能一键去查的条目。
// 「我知道了」只是用户的提醒勾选，不是核实：界面上和「已核实（有来源）」严格区分。
import { amapNameSearchUrl, isNavigableCoordinate } from './coordinates.js';
import { costDisplay, unifyPendingWording } from './cost.js';

export const CONFIRM_GROUPS = [
  { kind: 'reservation', label: '要预约' },
  { kind: 'price', label: '门票 / 价格' },
  { kind: 'hours', label: '开放时间' },
  { kind: 'position', label: '位置' },
  { kind: 'note', label: '其他' }
];

const NEGATED_RESERVATION = /(不需|无需|不用|免)(要)?(提前)?(实名)?预约/;
const webSearch = (q) => `https://www.baidu.com/s?${new URLSearchParams({ wd: q })}`;

/**
 * @param {any} stop
 * @param {{ city?: string, checked?: { price?: boolean, hours?: boolean } }} [opts]
 * @returns {{ key: string, kind: string, label: string, detail: string, action: { label: string, url: string } }[]}
 */
export function confirmItemsForStop(stop, { city = '', checked = {} } = {}) {
  const name = String(stop?.name ?? '').trim();
  if (!name) return [];
  const id = String(stop?.id ?? name);
  const notes = unifyPendingWording(`${stop?.verify ?? ''}；${stop?.risk ?? ''}`);
  const items = [];
  const add = (kind, label, detail, action) => items.push({ key: `${id}:${kind}`, kind, label, detail, action });
  const cityName = String(city || stop?.city || '').trim();
  const sentences = notes
    .split(/[；;。\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  // 「营业时间、价格和是否要预约都待确认」这种一句话列一串的兜底句不当细节用，免得每条都重复同一句。
  const said = (re) => (sentences.find((t) => re.test(t) && !/是否|待确认/.test(t)) || '').slice(0, 60);
  const used = new Set();
  const take = (re) => {
    const t = said(re);
    if (t) used.add(t.slice(0, 60));
    return t;
  };

  if (!isNavigableCoordinate(stop)) {
    add('position', '位置没核准', '地图上没找到准确位置，别直接导航', { label: '在高德按名字搜', url: amapNameSearchUrl(stop, cityName) });
  }
  if (/预约/.test(notes) && !NEGATED_RESERVATION.test(notes)) {
    const unsure =
      /是否(?:要|需要|需)?(?:提前)?预约/.test(notes) && !/(?:需|要|须)(?:提前)?(?:实名)?预约/.test(notes.replace(/是否(?:要|需要|需)?(?:提前)?预约/g, ''));
    add('reservation', unsure ? '是否要预约' : '可能要预约', take(/预约/) || '看官方公众号或官网的预约入口', {
      label: '搜官方预约',
      url: webSearch(`${cityName}${name} 预约 官方`)
    });
  }
  const price = costDisplay(stop);
  if (price.pending && !checked.price) {
    add('price', '门票 / 价格', price.aiNote || '还没查到有来源的价格', { label: '搜官方票价', url: webSearch(`${cityName}${name} 门票 官网`) });
  }
  if (!checked.hours && /(开放|营业)时间|闭馆|休息日|几点/.test(notes)) {
    add('hours', '开放时间', take(/(开放|营业)时间|闭馆|休息日|几点/) || '出发当天看一眼，节假日可能调整', {
      label: '在高德看营业时间',
      url: amapNameSearchUrl(stop, cityName)
    });
  }
  // 其余具体的提醒（排队、限流、天气相关的安排等）；「以现场为准」「出发前复核」这类兜底句不再单独占一条。
  const GENERIC =
    /^(?:请)?(?:以(?:现场|当日公告|官方)(?:信息)?为准|(?:需)?(?:出发前)?(?:再)?(?:复核|核对|确认)(?:一下)?|.{0,8}待确认|刚换的店.*|需通过真实打卡.*|.*继续验证)$/;
  const rest = sentences.filter((t) => !used.has(t.slice(0, 60)) && !GENERIC.test(t) && !/价格|门票|票价|预约|(开放|营业)时间/.test(t));
  if (rest.length) add('note', '出发前留意', rest.join('；').slice(0, 80), { label: '搜一下', url: webSearch(`${cityName}${name}`) });
  return items;
}

/** 按类别分组，供「今天出发前要确认的事」汇总。 */
/** 只写了「X待确认」这类兜底的提醒，单独显示没有信息量（行中页的黄框也用它过滤）。 */
export function isGenericPending(text) {
  const t = String(text ?? '').trim();
  return !t || /^[^，。；;]{0,8}待确认[。]?$/.test(t) || /^(?:请)?以(?:现场|当日公告|官方)(?:信息)?为准[。]?$/.test(t);
}

export function groupConfirmItems(entries) {
  return CONFIRM_GROUPS.map((group) => ({ ...group, items: entries.filter((entry) => entry.item.kind === group.kind) })).filter((g) => g.items.length);
}

const ACK_PREFIX = 'lushu:confirm-ack:';
export function readAcks(routeId) {
  try {
    return new Set(JSON.parse(globalThis.localStorage?.getItem(ACK_PREFIX + routeId) || '[]'));
  } catch {
    return new Set();
  }
}
export function writeAcks(routeId, acks) {
  try {
    globalThis.localStorage?.setItem(ACK_PREFIX + routeId, JSON.stringify([...acks].slice(-200)));
  } catch {
    // storage full / private mode: the tick just won't persist
  }
}

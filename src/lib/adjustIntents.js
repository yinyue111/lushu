/**
 * L3: map short Chinese utterances to L1/L2 intents. Never auto-applies — UI must confirm.
 */

/**
 * @param {string} text
 * @param {{ days?: string[], stopNames?: string[] }} [ctx]
 * @returns {{ kind: string, confidence: number, label: string, params: Record<string, any>, level: 'L1'|'L2'|'L4' } | null}
 */
export function parseAdjustIntent(text, ctx = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const days = ctx.days ?? [];
  const names = ctx.stopNames ?? [];

  const strip = /去掉|删除|不要|砍掉/.test(raw) && /补充|路书补|AI.?加|模型/.test(raw);
  if (strip) {
    return { kind: 'strip_model', confidence: 0.9, label: '去掉 AI 加的站', params: {}, level: 'L1' };
  }

  const dayMatch = raw.match(/(?:第\s*([一二三四五六七八九十\d]+)\s*天|Day\s*(\d+))/i);
  const dayIndex = dayMatch ? parseDayToken(dayMatch[1] || dayMatch[2]) : -1;
  const day = dayIndex >= 0 ? days[dayIndex] || `Day ${dayIndex + 1}` : null;

  if (/砍|删|去掉/.test(raw) && (/天|日/.test(raw) || day) && !/站/.test(raw)) {
    return {
      kind: 'delete_day',
      confidence: day ? 0.85 : 0.6,
      label: day ? `删除 ${day}` : '删除某一天',
      params: { day },
      level: 'L1'
    };
  }

  if (/合并/.test(raw) && days.length >= 2) {
    return {
      kind: 'merge_days',
      confidence: 0.7,
      label: `把 ${days[1]} 并进 ${days[0]}`,
      params: { fromDay: days[1], toDay: days[0] },
      level: 'L1'
    };
  }

  if (/少走路|少步行/.test(raw)) {
    return { kind: 'mode_reorder', confidence: 0.88, label: '按「少走路」规则重排', params: { mode: '少走路' }, level: 'L1' };
  }
  if (/雨天|下雨/.test(raw)) {
    return { kind: 'mode_reorder', confidence: 0.88, label: '按「雨天」规则重排', params: { mode: '雨天' }, level: 'L1' };
  }
  if (/低预算|省钱|便宜/.test(raw)) {
    return { kind: 'mode_reorder', confidence: 0.85, label: '按「低预算」规则重排', params: { mode: '低预算' }, level: 'L1' };
  }
  if (/亲子|带娃|小孩/.test(raw)) {
    return { kind: 'mode_reorder', confidence: 0.85, label: '按「亲子」规则重排', params: { mode: '亲子' }, level: 'L1' };
  }

  if (/地铁|公交|公共交通/.test(raw) && /优先|改成|换成|为主/.test(raw)) {
    return { kind: 'set_transport_pref', confidence: 0.8, label: '交通改为地铁/公交优先', params: { mode: 'transit' }, level: 'L1' };
  }
  if (/打车|自驾|开车/.test(raw) && /优先|改成|换成/.test(raw)) {
    return { kind: 'set_transport_pref', confidence: 0.75, label: '交通改为打车/驾车', params: { mode: 'driving' }, level: 'L1' };
  }

  const named = names.find((name) => name && raw.includes(name));
  if (named && (/换成|换掉|替换|不要去|别去/.test(raw) || /换一家/.test(raw))) {
    return {
      kind: 'replace_stop',
      confidence: 0.8,
      label: `换掉「${named}」`,
      params: { stopName: named, query: raw.replace(new RegExp(named, 'g'), '').replace(/换成|换掉|替换|不要去|别去|换一家/g, '').trim() || named },
      level: 'L1'
    };
  }

  if ((/重排|重生成|再排|重新安排|AI/.test(raw) || /细品|轻快/.test(raw)) && (day || /这一天|当天|今天/.test(raw))) {
    return {
      kind: 'patch_day',
      confidence: 0.78,
      label: day ? `让 AI 重排 ${day}` : '让 AI 重排某一天',
      params: { day, mode: /细品|deep/.test(raw) ? 'deep' : 'fast' },
      level: 'L2'
    };
  }

  if (/整本|全部重|从头|重新生成路书|复制并定制/.test(raw)) {
    return { kind: 'full_regen', confidence: 0.85, label: '重新生成整条路书', params: {}, level: 'L4' };
  }

  if (/撤销|悔棋|上一步/.test(raw)) {
    return { kind: 'undo', confidence: 0.9, label: '撤销上一步', params: {}, level: 'L1' };
  }

  return {
    kind: 'unknown',
    confidence: 0.2,
    label: '没太听懂。可以试试：少走路、删掉第二天、换掉某个地方、去掉 AI 加的站',
    params: {},
    level: 'L1'
  };
}

function parseDayToken(token) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (/^\d+$/.test(token)) return Math.max(0, Number(token) - 1);
  if (map[token]) return map[token] - 1;
  return -1;
}

/**
 * L3: map short or natural-language Chinese utterances to deterministic L1 actions
 * (free, instant, undoable) or L2 AI itinerary adjustments (single-day or whole-book Diff preview).
 * Never silently mutates — UI always confirms or previews Diff first.
 */

function shortInstructionPreview(raw) {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 26 ? `${oneLine.slice(0, 26)}…` : oneLine;
}

/**
 * @param {string} text
 * @param {{ days?: string[], stopNames?: string[], activeDay?: string }} [ctx]
 * @returns {{ kind: string, confidence: number, label: string, params: Record<string, any>, level: 'L1'|'L2'|'L4' } | null}
 */
export function parseAdjustIntent(text, ctx = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const days = ctx.days ?? [];
  const names = [...(ctx.stopNames ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);

  const meaningfulChars = raw.replace(/[^\p{L}\p{N}]/gu, '');
  if (meaningfulChars.length < 2) {
    return {
      kind: 'unknown',
      confidence: 0.2,
      label: '再多说一点想怎么改，比如：少走路、删掉某站、加一家本帮菜、按住宿顺路重排',
      params: {},
      level: 'L1'
    };
  }

  if (/^(?:撤销|悔棋|上一步|撤回)$/.test(raw)) {
    return { kind: 'undo', confidence: 0.95, label: '撤销上一步', params: {}, level: 'L1' };
  }

  const strip = /去掉|删除|不要|砍掉/.test(raw) && /补充|路书补|AI.?加|模型/.test(raw) && raw.length <= 20;
  if (strip) {
    return { kind: 'strip_model', confidence: 0.9, label: '去掉 AI 加的站', params: {}, level: 'L1' };
  }

  if (/(?:整本|全部)重(?:新)?生成|从头(?:重做|再来|生成)|重新生成(?:整条)?路书|回创建页重做|复制并定制/.test(raw)) {
    return { kind: 'full_regen', confidence: 0.88, label: '回创建页重新生成整条路书', params: {}, level: 'L4' };
  }

  const dayTokens = [...raw.matchAll(/(?:第\s*([一二三四五六七八九十\d]+)\s*天|Day\s*(\d+))/gi)];
  const explicitLastDay = /最后一天/.test(raw) && days.length > 0 ? days[days.length - 1] : null;
  const firstDayIdx = dayTokens.length ? parseDayToken(dayTokens[0][1] || dayTokens[0][2]) : -1;
  const day =
    firstDayIdx >= 0
      ? days[firstDayIdx] || `Day ${firstDayIdx + 1}`
      : explicitLastDay || (/这一天|当天|今天/.test(raw) ? ctx.activeDay || days[0] || 'Day 1' : null);

  const named = names.find((name) => raw.includes(name));

  // L1: move an existing stop to another day ("把法喜寺移到第二天")
  if (named && day && /移到|挪到|放到|改到|调到|安排到|换到/.test(raw) && raw.length <= 28) {
    return {
      kind: 'move_stop_day',
      confidence: 0.9,
      label: `把「${named}」移到 ${day}`,
      params: { stopName: named, day },
      level: 'L1'
    };
  }

  // L1: replace a specific stop via POI search ("把宽窄巷子换成茶馆")
  if (named && (/换成|换掉|替换/.test(raw) || /换一家/.test(raw)) && raw.length <= 26) {
    return {
      kind: 'replace_stop',
      confidence: 0.85,
      label: `换掉「${named}」`,
      params: {
        stopName: named,
        query:
          raw
            .replace(new RegExp(escapeRegExp(named), 'g'), '')
            .replace(/把|将|换成|换掉|替换成?|换一家|[，,。.\s]/g, '')
            .trim() || named
      },
      level: 'L1'
    };
  }

  // L1: remove a specific stop ("删掉法喜寺" / "不去丝绸博物馆") when no extra complex follow-up is attached
  const restAfterNamed = named ? raw.replace(new RegExp(escapeRegExp(named), 'g'), '').replace(/[「」『』"'，,。.\s]/g, '') : '';
  if (named && /删掉|删除|去掉|不去|不要去|别去|砍掉|取消/.test(raw) && restAfterNamed.length <= 6) {
    return {
      kind: 'remove_stop',
      confidence: 0.9,
      label: `删掉「${named}」`,
      params: { stopName: named },
      level: 'L1'
    };
  }

  // L1: delete a whole day ("删掉第二天")
  if (
    /^(?:把)?(?:第\s*[一二三四五六七八九十\d]+\s*天|Day\s*\d+|最后一天|这一天)?\s*(?:砍掉|删掉|删除|去掉)\s*(?:第\s*[一二三四五六七八九十\d]+\s*天|Day\s*\d+|最后一天|这一天)?$/i.test(
      raw
    ) &&
    day
  ) {
    return {
      kind: 'delete_day',
      confidence: 0.88,
      label: `删除 ${day}`,
      params: { day },
      level: 'L1'
    };
  }

  if (/合并/.test(raw) && days.length >= 2 && raw.length <= 18) {
    return {
      kind: 'merge_days',
      confidence: 0.78,
      label: `把 ${days[1]} 并进 ${days[0]}`,
      params: { fromDay: days[1], toDay: days[0] },
      level: 'L1'
    };
  }

  const isModeSwitchVerb = /(?:换成|改成|切到|切换成?)\s*(?:雨天|少走路|少步行|室内|低预算|省钱|亲子|带娃)/.test(raw);
  const hasComplexAddOrReplace = /加一|加个|新增|塞进|推荐|顺便去/.test(raw) || (!isModeSwitchVerb && /换成|替换/.test(raw)) || Boolean(named);
  if (!hasComplexAddOrReplace && raw.length <= 34) {
    if (/少走路|少步行|不想走太多路/.test(raw)) {
      return { kind: 'mode_reorder', confidence: 0.9, label: '按「少走路」规则重排（保留饭点与车站衔接）', params: { mode: '少走路' }, level: 'L1' };
    }
    if (/雨天|下雨|室内备选|室内方案/.test(raw)) {
      return { kind: 'mode_reorder', confidence: 0.9, label: '按「雨天」规则重排（保留饭点与车站衔接）', params: { mode: '雨天' }, level: 'L1' };
    }
    if (/低预算|省钱|便宜点/.test(raw)) {
      return { kind: 'mode_reorder', confidence: 0.88, label: '按「低预算」规则重排（保留饭点与车站衔接）', params: { mode: '低预算' }, level: 'L1' };
    }
    if (/亲子|带娃|带小孩/.test(raw)) {
      return { kind: 'mode_reorder', confidence: 0.88, label: '按「亲子」规则重排（保留饭点与车站衔接）', params: { mode: '亲子' }, level: 'L1' };
    }
  }

  if (/地铁|公交|公共交通/.test(raw) && /优先|改成|换成|为主/.test(raw) && raw.length <= 24) {
    return { kind: 'set_transport_pref', confidence: 0.85, label: '交通改为地铁/公交优先', params: { mode: 'transit' }, level: 'L1' };
  }
  if (/打车|自驾|开车/.test(raw) && /优先|改成|换成/.test(raw) && raw.length <= 24) {
    return { kind: 'set_transport_pref', confidence: 0.82, label: '交通改为打车/驾车', params: { mode: 'driving' }, level: 'L1' };
  }

  // L1: late / early start shift ("晚点出发" / "早上睡个懒觉" / "早点出发")
  if (!hasComplexAddOrReplace && raw.length <= 22) {
    if (/(?:晚点|晚一点|推迟|延后)(?:出发|出门|起床|开始)|睡(?:个)?懒觉|不想早起/.test(raw)) {
      return {
        kind: 'shift_day_start',
        confidence: 0.9,
        label: day ? `把 ${day} 出发与后续站点顺延 1 小时` : '把各天出发与后续站点顺延 1 小时',
        params: { deltaMinutes: 60, ...(day ? { day } : {}) },
        level: 'L1'
      };
    }
    if (/(?:早点|早一点|提前)(?:出发|出门|开始)/.test(raw)) {
      return {
        kind: 'shift_day_start',
        confidence: 0.88,
        label: day ? `把 ${day} 出发时间提前 1 小时` : '把各天出发时间提前 1 小时',
        params: { deltaMinutes: -60, ...(day ? { day } : {}) },
        level: 'L1'
      };
    }
  }

  // L1: explicit train/flight transit window update ("高铁改签到 14:30 到杭州东站" / "返程改到 19:30 从上海虹桥站走")
  const transitClockMatch = /(\d{1,2})\s*[:：点]\s*(\d{2}|半)?/.exec(raw);
  if (transitClockMatch && /(?:改签|改到|改成|调整到|调整为)/.test(raw) && /(?:站|机场|到达|到站|返程|回程|离开)/.test(raw)) {
    let hh = Number(transitClockMatch[1]);
    const mm = transitClockMatch[2] === '半' ? 30 : Number(transitClockMatch[2] || 0);
    if (/下午|晚上|傍晚/.test(raw) && hh < 12) hh += 12;
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      const isDeparture = /返程|回程|离开|回|走/.test(raw) && !/到达|到站/.test(raw);
      const hubMatch = /([一-龥]{2,10}(?:东站|西站|南站|北站|虹桥站|园区站|站|机场))/.exec(raw);
      const hub = hubMatch ? hubMatch[1].replace(/^(?:到|从|去|在)/, '') : '';
      return {
        kind: 'update_transit_window',
        confidence: 0.9,
        label: isDeparture
          ? `更新末日返程时间窗为 ${clock}${hub ? `（${hub}）` : ''}`
          : `更新首日到达时间窗为 ${clock}${hub ? `（${hub}）` : ''} 并顺延冲突站点`,
        params: isDeparture ? { departureTime: clock, ...(hub ? { departureHub: hub } : {}) } : { arrivalTime: clock, ...(hub ? { arrivalHub: hub } : {}) },
        level: 'L1'
      };
    }
  }

  // L2: Natural-language AI adjustment — single day if one specific day is targeted, else whole-book multi-day ('all')
  const mentionsWholeBook = /每天|全程|整本|所有天|全部|住在|住宿|酒店|民宿/.test(raw) || dayTokens.length >= 2;
  const isSingleDayTarget = Boolean(day) && !mentionsWholeBook;
  const scopeType = isSingleDayTarget || days.length <= 1 ? 'day' : 'all';
  const targetDay = scopeType === 'day' ? day || ctx.activeDay || days[0] || 'Day 1' : null;
  const preview = shortInstructionPreview(raw);

  return {
    kind: 'ai_patch',
    confidence: 0.84,
    label: scopeType === 'all' ? `AI 调整整本路线：「${preview}」` : `AI 调整 ${targetDay}：「${preview}」`,
    params: {
      scopeType,
      day: targetDay,
      instruction: raw,
      mode: /细品|deep/i.test(raw) ? 'deep' : 'fast'
    },
    level: 'L2'
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDayToken(token) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (/^\d+$/.test(token)) return Math.max(0, Number(token) - 1);
  if (map[token]) return map[token] - 1;
  return -1;
}

function normalizeTimeForDiff(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[–—~至]/g, '-');
}

function sameScheduleTime(prevTime, nextTime) {
  const a = normalizeTimeForDiff(prevTime);
  const b = normalizeTimeForDiff(nextTime);
  if (!a || !b) return true;
  if (a === b) return true;
  // Model patch often returns start clock "10:15" when original had "10:15-11:20" with same stay.
  const startA = a.split('-')[0];
  const startB = b.split('-')[0];
  if (startA === startB && (!a.includes('-') || !b.includes('-'))) return true;
  return false;
}
function normalizeStopKey(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * Compute a Before vs After diff summary across single-day or whole-book proposals.
 * @param {any[]} [beforeStops]
 * @param {any} [proposal]
 */
export function buildProposalDiff(beforeStops = [], proposal = null) {
  const afterAll = Array.isArray(proposal?.stops) ? proposal.stops : [];
  const isAllScope = proposal?.scope?.type === 'all';
  const targetDay = proposal?.scope?.day || 'Day 1';

  const beforeScoped = isAllScope ? beforeStops : beforeStops.filter((s) => (s.day || 'Day 1') === targetDay);
  const afterScoped = isAllScope ? afterAll : afterAll.filter((s) => (s.day || 'Day 1') === targetDay);

  const beforeMap = new Map();
  for (const s of beforeScoped) {
    const key = normalizeStopKey(s.name);
    if (key && !beforeMap.has(key)) beforeMap.set(key, s);
  }
  const afterKeys = new Set(afterScoped.map((s) => normalizeStopKey(s.name)).filter(Boolean));
  const removedStops = beforeScoped.filter((s) => {
    const key = normalizeStopKey(s.name);
    return key && !afterKeys.has(key);
  });

  let addedCount = 0;
  let movedCount = 0;
  const annotatedAfter = afterScoped.map((stop) => {
    const key = normalizeStopKey(stop.name);
    const prev = beforeMap.get(key);
    if (!prev) {
      addedCount += 1;
      return { ...stop, diffTag: '新增', diffTone: 'added' };
    }
    const prevDay = prev.day || 'Day 1';
    const nextDay = stop.day || 'Day 1';
    if (prevDay !== nextDay) {
      movedCount += 1;
      return { ...stop, diffTag: `从 ${prevDay} 移来`, diffTone: 'moved' };
    }
    if (prev.time && stop.time && !sameScheduleTime(prev.time, stop.time)) {
      movedCount += 1;
      return { ...stop, diffTag: `原 ${prev.time}`, diffTone: 'retimed' };
    }
    return { ...stop, diffTag: '', diffTone: 'kept' };
  });

  const daysMap = new Map();
  for (const stop of annotatedAfter) {
    const d = stop.day || 'Day 1';
    if (!daysMap.has(d)) daysMap.set(d, []);
    daysMap.get(d).push(stop);
  }
  const dayGroups = [...daysMap.entries()].map(([day, stops]) => ({ day, stops }));

  return {
    isAllScope,
    targetDay,
    dayGroups,
    removedStops,
    addedCount,
    removedCount: removedStops.length,
    movedCount
  };
}

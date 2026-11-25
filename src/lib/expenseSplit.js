// 同行记账与最少转账 AA 结算（免注册：认个称呼即可参与垫付与分摊）。
const EXPENSE_KEY_PREFIX = 'trusted-routebook:expenses:v1';

function storageKey(routeId) {
  return `${EXPENSE_KEY_PREFIX}:${encodeURIComponent(String(routeId || 'draft'))}`;
}

export function normalizeTravelerName(value) {
  return String(value ?? '')
    .trim()
    .replace(/[，,、；;|]/g, '')
    .slice(0, 20);
}

export function mergeTravelerRoster(saved = [], companionNames = []) {
  const out = ['我'];
  for (const raw of [...companionNames, ...saved]) {
    const clean = normalizeTravelerName(raw);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * @param {string} routeId
 * @param {string[]} [companionNames]
 * @param {any} [storage]
 * @param {{ travelers?: string[], extraExpenses?: any[] } | null} [cloudLedger]
 * @param {any[]} [companions]
 */
export function readExpenseState(routeId, companionNames = [], storage = globalThis.localStorage, cloudLedger = null, companions = []) {
  let savedTravelers = [];
  let extraExpenses = [];
  if (routeId && storage) {
    try {
      const parsed = JSON.parse(storage.getItem(storageKey(routeId)) ?? 'null');
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.travelers)) savedTravelers = parsed.travelers;
        if (Array.isArray(parsed.extraExpenses)) extraExpenses = parsed.extraExpenses;
      }
    } catch {
      // ignore corrupted storage
    }
  }
  const cloudTravelers = Array.isArray(cloudLedger?.travelers) ? cloudLedger.travelers : [];
  const cloudExtras = Array.isArray(cloudLedger?.extraExpenses) ? cloudLedger.extraExpenses : [];
  const companionExtras = (Array.isArray(companions) ? companions : []).flatMap((comp, cIdx) => {
    const fallbackPayer = normalizeTravelerName(comp?.nickname) || `伙伴${cIdx + 1}`;
    return (Array.isArray(comp?.expenses) ? comp.expenses : []).map((exp, eIdx) => ({
      ...exp,
      id: `comp:${comp?.companionId || cIdx}:${exp?.id || eIdx}`,
      paidBy: normalizeTravelerName(exp?.paidBy) || fallbackPayer,
      companionOwned: true
    }));
  });

  const combinedExtras = [];
  const seenIds = new Set();
  for (const item of [...extraExpenses, ...cloudExtras, ...companionExtras]) {
    if (!item || typeof item !== 'object' || !(parseExpenseAmount(item.amount) > 0)) continue;
    const id = String(item.id || '');
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    combinedExtras.push({
      id,
      title: String(item.title || '共同开销').slice(0, 40),
      amount: parseExpenseAmount(item.amount),
      paidBy: normalizeTravelerName(item.paidBy) || '我',
      splitWith: Array.isArray(item.splitWith) ? item.splitWith.map(normalizeTravelerName).filter(Boolean) : [],
      createdAt: String(item.createdAt || ''),
      ...(item.companionOwned ? { companionOwned: true } : {})
    });
  }

  const travelers = mergeTravelerRoster([...cloudTravelers, ...savedTravelers, ...combinedExtras.map((e) => e.paidBy)], companionNames);
  return { travelers, extraExpenses: combinedExtras };
}

function writeExpenseState(routeId, state, storage = globalThis.localStorage) {
  if (!routeId || !storage) return;
  try {
    storage.setItem(
      storageKey(routeId),
      JSON.stringify({
        travelers: Array.isArray(state?.travelers) ? state.travelers.slice(0, 12) : ['我'],
        extraExpenses: Array.isArray(state?.extraExpenses) ? state.extraExpenses.slice(0, 80) : []
      })
    );
  } catch {
    // ignore quota errors
  }
}

/**
 * @param {string} routeId
 * @param {string} name
 * @param {string[]} [companionNames]
 * @param {any} [storage]
 */
export function addExpenseTraveler(routeId, name, companionNames = [], storage = globalThis.localStorage) {
  const clean = normalizeTravelerName(name);
  const current = readExpenseState(routeId, companionNames, storage);
  if (!clean || current.travelers.includes(clean)) return current;
  const next = {
    ...current,
    travelers: [...current.travelers, clean].slice(0, 12)
  };
  writeExpenseState(routeId, next, storage);
  return next;
}

/**
 * @param {string} routeId
 * @param {Record<string, any>} [input]
 * @param {string[]} [companionNames]
 * @param {any} [storage]
 */
export function addExtraExpenseItem(routeId, input = {}, companionNames = [], storage = globalThis.localStorage) {
  const current = readExpenseState(routeId, companionNames, storage);
  const amount = parseExpenseAmount(input?.amount);
  const title = String(input?.title ?? '')
    .trim()
    .slice(0, 40);
  if (!title || !(amount > 0)) return current;
  const paidBy = normalizeTravelerName(input?.paidBy) || '我';
  const splitWith = Array.isArray(input?.splitWith) && input.splitWith.length ? input.splitWith.map(normalizeTravelerName).filter(Boolean) : current.travelers;
  const entry = {
    id: `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    amount,
    paidBy,
    splitWith,
    createdAt: new Date().toISOString()
  };
  const nextTravelers = mergeTravelerRoster([...current.travelers, paidBy, ...splitWith], companionNames);
  const next = {
    travelers: nextTravelers,
    extraExpenses: [entry, ...current.extraExpenses].slice(0, 80)
  };
  writeExpenseState(routeId, next, storage);
  return next;
}

/**
 * @param {string} routeId
 * @param {string} itemId
 * @param {string[]} [companionNames]
 * @param {any} [storage]
 */
export function removeExtraExpenseItem(routeId, itemId, companionNames = [], storage = globalThis.localStorage) {
  const current = readExpenseState(routeId, companionNames, storage);
  const next = {
    ...current,
    extraExpenses: current.extraExpenses.filter((item) => item.id !== itemId)
  };
  writeExpenseState(routeId, next, storage);
  return next;
}

export function parseExpenseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 0;
  const text = String(value ?? '')
    .normalize('NFKC')
    .trim();
  if (!text || /^(?:免费|免票)$/.test(text) || /(?<!\d)0(?:\.0+)?\s*元/.test(text)) return 0;
  const m = /(\d+(?:\.\d{1,2})?)/.exec(text.replace(/,/g, ''));
  if (!m) return 0;
  const num = Number(m[1]);
  return Number.isFinite(num) && num > 0 ? Math.round(num * 100) / 100 : 0;
}

function formatYuan(cents) {
  const yuan = Math.round(cents) / 100;
  return Number.isInteger(yuan) ? `${yuan}` : yuan.toFixed(2);
}

/**
 * 汇总打卡花费与补记开销，按分（整数）精确计算每人垫付、应付份额及最少转账方案。
 * @param {{ stops?: any[], latestByStop?: Map<string, any>, travelers?: string[], extraExpenses?: any[] }} [opts]
 */
export function calculateExpenseSplit({ stops = [], latestByStop = new Map(), travelers = ['我'], extraExpenses = [] } = {}) {
  const baseRoster = mergeTravelerRoster(travelers, []);
  const entries = [];

  for (const stop of stops || []) {
    const key = String(stop?.id ?? '').trim();
    const checkin = latestByStop.get(key);
    if (!checkin || checkin.status === 'skipped' || checkin.worth === '跳过') continue;
    const amount = parseExpenseAmount(checkin.cost);
    if (!(amount > 0)) continue;
    const paidBy = normalizeTravelerName(checkin.paidBy) || '我';
    const rawSplit = Array.isArray(checkin.splitWith) ? checkin.splitWith.map(normalizeTravelerName).filter(Boolean) : [];
    entries.push({
      id: `checkin:${key}`,
      title: String(stop?.name || '站点打卡'),
      amount,
      paidBy,
      splitWith: rawSplit,
      source: 'checkin'
    });
  }

  for (const extra of extraExpenses || []) {
    const amount = parseExpenseAmount(extra?.amount);
    if (!(amount > 0)) continue;
    const paidBy = normalizeTravelerName(extra?.paidBy) || '我';
    const rawSplit = Array.isArray(extra?.splitWith) ? extra.splitWith.map(normalizeTravelerName).filter(Boolean) : [];
    entries.push({
      id: String(extra.id || `extra:${entries.length}`),
      title: String(extra.title || '共同开销'),
      amount,
      paidBy,
      splitWith: rawSplit,
      source: 'extra'
    });
  }

  const allPeople = mergeTravelerRoster([...baseRoster, ...entries.flatMap((e) => [e.paidBy, ...e.splitWith])], []);
  const paidCents = new Map(allPeople.map((p) => [p, 0]));
  const shareCents = new Map(allPeople.map((p) => [p, 0]));
  let totalCents = 0;

  const normalizedEntries = entries.map((entry) => {
    const cents = Math.round(entry.amount * 100);
    totalCents += cents;
    const participants = entry.splitWith.length ? entry.splitWith : allPeople;
    paidCents.set(entry.paidBy, (paidCents.get(entry.paidBy) || 0) + cents);
    const base = Math.floor(cents / participants.length);
    let remainder = cents - base * participants.length;
    participants.forEach((person) => {
      const bonus = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder -= 1;
      shareCents.set(person, (shareCents.get(person) || 0) + base + bonus);
    });
    return { ...entry, splitWith: participants };
  });

  const balances = allPeople.map((name) => {
    const paid = paidCents.get(name) || 0;
    const share = shareCents.get(name) || 0;
    const net = paid - share;
    return {
      name,
      paidYuan: formatYuan(paid),
      shareYuan: formatYuan(share),
      netCents: net,
      netYuan: formatYuan(Math.abs(net))
    };
  });

  // 贪心最少转账匹配：最大欠款人优先转给最大垫付人
  const debtors = balances
    .filter((b) => b.netCents < 0)
    .map((b) => ({ name: b.name, cents: -b.netCents }))
    .sort((a, b) => b.cents - a.cents);
  const creditors = balances
    .filter((b) => b.netCents > 0)
    .map((b) => ({ name: b.name, cents: b.netCents }))
    .sort((a, b) => b.cents - a.cents);

  const transfers = [];
  let di = 0;
  let ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const move = Math.min(debtors[di].cents, creditors[ci].cents);
    if (move > 0) {
      transfers.push({
        from: debtors[di].name,
        to: creditors[ci].name,
        amountCents: move,
        amountYuan: formatYuan(move)
      });
    }
    debtors[di].cents -= move;
    creditors[ci].cents -= move;
    if (debtors[di].cents <= 0) di += 1;
    if (creditors[ci].cents <= 0) ci += 1;
  }

  return {
    travelers: allPeople,
    entries: normalizedEntries,
    totalCents,
    totalYuan: formatYuan(totalCents),
    perPersonYuan: allPeople.length ? formatYuan(Math.round(totalCents / allPeople.length)) : '0',
    balances,
    transfers
  };
}

export function formatExpenseSplitSummary(city, title, result) {
  if (!result || !(result.totalCents > 0)) return '';
  const head = `【${city ? `${city} · ` : ''}${title || '同行旅程'} AA 账单】`;
  const stat = `共记账 ${result.entries.length} 笔 · 合计 ${result.totalYuan} 元 · ${result.travelers.length} 人人均约 ${result.perPersonYuan} 元`;
  const items = result.entries.map(
    (e, i) => `${i + 1}. ${e.title}：${formatYuan(Math.round(e.amount * 100))} 元（${e.paidBy}付，${e.splitWith.join('、')}分摊）`
  );
  const transferBlock = result.transfers.length
    ? ['结清转账方案：', ...result.transfers.map((t) => `• ${t.from} 转给 ${t.to}：${t.amountYuan} 元`)]
    : ['结清状态：各人垫付与应分摊刚好持平，无需转账'];
  return [head, stat, '', ...items, '', ...transferBlock].join('\n');
}

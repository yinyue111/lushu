// 同行朋友链接（visibility === 'unlisted'）免注册轻互动：认领称呼 + 选点表态 + 事项认领 + 共同记账 + 到站同步。
import { parseExpenseAmount, normalizeTravelerName } from './expenseSplit.js';

const COMPANION_KEY_PREFIX = 'trusted-routebook:companion:v1';

function storageKey(routeId) {
  return `${COMPANION_KEY_PREFIX}:${encodeURIComponent(String(routeId || 'draft'))}`;
}

function makeCompanionId() {
  const uuid = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16);
  return uuid ? `comp_${uuid}` : `comp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeLocalCompanionExpenses(raw, fallbackPayer = '同行伙伴') {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && parseExpenseAmount(item.amount) > 0)
    .slice(0, 40)
    .map((item, idx) => ({
      id: String(item.id || `cexp_${idx}`),
      title: String(item.title || '共同开销').slice(0, 40),
      amount: parseExpenseAmount(item.amount),
      paidBy: normalizeTravelerName(item.paidBy) || normalizeTravelerName(fallbackPayer) || '同行伙伴',
      splitWith: Array.isArray(item.splitWith) ? item.splitWith.map(normalizeTravelerName).filter(Boolean) : [],
      createdAt: String(item.createdAt || '')
    }));
}

export function readCompanionState(routeId, storage = globalThis.localStorage) {
  const empty = () => ({ companionId: makeCompanionId(), nickname: '', votes: {}, claims: [], expenses: [], visitedStopIds: [] });
  if (!routeId || !storage) return empty();
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(routeId)) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return empty();
    const nickname = typeof parsed.nickname === 'string' ? parsed.nickname.slice(0, 20) : '';
    return {
      companionId: typeof parsed.companionId === 'string' && parsed.companionId.length >= 6 ? parsed.companionId : makeCompanionId(),
      nickname,
      votes: parsed.votes && typeof parsed.votes === 'object' ? parsed.votes : {},
      claims: Array.isArray(parsed.claims) ? parsed.claims.filter((x) => typeof x === 'string') : [],
      expenses: normalizeLocalCompanionExpenses(parsed.expenses, nickname),
      visitedStopIds: Array.isArray(parsed.visitedStopIds) ? parsed.visitedStopIds.filter((x) => typeof x === 'string').slice(0, 50) : []
    };
  } catch {
    return empty();
  }
}

export function writeCompanionState(routeId, nextState, storage = globalThis.localStorage) {
  const nickname = String(nextState?.nickname ?? '')
    .trim()
    .slice(0, 20);
  const normalized = {
    companionId: typeof nextState?.companionId === 'string' && nextState.companionId.length >= 6 ? nextState.companionId : makeCompanionId(),
    nickname,
    votes: nextState?.votes ?? {},
    claims: [...new Set(nextState?.claims ?? [])].slice(0, 60),
    expenses: normalizeLocalCompanionExpenses(nextState?.expenses, nickname),
    visitedStopIds: [...new Set(nextState?.visitedStopIds ?? [])].slice(0, 50)
  };
  if (!routeId || !storage) return normalized;
  try {
    storage.setItem(storageKey(routeId), JSON.stringify(normalized));
  } catch {
    // ignore quota errors
  }
  return normalized;
}

/**
 * 汇总同行人的选点偏好、认领事项与共同开销，生成适合直接发回微信群的文本。
 * @param {any} routebook
 * @param {{ nickname?: string, votes?: Record<string, string>, claims?: string[], expenses?: any[] }} state
 * @param {{ item: { key: string, label: string }, stopName: string }[]} [confirmEntries]
 */
export function buildCompanionSummaryText(routebook, state = {}, confirmEntries = []) {
  const votes = state?.votes ?? {};
  const claimSet = new Set(state?.claims ?? []);
  const nickname = String(state?.nickname ?? '').trim();
  const stops = Array.isArray(routebook?.stops) ? routebook.stops : [];

  const wantNames = [];
  const skipNames = [];
  for (const stop of stops) {
    const key = String(stop?.id ?? stop?.name ?? '');
    const v = votes[key];
    if (v === 'want' && stop?.name) wantNames.push(stop.name);
    if (v === 'skip' && stop?.name) skipNames.push(stop.name);
  }

  const claimedTasks = (confirmEntries || []).filter(({ item }) => claimSet.has(item.key)).map(({ stopName, item }) => `${stopName}（${item.label}）`);
  const expenses = Array.isArray(state?.expenses) ? state.expenses : [];

  if (!wantNames.length && !skipNames.length && !claimedTasks.length && !expenses.length) return '';

  const city = String(routebook?.city || '').trim();
  const who = nickname ? `（${nickname}）` : '';
  const lines = [`【${city ? `${city}` : ''}路线同行意见${who}】`];
  if (wantNames.length) lines.push(`• 想重点去：${wantNames.join('、')}`);
  if (skipNames.length) lines.push(`• 可以先不去：${skipNames.join('、')}`);
  if (claimedTasks.length) lines.push(`• 我来负责准备：${claimedTasks.join('、')}`);
  if (expenses.length) {
    lines.push(`• 我已记入共同开销：${expenses.map((e) => `${e.title} ${e.amount} 元`).join('、')}`);
  }
  return lines.join('\n');
}

/**
 * 聚合云端同行伙伴列表（供发起人路书页一键调站、分享页展示多人计数、行中共享进度与 AA 分摊账单合并使用）。
 * @param {any} routebook
 * @param {Array<{ companionId?: string, nickname?: string, votes?: Record<string, string>, claims?: string[], expenses?: any[], visitedStopIds?: string[] }>} [companions]
 * @param {{ item: { key: string, label: string }, stopName: string }[]} [confirmEntries]
 */
export function summarizeCompanionResponses(routebook, companions = [], confirmEntries = []) {
  const list = Array.isArray(companions) ? companions.filter((c) => c && typeof c === 'object') : [];
  const stops = Array.isArray(routebook?.stops) ? routebook.stops : [];
  const memberNames = [...new Set(list.map((c, i) => String(c.nickname || '').trim() || `同行伙伴${i + 1}`))];
  const byStopKey = new Map();

  for (const stop of stops) {
    const key = String(stop?.id ?? stop?.name ?? '');
    if (!key) continue;
    const wantNames = [];
    const okNames = [];
    const skipNames = [];
    const visitedNames = [];
    list.forEach((c, idx) => {
      const label = String(c.nickname || '').trim() || `伙伴${idx + 1}`;
      const vote = c.votes?.[key];
      if (vote === 'want') wantNames.push(label);
      else if (vote === 'ok') okNames.push(label);
      else if (vote === 'skip') skipNames.push(label);
      if (Array.isArray(c.visitedStopIds) && c.visitedStopIds.includes(key)) {
        visitedNames.push(label);
      }
    });
    byStopKey.set(key, {
      stop,
      key,
      want: wantNames.length,
      ok: okNames.length,
      skip: skipNames.length,
      wantNames,
      okNames,
      skipNames,
      visitedNames
    });
  }

  const skipSuggestions = [...byStopKey.values()].filter((row) => row.skip > 0 && row.skip >= row.want);
  const claimedByItemKey = new Map();
  const sharedExpenses = [];
  for (const [idx, c] of list.entries()) {
    const label = String(c.nickname || '').trim() || `伙伴${idx + 1}`;
    for (const itemKey of Array.isArray(c.claims) ? c.claims : []) {
      const arr = claimedByItemKey.get(itemKey) || [];
      if (!arr.includes(label)) arr.push(label);
      claimedByItemKey.set(itemKey, arr);
    }
    for (const exp of Array.isArray(c.expenses) ? c.expenses : []) {
      const amount = parseExpenseAmount(exp?.amount);
      if (!(amount > 0)) continue;
      sharedExpenses.push({
        id: `comp:${c.companionId || idx}:${exp.id || sharedExpenses.length}`,
        rawId: exp.id,
        companionId: c.companionId,
        title: String(exp.title || '共同开销').slice(0, 40),
        amount,
        paidBy: normalizeTravelerName(exp.paidBy) || label,
        splitWith: Array.isArray(exp.splitWith) ? exp.splitWith.map(normalizeTravelerName).filter(Boolean) : [],
        createdAt: String(exp.createdAt || '')
      });
    }
  }
  const claimedSummary = [];
  for (const entry of confirmEntries || []) {
    const owners = claimedByItemKey.get(entry.item.key);
    if (owners?.length) {
      claimedSummary.push({
        key: entry.item.key,
        stopName: entry.stopName,
        label: entry.item.label,
        owners
      });
    }
  }

  return {
    memberCount: list.length,
    memberNames,
    byStopKey,
    skipSuggestions,
    claimedByItemKey,
    claimedSummary,
    sharedExpenses
  };
}

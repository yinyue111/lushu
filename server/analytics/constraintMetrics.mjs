// 约束满足率：读取已保存路书上由 buildRoutebookValidations 写入的约束核对结果
// （edit-constraints 必去/避开，edit-budget 预算）。不重新推断，也不把“待复核”算成满足。
const MUST_GO_STATES = Object.freeze({ 已纳入: 'satisfied', 未完全满足: 'violated', 需人工确认: 'needs-review', 未设置: 'not-set' });
const BUDGET_STATES = Object.freeze({
  可控: 'satisfied',
  超预算: 'violated',
  区间待复核: 'needs-review',
  部分待复核: 'needs-review',
  待补充: 'needs-review',
  无预算约束: 'not-set'
});

function validationState(routebook, id, table) {
  const validation = (Array.isArray(routebook?.validations) ? routebook.validations : []).find((item) => item?.id === id);
  if (!validation) return 'missing';
  return table[validation.state] ?? 'missing';
}

function summarize(states) {
  const counts = { satisfied: 0, violated: 0, 'needs-review': 0, 'not-set': 0, missing: 0 };
  for (const state of states) counts[state] += 1;
  const decided = counts.satisfied + counts.violated;
  return {
    ...counts,
    decided,
    satisfactionRate: decided ? Math.round((counts.satisfied / decided) * 1000) / 10 : null
  };
}

/**
 * @param {any[]} routebooks stored routebooks (current version)
 * @param {{ routeIds?: Set<string> | null }} [options] limit to these ids (e.g. AI-generated)
 */
export function buildConstraintSatisfaction(routebooks, { routeIds = null } = {}) {
  const scoped = (routebooks ?? []).filter((routebook) => !routeIds || routeIds.has(String(routebook?.publicId || routebook?.id || '')));
  const mustGo = summarize(scoped.map((routebook) => validationState(routebook, 'edit-constraints', MUST_GO_STATES)));
  const budget = summarize(scoped.map((routebook) => validationState(routebook, 'edit-budget', BUDGET_STATES)));
  const satisfied = mustGo.satisfied + budget.satisfied;
  const decided = mustGo.decided + budget.decided;
  return {
    routebooks: scoped.length,
    mustGoAvoid: mustGo,
    budget,
    checksSatisfied: satisfied,
    checksDecided: decided,
    satisfactionRate: decided ? Math.round((satisfied / decided) * 1000) / 10 : null
  };
}

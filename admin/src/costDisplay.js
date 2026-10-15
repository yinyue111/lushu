/** Ops cost headline / bias hint for the admin dashboard (docs/admin.md). Not invoice reconciliation. */

export const usd = (value) => (value == null ? '未知' : `$${Number(value).toFixed(4)}`);

/**
 * Always an estimate: 「估算 $X」 or 「估算 $X，另有 N 次没有单价」. Never 「至少」.
 * @param {{ totalUsd?: number|null, lowerBound?: boolean, unknownCostCount?: number }} [cost]
 */
export function formatCostHeadline(cost = {}) {
  const totalUsd = cost.totalUsd;
  const lowerBound = Boolean(cost.lowerBound);
  const unknownCostCount = Number(cost.unknownCostCount) || 0;
  const amount = usd(totalUsd);
  return lowerBound ? `估算 ${amount}，另有 ${unknownCostCount} 次没有单价` : `估算 ${amount}`;
}

export const COST_ESTIMATE_BIAS_HINT = '按官方标价估算；命中缓存时偏高，超长上下文时偏低';

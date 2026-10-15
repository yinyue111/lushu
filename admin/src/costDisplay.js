/** Ops cost headline / bias hint for the admin dashboard (docs/admin.md). Not invoice reconciliation. */

/** Main figure: 2 decimals; amounts under $0.01 show 「< $0.01」 (A1). */
export const usd = (value) => {
  if (value == null) return '未知';
  const n = Number(value);
  if (!Number.isFinite(n)) return '未知';
  if (n > 0 && n < 0.01) return '< $0.01';
  return `$${n.toFixed(2)}`;
};

/**
 * Main number only 「估算 $X.XX」; unknown-price count is separate small text (A1).
 * @param {{ totalUsd?: number|null, lowerBound?: boolean, unknownCostCount?: number }} [cost]
 */
export function formatCostHeadline(cost = {}) {
  return `估算 ${usd(cost.totalUsd)}`;
}

/** @param {{ lowerBound?: boolean, unknownCostCount?: number }} [cost] */
export function formatCostUnknownNote(cost = {}) {
  const unknownCostCount = Number(cost.unknownCostCount) || 0;
  if (!cost.lowerBound || unknownCostCount <= 0) return '';
  return `另有 ${unknownCostCount} 次没有单价`;
}

export const COST_ESTIMATE_BIAS_HINT = '按官方标价估算；命中缓存时偏高，超长上下文时偏低';

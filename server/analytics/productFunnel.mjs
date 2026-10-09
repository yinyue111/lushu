export function buildProductFunnelAnalytics({ clicks = [], exposures = [], profileId = '' } = {}) {
  const scopedClicks = scopeRows(clicks, profileId);
  const scopedExposures = scopeRows(exposures, profileId);
  const exposuresById = new Map();
  for (const row of scopedExposures) {
    if (!isTrackableProductExposure(row)) continue;
    const exposureId = rowExposureId(row);
    if (!exposuresById.has(exposureId)) exposuresById.set(exposureId, row);
  }

  const attributedClicks = [];
  const duplicateClicks = new Set();
  const clickedExposureIds = new Set();
  let duplicateClickCount = 0;
  let unattributedClickCount = 0;
  for (const click of scopedClicks) {
    const exposureId = rowExposureId(click);
    const exposure = exposuresById.get(exposureId);
    if (!exposure || !productExposureMatchesClick(exposure, click)) {
      unattributedClickCount += 1;
      continue;
    }
    if (clickedExposureIds.has(exposureId)) {
      duplicateClickCount += 1;
      duplicateClicks.add(click);
      continue;
    }
    clickedExposureIds.add(exposureId);
    attributedClicks.push(click);
  }

  const productExposures = [...exposuresById.values()];
  const exposureByProduct = countBy(productExposures, rowProductId);
  const clickByProduct = countBy(attributedClicks, rowProductId);
  const ctrByProduct = [...exposureByProduct.entries()]
    .map(([key, exposureCount]) => ({
      key,
      label:
        productExposures.find((item) => rowProductId(item) === key)?.productTitle ||
        attributedClicks.find((item) => rowProductId(item) === key)?.productTitle ||
        key,
      exposureCount,
      clickCount: clickByProduct.get(key) ?? 0,
      ctr: percentage(clickByProduct.get(key) ?? 0, exposureCount)
    }))
    .sort((a, b) => b.clickCount - a.clickCount || b.exposureCount - a.exposureCount)
    .slice(0, 12);

  const aggregateClicks = (keyFn, labelFn) => aggregateRows(attributedClicks, keyFn, labelFn);
  return {
    totalExposures: productExposures.length,
    rawExposureCount: scopedExposures.filter((row) => row?.itemType === 'product' || row?.productId).length,
    unattributedExposureCount: scopedExposures.filter((row) => (row?.itemType === 'product' || row?.productId) && !isTrackableProductExposure(row)).length,
    totalClicks: attributedClicks.length,
    rawClickCount: scopedClicks.length,
    attributableClickCount: attributedClicks.length,
    unattributedClickCount,
    duplicateClickCount,
    overallCtr: productExposures.length ? percentage(attributedClicks.length, productExposures.length) : null,
    topProducts: aggregateClicks(rowProductId, (row) => row.productTitle || '未知商品'),
    ctrByProduct,
    byProvider: aggregateClicks(
      (row) => row.provider,
      (row) => row.provider || '未知供应商'
    ),
    byType: aggregateClicks(
      (row) => row.type,
      (row) => row.type || '未知类型'
    ),
    byPoi: aggregateClicks(
      (row) => row.poi || row.stopName,
      (row) => row.poi || row.stopName || '未知 POI'
    ),
    byRoute: aggregateClicks(
      (row) => row.routeId || row.routeTitle,
      (row) => row.routeTitle || row.routeId || '未知路书'
    ),
    byProfile: aggregateClicks(
      (row) => (row.profileId && row.profileId !== 'anonymous' ? row.profileId : ''),
      (row) => row.profileId
    ),
    funnelByPoi: buildFunnel(
      productExposures,
      clickedExposureIds,
      (row) => (row.stopId ? `${row.routeId || ''}:${row.stopId}` : row.stopName ? `${row.city || ''}:${row.stopName}` : ''),
      (row) => row.stopName || row.stopId || '未知 POI'
    ),
    funnelByRoute: buildFunnel(
      productExposures,
      clickedExposureIds,
      (row) => row.routeId || row.routeTitle,
      (row) => row.routeTitle || row.routeId || '未知路书'
    ),
    funnelByCreator: buildFunnel(
      productExposures,
      clickedExposureIds,
      (row) => row.creatorId,
      (row) => row.creatorId || '未知达人'
    ),
    recentClicks: attributedClicks.slice(0, 20),
    rawRecentClicks: scopedClicks.slice(0, 20).map((click) => ({
      ...click,
      attributionStatus: attributedClicks.includes(click) ? 'attributed' : duplicateClicks.has(click) ? 'duplicate' : 'unattributed'
    })),
    sampleScope: 'all-persisted-events',
    metricDefinition: '同会话、同身份、同商品、同路书及站点的曝光与点击严格匹配；每次曝光最多计一次点击。历史缺少关联凭据的事件不进入CTR。'
  };
}

export function productExposureMatchesClick(exposure, click) {
  if (!isTrackableProductExposure(exposure) || !click || typeof click !== 'object') return false;
  if (rowExposureId(exposure) !== rowExposureId(click)) return false;
  if (String(exposure.sessionId ?? '') !== String(click.sessionId ?? '')) return false;
  if (String(exposure.profileId ?? '') !== String(click.profileId ?? '')) return false;
  if (rowProductId(exposure) !== rowProductId(click)) return false;
  return sameScopedValue(exposure.surface, click.surface) && sameScopedValue(exposure.routeId, click.routeId) && sameScopedValue(exposure.stopId, click.stopId);
}

function isTrackableProductExposure(row) {
  return Boolean(row && (row.itemType === 'product' || row.productId) && rowExposureId(row) && String(row.sessionId ?? '').trim() && rowProductId(row));
}

function rowExposureId(row) {
  return String(row?.exposureId || row?.id || '').trim();
}

function rowProductId(row) {
  return String(row?.productId || row?.itemId || '').trim();
}

function sameScopedValue(expected, actual) {
  const left = String(expected ?? '').trim();
  const right = String(actual ?? '').trim();
  return left === right;
}

function scopeRows(rows, profileId) {
  if (!profileId) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((row) => String(row?.profileId ?? '') === String(profileId));
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) ?? '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function aggregateRows(rows, keyFn, labelFn) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) ?? '').trim();
    if (!key) continue;
    const item = grouped.get(key) ?? { key, label: labelFn(row), count: 0, lastClickedAt: '' };
    item.count += 1;
    item.lastClickedAt = maxIso(item.lastClickedAt, row.createdAt);
    grouped.set(key, item);
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || String(b.lastClickedAt ?? '').localeCompare(String(a.lastClickedAt ?? ''))).slice(0, 12);
}

function buildFunnel(exposures, clickedExposureIds, keyFn, labelFn) {
  const grouped = new Map();
  for (const exposure of exposures) {
    const key = String(keyFn(exposure) ?? '').trim();
    if (!key) continue;
    const item = grouped.get(key) ?? { key, label: labelFn(exposure), exposureCount: 0, clickCount: 0, lastExposedAt: '' };
    item.exposureCount += 1;
    if (clickedExposureIds.has(rowExposureId(exposure))) item.clickCount += 1;
    item.lastExposedAt = maxIso(item.lastExposedAt, exposure.createdAt);
    grouped.set(key, item);
  }
  return [...grouped.values()]
    .map((item) => ({ ...item, ctr: percentage(item.clickCount, item.exposureCount) }))
    .sort((a, b) => b.clickCount - a.clickCount || b.exposureCount - a.exposureCount)
    .slice(0, 12);
}

function percentage(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function maxIso(left, right) {
  return String(left ?? '').localeCompare(String(right ?? '')) >= 0 ? left : right;
}

// Plain-Chinese summary of POST /api/routebooks/:id/recheck.

/**
 * @param {{ geocoded?: string[], unresolved?: string[], geocodingConfigured?: boolean, routingConfigured?: boolean, routing?: { verifiedLegs?: number, expectedLegs?: number } } | null} result
 * @param {(Error & { status?: number, code?: string, retryAfterSeconds?: number }) | null} [error]
 */
export function recheckSummaryText(result, error = null) {
  if (error) {
    if (error.status === 429) return '核验太频繁了，请稍等一分钟再试（地图服务有调用配额）';
    if (error.code === 'ROUTEBOOK_RECHECK_DRAFT_ONLY') return '已提交或已公开的路书由运营重新核验道路';
    return `道路核验没有完成：${error.message || '网络异常'}`;
  }
  const geocoded = result?.geocoded ?? [];
  const unresolved = result?.unresolved ?? [];
  const parts = [];
  if (geocoded.length) parts.push(`已重新定位 ${geocoded.length} 个站点（${geocoded.slice(0, 3).join('、')}${geocoded.length > 3 ? ' 等' : ''}）`);
  if (unresolved.length) {
    parts.push(
      result?.geocodingConfigured === false
        ? `地图定位未开启，${unresolved.length} 个站点坐标仍待确认`
        : `${unresolved.slice(0, 3).join('、')}${unresolved.length > 3 ? ' 等' : ''} 没找到准确位置，请手动确认坐标`
    );
  }
  const routing = result?.routing;
  if (routing?.expectedLegs && result?.routingConfigured === false) parts.push('道路核验服务暂未开启，路段先按直线估算，出发前请自己看一下导航');
  else if (routing?.expectedLegs) parts.push(`道路 ${routing.verifiedLegs ?? 0}/${routing.expectedLegs} 段已核验`);
  return parts.length ? `${parts.join('；')}。` : '核验完成，没有需要重新定位的站点。';
}

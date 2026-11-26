/**
 * 「苏州 · 2 天 · 5 站」. Day count comes from the days list, else from distinct stop.day values;
 * when neither says anything (0) the segment is left out instead of printing 「0 天」 (V-U17).
 */
export function routeMetaText(city, days, stops) {
  const list = Array.isArray(stops) ? stops : [];
  const declared = Array.isArray(days) ? days.filter(Boolean).length : 0;
  const fromStops = new Set(list.map((stop) => stop?.day).filter(Boolean)).size;
  const dayCount = declared || fromStops;
  return [city, dayCount > 0 ? `${dayCount} 天` : '', `${list.length} 站`].filter(Boolean).join(' · ');
}

/** §2.3: 「1小时」→「1 小时」, 「30分钟」→「30 分钟」, and strip truncated trailing prose clauses on legacy stops. */
export function formatStayText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  let short = raw;
  if (raw.length > 14 || /[，,。；;]/.test(raw)) {
    const firstClause = raw.split(/[，,。；;（(]/)[0]?.trim() || '';
    const durationMatch = raw.match(/(?:约\s*)?\d+(?:\.\d+)?(?:\s*[–—\-~至]\s*\d+(?:\.\d+)?)?\s*(?:小时|分钟|半天|天)/);
    if (firstClause && firstClause.length <= 16 && /(?:小时|分钟|半天|天)/.test(firstClause)) {
      short = firstClause;
    } else if (durationMatch) {
      short = durationMatch[0].trim();
    } else if (firstClause) {
      short = firstClause.slice(0, 16);
    }
  }
  return short.replace(/(\d)\s*(小时|分钟|天|晚|站)/g, '$1 $2');
}

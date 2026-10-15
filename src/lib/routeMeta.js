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

/** §2.3: 「1小时」→「1 小时」, 「30分钟」→「30 分钟」 (spacing only; numbers untouched). */
export function formatStayText(text) {
  return String(text ?? '').replace(/(\d)\s*(小时|分钟|天|晚|站)/g, '$1 $2');
}

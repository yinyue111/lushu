// 纯函数版 A4 纸质行程单 HTML 与高德扫码导航矢量二维码生成（不依赖 JSX，供前端弹窗与单测共用）。
import { amapNameSearchUrl, isNavigableCoordinate } from './coordinates.js';
import { costDisplay } from './cost.js';
import { encodeQrMatrix } from './qrMatrix.js';
import { formatStayText } from './routeMeta.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function stopNavigationUrl(stop, city) {
  if (isNavigableCoordinate(stop)) {
    return `https://uri.amap.com/marker?position=${Number(stop.lng)},${Number(stop.lat)}&name=${encodeURIComponent(stop.name || '')}&src=trusted-routebook&coordinate=wgs84&callnative=1`;
  }
  return amapNameSearchUrl(stop, city);
}

export function buildQrSvgMarkup(url, pixelSize = 84) {
  const { size, modules } = encodeQrMatrix(url);
  const quiet = 2;
  const total = size + quiet * 2;
  const rects = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r]?.[c]) {
        rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1" />`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" role="img" aria-label="高德导航二维码"><rect width="${total}" height="${total}" fill="#ffffff"/><g fill="#18181b">${rects.join('')}</g></svg>`;
}

export function buildPrintableItineraryHtml(routebook) {
  const stops = Array.isArray(routebook?.stops) ? routebook.stops : [];
  const days = Array.isArray(routebook?.days) && routebook.days.length ? routebook.days : [...new Set(stops.map((s) => s.day || 'Day 1'))];
  const city = String(routebook?.city || '旅行').trim();
  const title = String(routebook?.title || `${city}顺路行程单`).trim();
  const dateText = String(routebook?.constraints?.date || routebook?.travelDate || '').trim();

  const daySections = days
    .map((day, dIdx) => {
      const dayStops = stops.filter((s) => (s.day || 'Day 1') === day);
      if (!dayStops.length) return '';
      const rows = dayStops
        .map((stop, idx) => {
          const navUrl = stopNavigationUrl(stop, city);
          const qrSvg = buildQrSvgMarkup(navUrl, 86);
          const price = costDisplay(stop);
          const meta = [stop.time, stop.area, formatStayText(stop.stay), price.pending ? '' : price.text].filter(Boolean).join(' · ');
          const tip = [stop.verify, stop.risk].filter(Boolean).join('；');
          return `<div class="stop-row">
            <div class="stop-main">
              <div class="stop-head"><span class="stop-num">${idx + 1}</span><strong>${escapeHtml(stop.name)}</strong></div>
              <div class="stop-meta">${escapeHtml(meta)}</div>
              ${tip ? `<div class="stop-tip">留意：${escapeHtml(tip)}</div>` : ''}
            </div>
            <div class="stop-qr">${qrSvg}<span>扫码导航</span></div>
          </div>`;
        })
        .join('');
      return `<section class="day-sheet${dIdx > 0 ? ' page-break' : ''}">
        <header class="sheet-head">
          <div>
            <div class="kicker">${escapeHtml(city)} · 纸质随身行程单${dateText ? ` · 出发日 ${escapeHtml(dateText)}` : ''}</div>
            <h1>${escapeHtml(title)}（${escapeHtml(day)}）</h1>
          </div>
          <div class="day-pill">${escapeHtml(day)} · 共 ${dayStops.length} 站</div>
        </header>
        ${routebook?.summary && dIdx === 0 ? `<p class="summary">${escapeHtml(routebook.summary)}</p>` : ''}
        <div class="stop-list">${rows}</div>
        <footer class="sheet-foot">手机相机或高德地图扫右侧二维码即可直接导航到对应站点 · 由可信路书生成</footer>
      </section>`;
    })
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} - 打印行程单</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; color: #18181b; background: #fff; line-height: 1.55; }
  .day-sheet { max-width: 760px; margin: 0 auto 24px; }
  .page-break { break-before: page; page-break-before: always; }
  .sheet-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #18181b; padding-bottom: 12px; }
  .kicker { font-size: 13px; font-weight: 700; color: #52525b; }
  h1 { margin: 4px 0 0; font-size: 24px; line-height: 1.25; }
  .day-pill { padding: 6px 14px; border: 1.5px solid #18181b; border-radius: 999px; font-size: 14px; font-weight: 800; white-space: nowrap; }
  .summary { margin: 12px 0 0; padding: 10px 14px; background: #f4f4f5; border-radius: 10px; font-size: 14px; color: #27272a; }
  .stop-list { margin-top: 14px; display: grid; gap: 12px; }
  .stop-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; border: 1px solid #d4d4d8; border-radius: 12px; padding: 12px 14px; break-inside: avoid; }
  .stop-head { display: flex; align-items: center; gap: 10px; font-size: 18px; }
  .stop-num { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 999px; background: #18181b; color: #fff; font-size: 14px; font-weight: 800; flex-shrink: 0; }
  .stop-meta { margin-top: 4px; font-size: 14px; font-weight: 600; color: #3f3f46; }
  .stop-tip { margin-top: 5px; font-size: 13px; color: #52525b; }
  .stop-qr { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; font-size: 11px; font-weight: 700; color: #52525b; }
  .sheet-foot { margin-top: 16px; padding-top: 10px; border-top: 1px dashed #d4d4d8; font-size: 12px; color: #52525b; text-align: center; }
  @media print { body { padding: 0; } .day-sheet { margin-bottom: 0; max-width: none; } }
</style>
</head>
<body>${daySections}</body>
</html>`;
}

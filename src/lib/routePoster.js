/**
 * Compact magazine-style itinerary poster renderer (pure 2D Canvas -> high-DPI PNG Blob/DataURL).
 * Lazy-loaded from SharePreview so zero bytes enter the initial bundle.
 */
import { confirmItemsForStop } from './confirmChecklist.js';
import { costDisplay } from './cost.js';
import { encodeQrMatrix } from './qrMatrix.js';
import { formatStayText } from './routeMeta.js';
import { getRouteTrustBadgeState, getStopTrustState } from './trust.js';

const DAY_COLORS = ['#ff5a3c', '#0b8793', '#6c5ce7', '#d97706', '#059669', '#2563eb'];
const CITY_GRADIENTS = {
  杭州: ['#132a2e', '#1f4e54'],
  上海: ['#1b1f38', '#333b66'],
  苏州: ['#1e2d2b', '#2f4b46'],
  南京: ['#262235', '#433b5c']
};

function truncateLine(text, maxChars) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

/**
 * Build the structured data model for the itinerary poster (pure, testable in Node).
 * @param {Record<string, any>} routebook
 * @param {{ qrUrl?: string, maxStops?: number }} [options]
 */
export function buildPosterModel(routebook, { qrUrl = '', maxStops = 14 } = {}) {
  const stops = Array.isArray(routebook?.stops) ? routebook.stops : [];
  const rawDays = Array.isArray(routebook?.days) && routebook.days.length ? routebook.days : ['Day 1'];
  const trustState = getRouteTrustBadgeState(routebook);
  const city = String(routebook?.city ?? '').trim() || '旅行';
  const transport = String(routebook?.transport || routebook?.constraints?.transport || '').trim();

  let remainingBudget = maxStops;
  let omittedStopCount = 0;
  const days = [];

  rawDays.forEach((day, dayIdx) => {
    const dayStops = stops.filter((s) => (s.day || 'Day 1') === day);
    if (!dayStops.length) return;
    if (remainingBudget <= 0) {
      omittedStopCount += dayStops.length;
      return;
    }
    const visible = dayStops.slice(0, remainingBudget);
    remainingBudget -= visible.length;
    omittedStopCount += dayStops.length - visible.length;

    days.push({
      day,
      color: DAY_COLORS[dayIdx % DAY_COLORS.length],
      totalCount: dayStops.length,
      stops: visible.map((stop, idx) => {
        const cost = costDisplay(stop);
        const stopTrust = getStopTrustState(stop, trustState.tone);
        const confirmItems = confirmItemsForStop(stop, { city });
        const hasReservation = confirmItems.some((item) => item.kind === 'reservation');
        const stay = formatStayText(String(stop.stay ?? '').replace(/^停留\s*/, ''));
        let tag = '';
        let tagTone = 'neutral';
        if (hasReservation) {
          tag = '需看预约';
          tagTone = 'warn';
        } else if (!cost.pending && cost.text) {
          tag = truncateLine(cost.text, 10);
          tagTone = cost.text === '免费' ? 'ok' : 'sky';
        } else if (stopTrust.tone === 'verified') {
          tag = '已核对';
          tagTone = 'ok';
        }
        return {
          index: idx + 1,
          time: String(stop.time ?? '').trim() || '待定',
          name: truncateLine(stop.name || `站点 ${idx + 1}`, 16),
          stay: stay ? truncateLine(stay, 9) : '',
          tag,
          tagTone
        };
      })
    });
  });

  // Aggregate top 4 pre-trip highlights ordered by priority (reservation -> hours -> price -> position)
  const priorityOrder = { reservation: 0, hours: 1, price: 2, position: 3, note: 4 };
  const allConfirm = stops
    .flatMap((stop) => confirmItemsForStop(stop, { city }).map((item) => ({ stopName: stop.name, ...item })))
    .sort((a, b) => (priorityOrder[a.kind] ?? 9) - (priorityOrder[b.kind] ?? 9));

  const seenHighlightKeys = new Set();
  const highlights = [];
  for (const item of allConfirm) {
    if (highlights.length >= 4) break;
    const dedup = `${item.stopName}:${item.kind}`;
    if (seenHighlightKeys.has(dedup)) continue;
    seenHighlightKeys.add(dedup);
    highlights.push(truncateLine(`${item.stopName}：${item.label}${item.detail ? `（${item.detail}）` : ''}`, 36));
  }
  if (!highlights.length) {
    highlights.push('各站基础资料已核对，出发当天留意天气与现场公告');
  }

  const safeQrUrl = /^https?:\/\//i.test(String(qrUrl ?? '').trim()) ? String(qrUrl).trim() : '';

  return {
    title: truncateLine(routebook?.title || `${city}路线`, 28),
    city,
    metaLine: [city, `${rawDays.length} 天`, `${stops.length} 站`, transport].filter(Boolean).join(' · '),
    trustLabel: trustState.text || '资料核对',
    days,
    omittedStopCount,
    highlights,
    qrUrl: safeQrUrl,
    qrMatrix: safeQrUrl ? encodeQrMatrix(safeQrUrl) : null,
    palette: CITY_GRADIENTS[city] || ['#181b22', '#2b3548']
  };
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrapTitleLines(ctx, text, maxWidth) {
  const chars = [...String(text ?? '')];
  const lines = [];
  let current = '';
  for (const ch of chars) {
    const next = current + ch;
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = ch;
      if (lines.length >= 2) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < 2) lines.push(current);
  return lines.length ? lines : ['旅行路书'];
}

/**
 * Render the itinerary poster to a PNG Blob + Data URL on `<canvas>`.
 * @param {Record<string, any>} routebook
 * @param {{ qrUrl?: string }} [options]
 * @returns {Promise<{ blob: Blob | null, dataUrl: string, width: number, height: number }>}
 */
export async function renderRoutePosterPng(routebook, options = {}) {
  const model = buildPosterModel(routebook, options);
  const W = 540;
  const SCALE = 2;
  const PAD = 28;
  const FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", system-ui, -apple-system, sans-serif';

  // Measure dynamic height first
  const measureCanvas = document.createElement('canvas');
  const mctx = measureCanvas.getContext('2d');
  if (!mctx) throw new Error('当前浏览器不支持画布导出');
  mctx.font = `800 26px ${FONT}`;
  const titleLines = wrapTitleLines(mctx, model.title, W - PAD * 2);

  const headerH = 126 + (titleLines.length - 1) * 34;
  let bodyH = 24;
  for (const d of model.days) {
    bodyH += 34 + d.stops.length * 52 + 12;
  }
  if (model.omittedStopCount > 0) bodyH += 28;
  const highlightsH = 44 + model.highlights.length * 22 + 14;
  const footerH = model.qrMatrix ? 132 : 84;
  const H = headerH + bodyH + highlightsH + footerH + 20;

  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持画布导出');
  ctx.scale(SCALE, SCALE);

  // Background
  ctx.fillStyle = '#f6f4ef';
  ctx.fillRect(0, 0, W, H);

  // Header gradient
  const grad = ctx.createLinearGradient(0, 0, W, headerH);
  grad.addColorStop(0, model.palette[0]);
  grad.addColorStop(1, model.palette[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, headerH);

  // Decorative subtle glow circle
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.arc(W - 50, 34, 88, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Brand kicker + trust pill
  ctx.font = `700 11px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.fillText('可信路书 · 一屏行程卡', PAD, 32);

  const badgeText = model.trustLabel;
  ctx.font = `700 11px ${FONT}`;
  const badgeW = ctx.measureText(badgeText).width + 20;
  drawRoundedRect(ctx, W - PAD - badgeW, 18, badgeW, 22, 11);
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(badgeText, W - PAD - badgeW + 10, 33);

  // Title
  ctx.font = `800 26px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  titleLines.forEach((line, idx) => {
    ctx.fillText(line, PAD, 68 + idx * 34);
  });

  // Meta line
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.84)';
  ctx.fillText(model.metaLine, PAD, 68 + (titleLines.length - 1) * 34 + 28);

  // Timeline body
  let y = headerH + 20;
  for (const dayGroup of model.days) {
    // Day pill
    const dayText = `${dayGroup.day} · ${dayGroup.totalCount} 站`;
    ctx.font = `800 12px ${FONT}`;
    const pillW = ctx.measureText(dayText).width + 22;
    drawRoundedRect(ctx, PAD, y, pillW, 24, 12);
    ctx.fillStyle = dayGroup.color;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(dayText, PAD + 11, y + 16);
    y += 32;

    // Vertical spine behind stops
    if (dayGroup.stops.length > 1) {
      ctx.strokeStyle = '#dfdcd4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(PAD + 14, y + 18);
      ctx.lineTo(PAD + 14, y + (dayGroup.stops.length - 1) * 52 + 18);
      ctx.stroke();
    }

    for (const stop of dayGroup.stops) {
      // Number dot
      ctx.fillStyle = dayGroup.color;
      ctx.beginPath();
      ctx.arc(PAD + 14, y + 22, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `800 11px ${FONT}`;
      ctx.fillStyle = '#ffffff';
      const numStr = String(stop.index);
      ctx.fillText(numStr, PAD + 14 - ctx.measureText(numStr).width / 2, y + 26);

      // Card row
      const cardX = PAD + 34;
      const cardW = W - PAD * 2 - 34;
      drawRoundedRect(ctx, cardX, y + 2, cardW, 42, 10);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#ebe8e0';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Time
      ctx.font = `700 12px ${FONT}`;
      ctx.fillStyle = '#686b73';
      ctx.fillText(stop.time, cardX + 12, y + 27);

      // Tag on the right
      let rightCursor = cardX + cardW - 10;
      if (stop.tag) {
        ctx.font = `700 11px ${FONT}`;
        const tw = ctx.measureText(stop.tag).width + 14;
        rightCursor -= tw;
        drawRoundedRect(ctx, rightCursor, y + 12, tw, 20, 10);
        ctx.fillStyle = stop.tagTone === 'warn' ? '#fef3c7' : stop.tagTone === 'ok' ? '#dcfce7' : '#e0f2fe';
        ctx.fill();
        ctx.fillStyle = stop.tagTone === 'warn' ? '#92400e' : stop.tagTone === 'ok' ? '#166534' : '#075985';
        ctx.fillText(stop.tag, rightCursor + 7, y + 26);
        rightCursor -= 8;
      }

      // Stay text
      if (stop.stay) {
        ctx.font = `600 11px ${FONT}`;
        const sw = ctx.measureText(stop.stay).width;
        rightCursor -= sw;
        ctx.fillStyle = '#7a7d85';
        ctx.fillText(stop.stay, rightCursor, y + 27);
        rightCursor -= 10;
      }

      // Stop name
      ctx.font = `800 14px ${FONT}`;
      ctx.fillStyle = '#16181d';
      ctx.fillText(stop.name, cardX + 58, y + 28);

      y += 52;
    }
    y += 10;
  }

  if (model.omittedStopCount > 0) {
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = '#686b73';
    ctx.fillText(`还有 ${model.omittedStopCount} 站详见线上完整路书`, PAD + 34, y + 14);
    y += 28;
  }

  // Highlights box
  drawRoundedRect(ctx, PAD, y, W - PAD * 2, highlightsH - 8, 12);
  ctx.fillStyle = '#fffbeb';
  ctx.fill();
  ctx.strokeStyle = '#fde68a';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = `800 12px ${FONT}`;
  ctx.fillStyle = '#92400e';
  ctx.fillText('出发前必看重点', PAD + 14, y + 22);

  ctx.font = `600 12px ${FONT}`;
  ctx.fillStyle = '#451a03';
  model.highlights.forEach((line, idx) => {
    ctx.fillText(`• ${line}`, PAD + 14, y + 44 + idx * 22);
  });
  y += highlightsH + 8;

  // Footer + Optional QR
  ctx.strokeStyle = '#e2dfd7';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();

  const footerTop = y + 14;
  ctx.font = `800 15px ${FONT}`;
  ctx.fillStyle = '#16181d';
  ctx.fillText('可信路书 Lushu', PAD, footerTop + 20);

  ctx.font = `600 12px ${FONT}`;
  ctx.fillStyle = '#686b73';
  ctx.fillText('不编造票价与营业时间 · 已查与待查分明', PAD, footerTop + 42);
  ctx.fillText(model.qrMatrix ? '长按或用相机扫码，查看交互地图与每站导航' : '私密行程长图 · 未附公开或朋友链接', PAD, footerTop + 62);

  if (model.qrMatrix) {
    const qr = model.qrMatrix;
    const quiet = 3;
    const totalModules = qr.size + quiet * 2;
    const cell = Math.max(2, Math.floor(96 / totalModules));
    const boxSize = totalModules * cell;
    const boxX = W - PAD - boxSize;
    const boxY = footerTop + 2;

    drawRoundedRect(ctx, boxX - 4, boxY - 4, boxSize + 8, boxSize + 8, 8);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#e2dfd7';
    ctx.stroke();

    ctx.fillStyle = '#111318';
    for (let r = 0; r < qr.size; r += 1) {
      for (let c = 0; c < qr.size; c += 1) {
        if (qr.modules[r][c]) {
          ctx.fillRect(boxX + (c + quiet) * cell, boxY + (r + quiet) * cell, cell, cell);
        }
      }
    }
  }

  const dataUrl = canvas.toDataURL('image/png');
  const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  return { blob, dataUrl, width: canvas.width, height: canvas.height };
}

// 旅程回顾 → 小红书/朋友圈图文游记文案生成器 + 1080px 纯 Canvas 游记长图海报（含打卡实拍拼图与真二维码）+ 3:4 配图卡导出。
import { encodeQrMatrix } from './qrMatrix.js';
import { loadCheckinPhoto } from './photoStore.js';
import { fetchCheckinPhoto } from './photoApi.js';
import { formatStayText } from './routeMeta.js';

function stopKey(stop) {
  return String(stop?.id ?? '').trim();
}

function sanitizeNoteText(value) {
  // 保持与全站平实克制的标点风格一致，去掉全角感叹号等夸张符号。
  return String(value ?? '')
    .replace(/！+/g, '。')
    .replace(/!+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatQueueUnit(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) === 0 ? '0 分钟' : `${text} 分钟`;
  return text;
}

function formatCostUnit(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) === 0 ? '免费' : `${text} 元`;
  return text;
}

/**
 * 汇总回顾页与游记所需的结构化旅程实测数据。
 * @param {any} routebook
 * @param {any[]} stops
 * @param {Map<string, any>} latestByStop
 */
export function summarizeReviewJourney(routebook, stops = [], latestByStop = new Map()) {
  const city = String(routebook?.city || '旅行').trim();
  const title = sanitizeNoteText(routebook?.title || `${city}顺路漫游`);
  const days = [...new Set((stops || []).map((s) => s.day || 'Day 1'))];
  const dayCount = Math.max(1, days.length);

  const visitedItems = [];
  const skippedNames = [];
  let totalCostNum = 0;
  const worthNames = [];
  const pitfalls = [];

  for (const stop of stops || []) {
    const checkin = latestByStop.get(stopKey(stop));
    const wasSkipped = stop?.tripStatus === 'skipped' || checkin?.worth === '跳过' || checkin?.status === 'skipped';
    if (wasSkipped) {
      if (stop?.name) skippedNames.push(stop.name);
      continue;
    }
    if (!checkin) continue;

    const costNum = parseInt(String(checkin.cost ?? '').replace(/[^\d]/g, ''), 10);
    if (costNum > 0) totalCostNum += costNum;
    if (checkin.worth === '值得' && stop?.name) worthNames.push(stop.name);
    if (checkin.pitfall) {
      pitfalls.push(`${stop.name}：${sanitizeNoteText(checkin.pitfall)}`);
    } else if (checkin.worth === '踩坑' && stop?.name) {
      pitfalls.push(`${stop.name}：现场体验一般，建议降低预期或错峰`);
    }

    visitedItems.push({
      day: stop.day || 'Day 1',
      time: stop.time || '',
      stay: formatStayText(stop.stay || ''),
      area: stop.area || '',
      name: stop.name || '站点',
      worth: checkin.worth || '',
      crowd: checkin.crowd || '',
      queue: formatQueueUnit(checkin.queue),
      cost: formatCostUnit(checkin.cost),
      comment: sanitizeNoteText(checkin.comment || ''),
      pitfall: sanitizeNoteText(checkin.pitfall || '')
    });
  }

  // 若用户尚未逐站打卡就先预览游记，回退用路线前几站生成可编辑初稿，避免空白页。
  const fallbackPreview = visitedItems.length === 0;
  const effectiveStops = fallbackPreview
    ? (stops || []).slice(0, 8).map((stop) => ({
        day: stop.day || 'Day 1',
        time: stop.time || '',
        stay: formatStayText(stop.stay || ''),
        area: stop.area || '',
        name: stop.name || '站点',
        worth: '',
        crowd: '',
        queue: '',
        cost: formatCostUnit(stop.cost),
        comment: sanitizeNoteText(/^编辑建议[:：]/.test(stop?.verify ?? '') ? stop.verify.replace(/^编辑建议[:：]\s*/, '') : ''),
        pitfall: ''
      }))
    : visitedItems;

  const totalStops = (stops || []).length;
  const visitedCount = visitedItems.length;
  const isPartialProgress = !fallbackPreview && totalStops > 0 && visitedCount * 2 < totalStops;

  return {
    city,
    title,
    days,
    dayCount,
    totalStops,
    visitedCount,
    isPartialProgress,
    effectiveStops,
    fallbackPreview,
    skippedNames,
    worthNames,
    pitfalls,
    totalCostText: totalCostNum > 0 ? `约 ${totalCostNum} 元` : ''
  };
}

/**
 * 生成可直接发小红书 / 朋友圈的游记文案。
 * @param {any} routebook
 * @param {any[]} stops
 * @param {Map<string, any>} latestByStop
 * @param {'guide' | 'vibe'} [style]
 */
export function buildXiaohongshuNote(routebook, stops = [], latestByStop = new Map(), style = 'guide') {
  const info = summarizeReviewJourney(routebook, stops, latestByStop);
  const { city, dayCount, visitedCount, totalStops, isPartialProgress, effectiveStops, worthNames, pitfalls, skippedNames, totalCostText, fallbackPreview } =
    info;

  const tags = [
    `#${city}旅行`,
    `#${city}旅游攻略`,
    dayCount > 1 ? `#${city}${dayCount}天${Math.max(1, dayCount - 1)}晚` : `#${city}一日游`,
    '#周末去哪儿',
    '#城市漫游',
    '#不绕路路书'
  ];

  if (style === 'vibe') {
    const headline = isPartialProgress
      ? worthNames.length > 0
        ? `${city}边走边记｜刚打卡${worthNames.slice(0, 2).join('和')}`
        : `${city}顺路漫游记录｜已打卡 ${visitedCount}/${totalStops} 站`
      : worthNames.length > 0
        ? `${city}${dayCount > 1 ? `${dayCount}日` : '半日'}慢走记录｜最喜欢${worthNames.slice(0, 2).join('和')}`
        : `${city}${dayCount > 1 ? `${dayCount}日` : '一日'}散步随笔｜不赶场把顺路的风景走完`;

    const intro = fallbackPreview
      ? `整理了一份${city}${dayCount}天顺路漫游清单，按相邻片区串起来，不用来回折返赶路。`
      : isPartialProgress
        ? `正在走这趟${city}路线，目前已打卡 ${visitedCount}/${totalStops} 站${totalCostText ? `，已记花费${totalCostText}` : ''}。先把走过的真实体验记下来，后续站点边逛边补。`
        : `刚走完这趟${city}路线，一共打卡了 ${visitedCount}/${totalStops} 站${totalCostText ? `，记录花费${totalCostText}` : ''}。没有特种兵式赶场，顺着片区慢慢晃刚刚好。`;

    const paragraphs = effectiveStops.map((item) => {
      const details = [
        item.crowd ? `现场人流${item.crowd}` : '',
        item.queue ? (item.queue === '0 分钟' ? '基本不用排队' : `排队约${item.queue}`) : '',
        item.cost ? `花费 ${item.cost}` : ''
      ].filter(Boolean);
      const mood = item.comment || (item.worth === '值得' ? '这一站体验很舒服，值得留足时间慢慢逛。' : '顺路过来走走很合适。');
      return `📍 ${item.name}${item.time ? `（${item.time}）` : ''}\n${mood}${details.length ? `（${details.join(' · ')}）` : ''}`;
    });

    const routeLine = `🗺️ 顺路动线：${effectiveStops.map((s) => s.name).join(' → ')}`;
    const pitfallBlock = pitfalls.length ? `\n💡 实测小提醒：\n${pitfalls.map((p) => `- ${p}`).join('\n')}` : '';

    const fullText = [headline, '', intro, '', ...paragraphs, '', routeLine + pitfallBlock, '', tags.join(' ')].join('\n');
    return { headline, fullText, tags, fallbackPreview, isPartialProgress };
  }

  // 默认：实用干货版（保姆级时间轴 + 排队花费实测 + 避坑清单）
  const headline = fallbackPreview
    ? `${city}${dayCount > 1 ? ` ${dayCount} 天` : '一日'}不绕路路线单｜按片区排好的顺路动线`
    : isPartialProgress
      ? `${city}${dayCount > 1 ? ` ${dayCount} 天` : '一日'}顺路实测记录｜已打卡 ${visitedCount}/${totalStops} 站附现场体验`
      : `${city}${dayCount > 1 ? ` ${dayCount} 天` : '一日'}不绕路实测｜走完 ${visitedCount} 站附排队与避坑`;

  const summaryLines = [
    fallbackPreview
      ? `按同片区顺路原则排好的${city}路线，共 ${effectiveStops.length} 站，照着走不折返：`
      : isPartialProgress
        ? `正在按路书逛${city}，目前打卡 ${visitedCount}/${totalStops} 站${totalCostText ? `，已记花费${totalCostText}` : ''}${worthNames.length ? `，目前很推荐：${worthNames.slice(0, 3).join('、')}` : ''}。`
        : `刚按路书实测走完${city}，打卡 ${visitedCount}/${totalStops} 站${totalCostText ? `，实记花费${totalCostText}` : ''}${worthNames.length ? `，亲测最值得去：${worthNames.slice(0, 3).join('、')}` : ''}。`
  ];

  const groupedDays = [...new Set(effectiveStops.map((s) => s.day || 'Day 1'))];
  const dayBlocks = groupedDays.map((day) => {
    const dayItems = effectiveStops.filter((s) => (s.day || 'Day 1') === day);
    const lines = dayItems.map((item, idx) => {
      const meta = [
        item.worth === '值得' ? '推荐' : item.worth === '踩坑' ? '慎去' : '',
        item.crowd ? `人流${item.crowd}` : '',
        item.queue ? (item.queue === '0 分钟' ? '免排队' : `排${item.queue}`) : '',
        item.cost || '',
        item.stay ? `建议留${item.stay}` : ''
      ].filter(Boolean);
      const commentLine = item.comment ? `\n   ↳ ${item.comment}` : '';
      return `${idx + 1}. ${item.time ? `${item.time} ` : ''}${item.name}${meta.length ? `（${meta.join('｜')}）` : ''}${commentLine}`;
    });
    return `【${day}】\n${lines.join('\n')}`;
  });

  const tips = [...pitfalls];
  if (skippedNames.length) {
    tips.push(`体力分配：这次顺手跳过了「${skippedNames.slice(0, 2).join('、')}」，给核心站留足时间更从容`);
  }
  const tipSection = tips.length ? `\n📌 实测避坑与建议\n${tips.map((t) => `• ${t}`).join('\n')}` : '';

  const fullText = [headline, '', ...summaryLines, '', ...dayBlocks, tipSection, '', tags.join(' ')].filter((v) => v !== undefined).join('\n');
  return { headline, fullText, tags, fallbackPreview, isPartialProgress };
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrapLines(ctx, text, maxWidth, maxLines = 3) {
  const chars = Array.from(String(text ?? ''));
  const lines = [];
  let current = '';
  for (const ch of chars) {
    const candidate = current + ch;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = ch;
      if (lines.length >= maxLines) {
        lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
        return lines;
      }
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

function drawQrOnCanvas(ctx, url, x, y, boxSize) {
  const { size, modules } = encodeQrMatrix(url);
  const quiet = 3;
  const total = size + quiet * 2;
  const cell = Math.floor(boxSize / total);
  const actual = cell * total;
  const offsetX = x + Math.floor((boxSize - actual) / 2);
  const offsetY = y + Math.floor((boxSize - actual) / 2);

  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x, y, boxSize, boxSize, 18);
  ctx.fill();

  ctx.fillStyle = '#18181b';
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r]?.[c]) {
        ctx.fillRect(offsetX + (c + quiet) * cell, offsetY + (r + quiet) * cell, cell, cell);
      }
    }
  }
}

function drawCoverImage(ctx, img, x, y, w, h, radius = 20) {
  const iw = Number(img?.naturalWidth || img?.width || 0);
  const ih = Number(img?.naturalHeight || img?.height || 0);
  if (!iw || !ih) return false;
  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  const sx = Math.max(0, (iw - sw) / 2);
  const sy = Math.max(0, (ih - sh) / 2);
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
  return true;
}

function decodeHtmlImage(src) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('no Image constructor'));
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

async function loadSingleCheckinImage(checkin, profileId = '') {
  if (!checkin) return null;
  if (checkin.imageElement) return checkin.imageElement;
  if (typeof checkin.clientPhotoData === 'string' && checkin.clientPhotoData.startsWith('data:image/')) {
    return decodeHtmlImage(checkin.clientPhotoData).catch(() => null);
  }
  const localRef = String(checkin.clientPhotoRef || checkin.clientLocalId || '').trim();
  if (localRef) {
    const dataUrl = await loadCheckinPhoto(localRef).catch(() => '');
    if (dataUrl && dataUrl.startsWith('data:image/')) {
      const decoded = await decodeHtmlImage(dataUrl).catch(() => null);
      if (decoded) return decoded;
    }
  }
  const photoId = String(checkin.photoId || '').trim();
  if (photoId && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    let objectUrl = '';
    try {
      const blob = await fetchCheckinPhoto(photoId, { profileId, access: profileId ? 'owner' : 'public' });
      objectUrl = URL.createObjectURL(blob);
      return await decodeHtmlImage(objectUrl);
    } catch {
      return null;
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }
  return null;
}

export async function loadCheckinImagesForStops(stops = [], latestByStop = new Map(), { profileId = '', maxCount = 4 } = {}) {
  const results = [];
  for (const stop of stops || []) {
    if (results.length >= maxCount) break;
    const checkin = latestByStop.get(stopKey(stop));
    if (!checkin || checkin.status === 'skipped' || checkin.worth === '跳过') continue;
    const img = await loadSingleCheckinImage(checkin, profileId);
    if (img) results.push({ stop, checkin, img });
  }
  return results;
}

function drawPhotoCaptionPill(ctx, label, x, y, maxW) {
  const text = wrapLines(ctx, `📍 ${label}`, maxW - 28, 1)[0] || label;
  ctx.font = '700 20px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const pw = Math.min(maxW, Math.ceil(ctx.measureText(text).width) + 28);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.68)';
  roundRect(ctx, x, y, pw, 36, 18);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x + 14, y + 25);
}

function drawPhotoCollage(ctx, photoItems, x, y, totalW) {
  const count = photoItems.length;
  if (!count) return 0;
  const gap = 16;
  if (count === 1) {
    const h = 380;
    drawCoverImage(ctx, photoItems[0].img, x, y, totalW, h, 24);
    drawPhotoCaptionPill(ctx, photoItems[0].stop?.name || '现场实拍', x + 20, y + h - 54, totalW - 40);
    return h + 28;
  }
  if (count === 2) {
    const h = 320;
    const cellW = Math.floor((totalW - gap) / 2);
    photoItems.slice(0, 2).forEach((item, idx) => {
      const cx = x + idx * (cellW + gap);
      drawCoverImage(ctx, item.img, cx, y, cellW, h, 22);
      drawPhotoCaptionPill(ctx, item.stop?.name || '实拍', cx + 16, y + h - 50, cellW - 32);
    });
    return h + 28;
  }
  if (count === 3) {
    const h = 360;
    const leftW = Math.floor(totalW * 0.56);
    const rightW = totalW - leftW - gap;
    const rightH = Math.floor((h - gap) / 2);
    drawCoverImage(ctx, photoItems[0].img, x, y, leftW, h, 22);
    drawPhotoCaptionPill(ctx, photoItems[0].stop?.name || '实拍', x + 16, y + h - 50, leftW - 32);
    for (let i = 1; i <= 2; i += 1) {
      const ry = y + (i - 1) * (rightH + gap);
      drawCoverImage(ctx, photoItems[i].img, x + leftW + gap, ry, rightW, rightH, 20);
      drawPhotoCaptionPill(ctx, photoItems[i].stop?.name || '实拍', x + leftW + gap + 12, ry + rightH - 46, rightW - 24);
    }
    return h + 28;
  }
  const cellW = Math.floor((totalW - gap) / 2);
  const cellH = 230;
  photoItems.slice(0, 4).forEach((item, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const cx = x + col * (cellW + gap);
    const cy = y + row * (cellH + gap);
    drawCoverImage(ctx, item.img, cx, cy, cellW, cellH, 20);
    drawPhotoCaptionPill(ctx, item.stop?.name || '实拍', cx + 14, cy + cellH - 48, cellW - 28);
  });
  return cellH * 2 + gap + 28;
}

function canvasToPngOutput(canvas, failMsg = '长图编码失败') {
  const dataUrl = canvas.toDataURL('image/png');
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => {
        if (blob) resolve({ dataUrl, blob });
        else reject(new Error(failMsg));
      }, 'image/png');
    } else {
      resolve({ dataUrl, blob: null });
    }
  });
}

/**
 * 渲染 1080px 高清「旅程回顾游记长图海报」（自动拼入打卡照片 + 底部真二维码，返回 PNG Blob + DataURL）。
 * @param {any} routebook
 * @param {any[]} stops
 * @param {Map<string, any>} latestByStop
 * @param {{ shareUrl?: string, profileId?: string, preloadedPhotos?: any[] }} [opts]
 */
export async function renderReviewPoster(routebook, stops = [], latestByStop = new Map(), { shareUrl = '', profileId = '', preloadedPhotos } = {}) {
  const info = summarizeReviewJourney(routebook, stops, latestByStop);
  const shownStops = info.effectiveStops.slice(0, 8);
  const qrTarget = String(shareUrl || (typeof window !== 'undefined' ? window.location.origin : 'https://lushu.aiwuq.cn')).trim();
  const photoItems = Array.isArray(preloadedPhotos)
    ? preloadedPhotos.slice(0, 4)
    : await loadCheckinImagesForStops(stops, latestByStop, { profileId, maxCount: 4 });

  const W = 1080;
  const PAD = 64;
  const CARD_W = W - PAD * 2;
  const HEADER_H = 380;
  const COLLAGE_H = photoItems.length === 0 ? 0 : photoItems.length === 1 ? 408 : photoItems.length === 2 ? 348 : photoItems.length === 3 ? 388 : 504;
  const ROW_H = 148;
  const PITFALL_H = info.pitfalls.length ? 160 : 0;
  const FOOTER_H = 260;
  const H = HEADER_H + 56 + COLLAGE_H + shownStops.length * ROW_H + PITFALL_H + FOOTER_H;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持生成海报画布');

  // 背景米白纸张质感
  ctx.fillStyle = '#f8f7f3';
  ctx.fillRect(0, 0, W, H);

  // 顶部渐变横幅
  const heroGrad = ctx.createLinearGradient(0, 0, W, HEADER_H);
  heroGrad.addColorStop(0, '#136f4d');
  heroGrad.addColorStop(0.55, '#1b8f64');
  heroGrad.addColorStop(1, '#195ea8');
  ctx.fillStyle = heroGrad;
  ctx.fillRect(0, 0, W, HEADER_H);

  // 顶部胶囊
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  roundRect(ctx, PAD, 54, 330, 46, 23);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText(`可信路书 · ${info.city}真实漫游实录`, PAD + 24, 85);

  // 标题（最多 2 行）
  ctx.font = '900 54px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const titleLines = wrapLines(ctx, info.title, CARD_W, 2);
  let cursorY = 165;
  for (const line of titleLines) {
    ctx.fillText(line, PAD, cursorY);
    cursorY += 66;
  }

  // 统计摘要条
  const statPills = [
    info.fallbackPreview ? `共 ${info.totalStops} 站顺路动线` : `实测打卡 ${info.visitedCount}/${info.totalStops} 站`,
    info.worthNames.length ? `亲测推荐 ${info.worthNames.length} 处` : `${info.dayCount} 天不绕路`,
    info.totalCostText ? `实记花费 ${info.totalCostText}` : '按片区顺路编排'
  ];
  let pillX = PAD;
  const pillY = HEADER_H - 78;
  ctx.font = '700 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  for (const pill of statPills) {
    const pw = Math.ceil(ctx.measureText(pill).width) + 36;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    roundRect(ctx, pillX, pillY, pw, 46, 23);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(pill, pillX + 18, pillY + 31);
    pillX += pw + 14;
  }

  // 打卡实拍照片拼图（有实拍图时紧跟横幅下方展示）
  let y = HEADER_H + 40;
  if (photoItems.length > 0) {
    y += drawPhotoCollage(ctx, photoItems, PAD, y, CARD_W);
  }

  // 站点实测卡片列表
  shownStops.forEach((item, idx) => {
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, PAD, y, CARD_W, ROW_H - 18, 24);
    ctx.fill();

    // 序号圆点
    ctx.fillStyle = item.worth === '踩坑' ? '#c8432b' : '#157a51';
    ctx.beginPath();
    ctx.arc(PAD + 44, y + 48, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 24px -apple-system, BlinkMacSystemFont, sans-serif';
    const numStr = String(idx + 1);
    ctx.fillText(numStr, PAD + 44 - ctx.measureText(numStr).width / 2, y + 56);

    // 站名与时间
    ctx.fillStyle = '#18181b';
    ctx.font = '800 32px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const stopHead = `${item.day} ${item.time ? `${item.time} · ` : ''}${item.name}`;
    ctx.fillText(wrapLines(ctx, stopHead, CARD_W - 240, 1)[0] || item.name, PAD + 84, y + 56);

    // 右上评价胶囊
    const badgeLabel = item.worth || (item.stay ? `停留 ${item.stay}` : '顺路站');
    ctx.font = '700 22px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const bw = Math.ceil(ctx.measureText(badgeLabel).width) + 32;
    ctx.fillStyle = item.worth === '值得' ? '#e3f5ec' : item.worth === '踩坑' ? '#fdeae6' : '#f1f1ee';
    roundRect(ctx, PAD + CARD_W - bw - 24, y + 26, bw, 40, 20);
    ctx.fill();
    ctx.fillStyle = item.worth === '值得' ? '#136c46' : item.worth === '踩坑' ? '#b4341f' : '#52525b';
    ctx.fillText(badgeLabel, PAD + CARD_W - bw - 8, y + 53);

    // 副标题体验或花费
    const subParts = [
      item.crowd ? `人流${item.crowd}` : '',
      item.queue ? (item.queue === '0 分钟' ? '免排队' : `排${item.queue}`) : '',
      item.cost || '',
      item.comment || item.area || '按相邻片区顺路游览'
    ].filter(Boolean);
    ctx.fillStyle = '#52525b';
    ctx.font = '500 25px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const subLine = wrapLines(ctx, subParts.join(' · '), CARD_W - 110, 1)[0] || '';
    ctx.fillText(subLine, PAD + 84, y + 102);

    y += ROW_H;
  });

  // 避坑提示框
  if (info.pitfalls.length) {
    ctx.fillStyle = '#fff5d6';
    roundRect(ctx, PAD, y, CARD_W, PITFALL_H - 20, 24);
    ctx.fill();
    ctx.fillStyle = '#784c06';
    ctx.font = '800 26px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('实测避坑提醒', PAD + 28, y + 46);
    ctx.font = '600 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const pitLines = wrapLines(ctx, info.pitfalls.slice(0, 2).join('；'), CARD_W - 56, 2);
    pitLines.forEach((line, i) => {
      ctx.fillText(line, PAD + 28, y + 86 + i * 34);
    });
    y += PITFALL_H;
  }

  // 底部扫码同款路书区
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, PAD, y + 12, CARD_W, FOOTER_H - 52, 28);
  ctx.fill();

  ctx.fillStyle = '#18181b';
  ctx.font = '800 32px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('扫码查看同款顺路路书', PAD + 36, y + 84);
  ctx.fillStyle = '#52525b';
  ctx.font = '500 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('开放时间、预约提醒与高德一键导航已整理好', PAD + 36, y + 130);
  ctx.fillStyle = '#71717a';
  ctx.font = '500 22px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('评分仅来自真实到场打卡 · 可信路书', PAD + 36, y + 172);

  drawQrOnCanvas(ctx, qrTarget, PAD + CARD_W - 196, y + 28, 168);

  const out = await canvasToPngOutput(canvas);
  return { ...out, width: W, height: H, photoCount: photoItems.length };
}

/**
 * 导出小红书原生 3:4（1080×1440）多图配图卡片：首张为路线封面卡，后续按实拍照片/打卡站点逐张生成配图卡。
 * @param {any} routebook
 * @param {any[]} stops
 * @param {Map<string, any>} latestByStop
 * @param {{ shareUrl?: string, profileId?: string, preloadedPhotos?: any[] }} [opts]
 */
export async function renderReviewSlideCards(routebook, stops = [], latestByStop = new Map(), { shareUrl = '', profileId = '', preloadedPhotos } = {}) {
  const info = summarizeReviewJourney(routebook, stops, latestByStop);
  const qrTarget = String(shareUrl || (typeof window !== 'undefined' ? window.location.origin : 'https://lushu.aiwuq.cn')).trim();
  const photoItems = Array.isArray(preloadedPhotos)
    ? preloadedPhotos.slice(0, 6)
    : await loadCheckinImagesForStops(stops, latestByStop, { profileId, maxCount: 6 });

  const W = 1080;
  const H = 1440;
  const PAD = 68;
  const CARD_W = W - PAD * 2;
  const cards = [];

  // 第 1 张：3:4 封面总览图卡
  {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持生成配图画布');

    ctx.fillStyle = '#f8f7f3';
    ctx.fillRect(0, 0, W, H);

    const coverH = photoItems[0]?.img ? 720 : 520;
    if (photoItems[0]?.img) {
      drawCoverImage(ctx, photoItems[0].img, 0, 0, W, coverH, 0);
      const darkGrad = ctx.createLinearGradient(0, 0, 0, coverH);
      darkGrad.addColorStop(0, 'rgba(10,12,16,0.38)');
      darkGrad.addColorStop(0.55, 'rgba(10,12,16,0.42)');
      darkGrad.addColorStop(1, 'rgba(10,12,16,0.88)');
      ctx.fillStyle = darkGrad;
      ctx.fillRect(0, 0, W, coverH);
    } else {
      const grad = ctx.createLinearGradient(0, 0, W, coverH);
      grad.addColorStop(0, '#136f4d');
      grad.addColorStop(0.55, '#1b8f64');
      grad.addColorStop(1, '#195ea8');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, coverH);
    }

    ctx.fillStyle = '#ffc93c';
    roundRect(ctx, PAD, 68, 280, 48, 24);
    ctx.fill();
    ctx.fillStyle = '#18181b';
    ctx.font = '800 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(`${info.city} · ${info.dayCount} 天顺路笔记`, PAD + 24, 101);

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 58px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const titleLines = wrapLines(ctx, info.title, CARD_W, 2);
    let ty = coverH - (titleLines.length > 1 ? 156 : 92);
    for (const line of titleLines) {
      ctx.fillText(line, PAD, ty);
      ty += 70;
    }

    const bodyY = coverH + 44;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, PAD, bodyY, CARD_W, H - bodyY - 260, 28);
    ctx.fill();

    ctx.fillStyle = '#157a51';
    ctx.font = '800 28px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(info.fallbackPreview ? '顺路站点一览' : `已打卡 ${info.visitedCount}/${info.totalStops} 站实测动线`, PAD + 36, bodyY + 56);

    const previewStops = info.effectiveStops.slice(0, photoItems[0]?.img ? 4 : 6);
    previewStops.forEach((s, idx) => {
      const sy = bodyY + 112 + idx * 72;
      ctx.fillStyle = '#18181b';
      ctx.font = '800 30px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      const line = `${idx + 1}. ${s.time ? `${s.time} ` : ''}${s.name}`;
      ctx.fillText(wrapLines(ctx, line, CARD_W - 220, 1)[0] || s.name, PAD + 36, sy);
      const tag = s.worth || s.cost || s.stay || '';
      if (tag) {
        ctx.fillStyle = '#52525b';
        ctx.font = '600 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        const tw = ctx.measureText(tag).width;
        ctx.fillText(tag, PAD + CARD_W - tw - 36, sy);
      }
    });

    const footerY = H - 220;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, PAD, footerY, CARD_W, 168, 24);
    ctx.fill();
    ctx.fillStyle = '#18181b';
    ctx.font = '800 30px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('扫码看同款顺路路书', PAD + 32, footerY + 72);
    ctx.fillStyle = '#71717a';
    ctx.font = '500 22px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('含每日动线、开放时间与真实打卡记录', PAD + 32, footerY + 114);
    drawQrOnCanvas(ctx, qrTarget, PAD + CARD_W - 156, footerY + 16, 136);

    const out = await canvasToPngOutput(canvas, '封面图卡生成失败');
    cards.push({
      index: 1,
      label: '封面总览',
      fileName: `${info.city}-小红书图卡-01-封面.png`,
      ...out
    });
  }

  const detailSources =
    photoItems.length > 0
      ? photoItems.map(({ stop, checkin, img }) => ({
          name: stop?.name || '站点',
          day: stop?.day || 'Day 1',
          time: stop?.time || '',
          area: stop?.area || '',
          worth: checkin?.worth || '',
          queue: formatQueueUnit(checkin?.queue),
          cost: formatCostUnit(checkin?.cost || stop?.cost),
          crowd: checkin?.crowd || '',
          comment: sanitizeNoteText(checkin?.comment || ''),
          pitfall: sanitizeNoteText(checkin?.pitfall || ''),
          img
        }))
      : info.effectiveStops.slice(0, 3).map((s) => ({ ...s, pitfall: '', img: null }));

  for (let idx = 0; idx < detailSources.length; idx += 1) {
    const item = detailSources[idx];
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    ctx.fillStyle = '#f8f7f3';
    ctx.fillRect(0, 0, W, H);

    let cardTop = 92;
    if (item.img) {
      drawCoverImage(ctx, item.img, PAD, 68, CARD_W, 820, 32);
      cardTop = 924;
    } else {
      const bannerGrad = ctx.createLinearGradient(PAD, 68, PAD + CARD_W, 460);
      bannerGrad.addColorStop(0, '#18181b');
      bannerGrad.addColorStop(1, '#27272a');
      ctx.fillStyle = bannerGrad;
      roundRect(ctx, PAD, 68, CARD_W, 380, 32);
      ctx.fill();
      ctx.fillStyle = '#ffc93c';
      ctx.font = '800 26px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(`${info.city} · 第 ${idx + 1} 站实测`, PAD + 40, 146);
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 60px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(wrapLines(ctx, item.name, CARD_W - 80, 2)[0] || item.name, PAD + 40, 250);
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.font = '600 28px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText([item.day, item.time, item.area].filter(Boolean).join(' · '), PAD + 40, 326);
      cardTop = 488;
    }

    ctx.fillStyle = '#ffffff';
    roundRect(ctx, PAD, cardTop, CARD_W, H - cardTop - 68, 32);
    ctx.fill();

    ctx.fillStyle = '#18181b';
    ctx.font = '900 44px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(wrapLines(ctx, `📍 ${item.name}`, CARD_W - 80, 1)[0] || item.name, PAD + 40, cardTop + 76);

    const chips = [
      [item.day, item.time].filter(Boolean).join(' '),
      item.worth ? `评价：${item.worth}` : '',
      item.queue ? (item.queue === '0 分钟' ? '免排队' : `排队 ${item.queue}`) : '',
      item.cost ? `花费 ${item.cost}` : ''
    ].filter(Boolean);
    let cx = PAD + 40;
    ctx.font = '700 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    for (const chip of chips.slice(0, 4)) {
      const cw = Math.ceil(ctx.measureText(chip).width) + 32;
      if (cx + cw > PAD + CARD_W - 40) break;
      ctx.fillStyle = '#f1f5f9';
      roundRect(ctx, cx, cardTop + 108, cw, 44, 22);
      ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.fillText(chip, cx + 16, cardTop + 138);
      cx += cw + 12;
    }

    const bodyText =
      item.comment || (item.worth === '值得' ? '这一站现场体验很舒服，按顺路时间过来不用折返赶场。' : '顺路串联游览节奏自然，出发前可留意开放时间。');
    ctx.fillStyle = '#3f3f46';
    ctx.font = '500 30px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const commentLines = wrapLines(ctx, `“${bodyText}”`, CARD_W - 80, item.img ? 3 : 5);
    commentLines.forEach((line, i) => {
      ctx.fillText(line, PAD + 40, cardTop + 216 + i * 48);
    });

    if (item.pitfall) {
      const py = H - 168;
      ctx.fillStyle = '#fff5d6';
      roundRect(ctx, PAD + 36, py, CARD_W - 72, 68, 18);
      ctx.fill();
      ctx.fillStyle = '#784c06';
      ctx.font = '700 24px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(wrapLines(ctx, `留意：${item.pitfall}`, CARD_W - 112, 1)[0] || '', PAD + 56, py + 43);
    }

    const out = await canvasToPngOutput(canvas, '分站图卡生成失败');
    cards.push({
      index: idx + 2,
      label: item.name,
      fileName: `${info.city}-小红书图卡-${String(idx + 2).padStart(2, '0')}-${item.name}.png`.replace(/[\\/:*?"<>|]+/g, '-'),
      ...out
    });
  }

  return cards;
}

/**
 * 跨端纯数据排版描述层（无 DOM/Canvas 依赖，供微信小程序 2D Canvas 与 App 原生分享卡直接复用同一套结构化模型）。
 * @param {any} routebook
 * @param {any[]} stops
 * @param {Map<string, any>} latestByStop
 */
export function buildReviewSlideDeckModel(routebook, stops = [], latestByStop = new Map()) {
  const info = summarizeReviewJourney(routebook, stops, latestByStop);
  const cover = {
    type: 'cover',
    aspectRatio: '3:4',
    city: info.city,
    title: info.title,
    dayCount: info.dayCount,
    visitedCount: info.visitedCount,
    totalStops: info.totalStops,
    totalCostText: info.totalCostText,
    pitfalls: info.pitfalls,
    isPartialProgress: info.isPartialProgress,
    stopsPreview: info.effectiveStops.slice(0, 6).map((s) => ({
      day: s.day,
      time: s.time,
      name: s.name,
      worth: s.worth
    }))
  };
  const detailSlides = info.effectiveStops.slice(0, 5).map((s, idx) => ({
    type: 'stop',
    aspectRatio: '3:4',
    index: idx + 2,
    day: s.day,
    time: s.time,
    name: s.name,
    area: s.area,
    worth: s.worth,
    queue: s.queue,
    cost: s.cost,
    comment: s.comment,
    pitfall: s.pitfall || ''
  }));
  return { cover, slides: detailSlides };
}

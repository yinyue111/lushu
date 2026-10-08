import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  CHECKIN_PHOTO_ID_PATTERN,
  CHECKIN_PHOTO_GPS_MATCH_METERS,
  CHECKIN_PHOTO_DIR,
  CHECKIN_PHOTO_LOG_PATH,
  CHECKIN_PHOTO_QUOTA_MAX,
  CHECKIN_PHOTO_QUOTA_WINDOW_MS,
  MAX_CHECKIN_PHOTO_BYTES,
  CHECKIN_PHOTO_EXTENSIONS
} from '../config/index.mjs';
import { getResolvableRoutebook } from '../routebooks/normalize.mjs';
import { distanceMeters, isValidCoordinate, sanitizePublicId, truncateString, createHttpError } from '../lib/util.mjs';
import { appendJsonLine, findLatestJsonLine, readMatchingJsonLines } from '../storage/jsonl.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';
import { checkinPhotoExtension, detectImageMimeType, extractJpegExif, stripImageMetadata } from './image-metadata.mjs';
import { requestIdHeaders, securityHeaders } from '../http/response.mjs';

// rank13：photoId 只放行 [A-Za-z0-9_-]{1,64}，其余一律置空。
export function normalizeCheckinPhotoId(value) {
  const id = String(value ?? '').trim();
  return CHECKIN_PHOTO_ID_PATTERN.test(id) ? id : '';
}

function createCheckinPhotoId() {
  // 24 个 base64url 字符（randomBytes(18)），天然满足 [A-Za-z0-9_-]{1,64}。
  return randomBytes(18).toString('base64url');
}

async function findRouteStopForPhoto(routeId, stopId) {
  if (!routeId) return null;
  const routebook = await getResolvableRoutebook(routeId).catch(() => null);
  if (!routebook?.stops?.length) return null;
  const routeStops = [...(routebook.stops ?? []), ...(routebook.variants ?? []).flatMap((variant) => variant?.stops ?? [])];
  const requestedStopId = String(stopId ?? '').trim();
  if (!requestedStopId) return null;
  return routeStops.find((stop) => String(stop?.id ?? '') === requestedStopId) ?? null;
}

// 照片 EXIF GPS 与站点坐标比对；无可比数据返回 null。
async function checkinPhotoExifMatchesStop(exif, routeId, stopId) {
  if (!exif || !isValidCoordinate(Number(exif.lat), Number(exif.lng))) return null;
  const stop = await findRouteStopForPhoto(routeId, stopId).catch(() => null);
  const distance =
    stop && isValidCoordinate(Number(stop.lat), Number(stop.lng)) ? distanceMeters({ lat: Number(exif.lat), lng: Number(exif.lng) }, stop) : null;
  return Number.isFinite(distance) ? distance <= CHECKIN_PHOTO_GPS_MATCH_METERS : null;
}

async function checkinPhotoResponse(row, deduplicated) {
  const exif = row?.exif && typeof row.exif === 'object' ? row.exif : null;
  return {
    photo: {
      id: row.id,
      url: `/api/checkin-photos/${row.id}`,
      exifTakenAt: exif?.takenAt ?? '',
      exifMatchesStop: await checkinPhotoExifMatchesStop(exif, sanitizePublicId(row?.routeId), truncateString(row?.stopId, 80))
    },
    deduplicated
  };
}

// rank13①：解码校验（大小/魔数）→ (profileId, routeId, clientLocalId) 幂等反扫
// → 24 小时配额 → JPEG 提取 EXIF → 三格式元数据剥离（失败拒收）→ 落盘 + JSONL。
export async function storeCheckinPhoto(body, actor) {
  const routeId = sanitizePublicId(body?.routeId || body?.publicId);
  const stopId = truncateString(body?.stopId, 80);
  const clientLocalId = truncateString(body?.clientLocalId, 120);
  // 幂等：多标签页重复上传同一 clientLocalId 时直接返回既有照片。
  if (clientLocalId) {
    const existing = await findLatestJsonLine(
      CHECKIN_PHOTO_LOG_PATH,
      (item) => normalizeProfileId(item?.profileId) === actor.profileId && sanitizePublicId(item?.routeId) === routeId && item?.clientLocalId === clientLocalId
    ).catch(() => null);
    if (existing) return checkinPhotoResponse(existing, true);
  }
  // 简单配额：同一 profile 24 小时内最多 CHECKIN_PHOTO_QUOTA_MAX 张。
  const quotaWindowStartMs = Date.now() - CHECKIN_PHOTO_QUOTA_WINDOW_MS;
  const recentUploads = await readMatchingJsonLines(
    CHECKIN_PHOTO_LOG_PATH,
    (item) => normalizeProfileId(item?.profileId) === actor.profileId && Date.parse(item?.createdAt ?? '') >= quotaWindowStartMs,
    CHECKIN_PHOTO_QUOTA_MAX,
    100000
  );
  if (recentUploads.length >= CHECKIN_PHOTO_QUOTA_MAX) {
    throw createHttpError('24 小时内上传的打卡照片过多，请稍后再试', 429, 'PHOTO_QUOTA_EXCEEDED');
  }
  const rawImage = String(body?.imageBase64 ?? body?.data ?? '').trim();
  const base64 = (rawImage.includes(',') ? rawImage.split(',').pop() : rawImage).replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw createHttpError('照片内容为空或不是合法 base64', 400, 'PHOTO_INVALID');
  }
  if (Buffer.byteLength(base64, 'base64') > MAX_CHECKIN_PHOTO_BYTES) {
    throw createHttpError('照片超过大小限制', 413, 'PHOTO_TOO_LARGE');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw createHttpError('照片内容为空或不是合法 base64', 400, 'PHOTO_INVALID');
  if (buffer.length > MAX_CHECKIN_PHOTO_BYTES) {
    throw createHttpError('照片超过大小限制', 413, 'PHOTO_TOO_LARGE');
  }
  const mimeType = detectImageMimeType(buffer);
  if (!mimeType) {
    throw createHttpError('仅支持 JPEG/PNG/WebP 图片，且文件头必须与格式匹配', 400, 'PHOTO_INVALID');
  }
  const exif = mimeType === 'image/jpeg' ? extractJpegExif(buffer) : null;
  // fail-closed：任一格式解析/剥离失败即拒收，不再落存可能携带元数据的原图。
  const stored = stripImageMetadata(buffer, mimeType);
  if (!stored || !stored.length) {
    throw createHttpError('照片结构异常，无法安全剥离元数据，已拒绝存储', 400, 'PHOTO_INVALID');
  }
  const id = createCheckinPhotoId();
  await mkdir(CHECKIN_PHOTO_DIR, { recursive: true });
  await writeFile(join(CHECKIN_PHOTO_DIR, `${id}${checkinPhotoExtension(mimeType)}`), stored);
  const row = {
    id,
    profileId: actor.profileId,
    routeId,
    stopId,
    clientLocalId,
    mimeType,
    bytes: stored.length,
    exif: exif ? { takenAt: exif.takenAt || '', lat: exif.lat, lng: exif.lng } : null,
    createdAt: new Date().toISOString()
  };
  await appendJsonLine(CHECKIN_PHOTO_LOG_PATH, row);
  return checkinPhotoResponse(row, false);
}

export async function sendCheckinPhotoFile(res, photoId) {
  for (const [mimeType, extension] of CHECKIN_PHOTO_EXTENSIONS) {
    const filePath = join(CHECKIN_PHOTO_DIR, `${photoId}${extension}`);
    if (!existsSync(filePath)) continue;
    const bodyBuffer = await readFile(filePath);
    res.writeHead(200, {
      ...securityHeaders(),
      ...requestIdHeaders(res),
      'content-type': mimeType,
      'content-length': bodyBuffer.length,
      'cache-control': 'public, max-age=31536000, immutable'
    });
    res.end(bodyBuffer);
    return true;
  }
  return false;
}

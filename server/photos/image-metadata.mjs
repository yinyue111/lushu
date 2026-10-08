import { CHECKIN_PHOTO_EXTENSIONS } from '../config/index.mjs';
import { isValidCoordinate } from '../lib/util.mjs';

export function hasImageMagicBytes(buffer, mimeType) {
  const type = String(mimeType ?? '').toLowerCase();
  if (type === 'image/png') {
    return (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }
  if (type === 'image/jpeg' || type === 'image/jpg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (type === 'image/webp') {
    return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

// rank13①：不信客户端 mimeType，按魔数探测真实图片类型。
export function detectImageMimeType(buffer) {
  for (const [mimeType] of CHECKIN_PHOTO_EXTENSIONS) {
    if (hasImageMagicBytes(buffer, mimeType)) return mimeType;
  }
  return '';
}

export function checkinPhotoExtension(mimeType) {
  return CHECKIN_PHOTO_EXTENSIONS.find(([type]) => type === mimeType)?.[1] ?? '';
}

// rank13①：紧凑 APP1/TIFF 解析，仅提取 DateTimeOriginal 与 GPS 经纬度；
// 任何结构异常都静默返回 null，不阻断上传。
export function extractJpegExif(buffer) {
  try {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) return null;
      const marker = buffer[offset + 1];
      if (marker === 0xd8) {
        offset += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return null;
      const segmentSize = buffer.readUInt16BE(offset + 2);
      if (segmentSize < 2 || offset + 2 + segmentSize > buffer.length) return null;
      if (marker === 0xe1 && buffer.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0') {
        return parseExifTiff(buffer.subarray(offset + 10, offset + 2 + segmentSize));
      }
      offset += 2 + segmentSize;
    }
  } catch {
    // EXIF 解析失败静默继续。
  }
  return null;
}

function parseExifTiff(tiff) {
  if (tiff.length < 8) return null;
  const endianTag = tiff.toString('latin1', 0, 2);
  const littleEndian = endianTag === 'II';
  if (!littleEndian && endianTag !== 'MM') return null;
  const readUInt16 = (at) => (littleEndian ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const readUInt32 = (at) => (littleEndian ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (readUInt16(2) !== 42) return null;

  const readIfdEntries = (ifdOffset) => {
    const entries = new Map();
    if (ifdOffset + 2 > tiff.length) return entries;
    const count = readUInt16(ifdOffset);
    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      if (entryOffset + 12 > tiff.length) break;
      entries.set(readUInt16(entryOffset), entryOffset);
    }
    return entries;
  };
  const entryValueOffset = (entryOffset, byteLength) => (byteLength <= 4 ? entryOffset + 8 : readUInt32(entryOffset + 8));
  const readAscii = (entryOffset) => {
    const count = readUInt32(entryOffset + 4);
    const valueOffset = entryValueOffset(entryOffset, count);
    if (!Number.isFinite(valueOffset) || valueOffset + count > tiff.length) return '';
    return tiff
      .toString('latin1', valueOffset, valueOffset + count)
      .replace(/\0+$/, '')
      .trim();
  };
  const readRationals = (entryOffset, expected) => {
    const count = readUInt32(entryOffset + 4);
    if (count < expected) return null;
    const valueOffset = readUInt32(entryOffset + 8);
    if (!Number.isFinite(valueOffset) || valueOffset + expected * 8 > tiff.length) return null;
    const values = [];
    for (let index = 0; index < expected; index += 1) {
      const numerator = readUInt32(valueOffset + index * 8);
      const denominator = readUInt32(valueOffset + index * 8 + 4);
      if (!denominator) return null;
      values.push(numerator / denominator);
    }
    return values;
  };

  const ifd0 = readIfdEntries(readUInt32(4));
  const exifIfd = ifd0.has(0x8769) ? readIfdEntries(readUInt32(ifd0.get(0x8769) + 8)) : new Map();
  const gpsIfd = ifd0.has(0x8825) ? readIfdEntries(readUInt32(ifd0.get(0x8825) + 8)) : new Map();

  let takenAt = '';
  const dateEntry = exifIfd.get(0x9003) ?? ifd0.get(0x0132);
  if (dateEntry != null) {
    const match = readAscii(dateEntry).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
    if (match) takenAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
  }

  let lat = null;
  let lng = null;
  if (gpsIfd.has(1) && gpsIfd.has(2) && gpsIfd.has(3) && gpsIfd.has(4)) {
    const latRef = readAscii(gpsIfd.get(1)).toUpperCase();
    const lngRef = readAscii(gpsIfd.get(3)).toUpperCase();
    const latDms = readRationals(gpsIfd.get(2), 3);
    const lngDms = readRationals(gpsIfd.get(4), 3);
    if (latDms && lngDms && /^[NS]/.test(latRef) && /^[EW]/.test(lngRef)) {
      const latValue = (latDms[0] + latDms[1] / 60 + latDms[2] / 3600) * (latRef.startsWith('S') ? -1 : 1);
      const lngValue = (lngDms[0] + lngDms[1] / 60 + lngDms[2] / 3600) * (lngRef.startsWith('W') ? -1 : 1);
      if (isValidCoordinate(latValue, lngValue)) {
        lat = Number(latValue.toFixed(6));
        lng = Number(lngValue.toFixed(6));
      }
    }
  }
  if (!takenAt && lat == null && lng == null) return null;
  return {
    takenAt,
    lat,
    lng
  };
}

// rank13①：剥离 JPEG 的 APP1-APP15 元数据段与 COM 注释段（保留 APP0/JFIF），
// 从 SOS 起原样保留。结构异常一律返回 null（fail-closed），由调用方拒收：
// 返回原图的旧兜底会把未知结构的元数据原样落盘。
function stripJpegMetadata(buffer) {
  try {
    const parts = [buffer.subarray(0, 2)];
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) return null;
      const marker = buffer[offset + 1];
      // 段间 0xFF 填充字节：跳过而不误读为段头。
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xda) {
        parts.push(buffer.subarray(offset));
        return Buffer.concat(parts);
      }
      // SOS 之前不应出现独立标记或 EOI；出现即视为结构异常。
      if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return null;
      const segmentSize = buffer.readUInt16BE(offset + 2);
      if (segmentSize < 2 || offset + 2 + segmentSize > buffer.length) return null;
      if (!(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe) {
        parts.push(buffer.subarray(offset, offset + 2 + segmentSize));
      }
      offset += 2 + segmentSize;
    }
    // 扫不到 SOS 说明不是可渲染 JPEG。
    return null;
  } catch {
    return null;
  }
}

// rank13①-A：PNG 按 chunk 流重组，丢弃 eXIf/tEXt/zTXt/iTXt 元数据 chunk，
// 其余原样保留；IEND 之后的尾部字节（常见 polyglot 藏匿点）一并丢弃。
// 任何结构异常返回 null（fail-closed）。
const PNG_METADATA_CHUNK_TYPES = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

function stripPngMetadata(buffer) {
  try {
    if (buffer.length < 8 + 12) return null;
    const parts = [buffer.subarray(0, 8)];
    let offset = 8;
    let sawIend = false;
    while (offset + 12 <= buffer.length) {
      const dataLength = buffer.readUInt32BE(offset);
      if (dataLength > 0x7fffffff) return null;
      const chunkEnd = offset + 12 + dataLength;
      if (chunkEnd > buffer.length) return null;
      const type = buffer.toString('latin1', offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(type)) return null;
      if (offset === 8 && type !== 'IHDR') return null;
      if (!PNG_METADATA_CHUNK_TYPES.has(type)) {
        parts.push(buffer.subarray(offset, chunkEnd));
      }
      offset = chunkEnd;
      if (type === 'IEND') {
        sawIend = true;
        break;
      }
    }
    if (!sawIend) return null;
    return Buffer.concat(parts);
  } catch {
    return null;
  }
}

// rank13①-A：WebP 按 RIFF chunk 重组，丢弃 EXIF/XMP chunk、清 VP8X 头对应
// 标志位（E=0x08 / X=0x04）并修正 RIFF size。任何结构异常返回 null（fail-closed）。
function stripWebpMetadata(buffer) {
  try {
    if (buffer.length < 12 + 8) return null;
    if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null;
    const firstFourcc = buffer.toString('latin1', 12, 16);
    if (!['VP8 ', 'VP8L', 'VP8X'].includes(firstFourcc)) return null;
    const parts = [];
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const fourcc = buffer.toString('latin1', offset, offset + 4);
      if (!/^[ -~]{4}$/.test(fourcc)) return null;
      const dataLength = buffer.readUInt32LE(offset + 4);
      const dataEnd = offset + 8 + dataLength;
      if (dataEnd > buffer.length) return null;
      const pad = dataLength % 2;
      // 末尾 chunk 允许缺 padding 字节；重组时统一补齐偶数对齐。
      const hasPadByte = pad === 1 && dataEnd + 1 <= buffer.length;
      const nextOffset = dataEnd + (hasPadByte ? 1 : 0);
      if (fourcc === 'EXIF' || fourcc === 'XMP ') {
        offset = nextOffset;
        continue;
      }
      let chunk = buffer.subarray(offset, dataEnd + (hasPadByte ? 1 : 0));
      if (pad === 1 && !hasPadByte) chunk = Buffer.concat([chunk, Buffer.alloc(1)]);
      if (fourcc === 'VP8X' && dataLength >= 1) {
        chunk = Buffer.from(chunk);
        chunk[8] &= ~0x0c;
      }
      parts.push(chunk);
      offset = nextOffset;
    }
    // 尾部残留不足一个 chunk 头：视为损坏或 polyglot，fail-closed。
    if (offset !== buffer.length || !parts.length) return null;
    const payloadLength = parts.reduce((sum, part) => sum + part.length, 0);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(payloadLength + 4, 4);
    header.write('WEBP', 8, 'latin1');
    return Buffer.concat([header, ...parts]);
  } catch {
    return null;
  }
}

// 三种格式统一入口：解析失败返回 null，由 storeCheckinPhoto fail-closed 拒收。
export function stripImageMetadata(buffer, mimeType) {
  if (mimeType === 'image/jpeg') return stripJpegMetadata(buffer);
  if (mimeType === 'image/png') return stripPngMetadata(buffer);
  if (mimeType === 'image/webp') return stripWebpMetadata(buffer);
  return null;
}

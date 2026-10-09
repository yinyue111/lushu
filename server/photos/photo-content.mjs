import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { CHECKIN_PHOTO_DIR, CHECKIN_PHOTO_EXTENSIONS, CHECKIN_PHOTO_ID_PATTERN, MAX_CHECKIN_PHOTO_BYTES } from '../config/index.mjs';

// Use a descriptor so removal after open is safe and file symlinks are never
// followed. This helper only reads bytes; callers must enforce access control.
export async function readCheckinPhotoContent(photoId) {
  if (!CHECKIN_PHOTO_ID_PATTERN.test(String(photoId ?? ''))) return null;
  const directory = await lstat(CHECKIN_PHOTO_DIR).catch((error) => {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  });
  if (!directory?.isDirectory() || directory.isSymbolicLink()) return null;
  for (const [mimeType, extension] of CHECKIN_PHOTO_EXTENSIONS) {
    const filePath = join(CHECKIN_PHOTO_DIR, `${photoId}${extension}`);
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
      throw error;
    });
    if (!handle) continue;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_CHECKIN_PHOTO_BYTES) continue;
      return { bodyBuffer: await handle.readFile(), mimeType };
    } finally {
      await handle.close();
    }
  }
  return null;
}

// Latest-record-by-id lookups backed by the in-memory offset index (H5).
import { createJsonlKeyIndex } from './jsonl-index.mjs';
import { sanitizePublicId } from '../lib/util.mjs';
import { ROUTEBOOK_LOG_PATH, PROFILE_LOG_PATH, REVIEW_LOG_PATH, POI_CORRECTION_LOG_PATH } from '../config/index.mjs';
import { normalizeProfileId } from '../auth/tokens.mjs';

// H5: id → latest-row indexes for the unbounded "latest snapshot by id" lookups.
export const routebookIndex = createJsonlKeyIndex({ filePath: ROUTEBOOK_LOG_PATH, keyFn: (row) => sanitizePublicId(row?.id || row?.publicId) });
export const profileIndex = createJsonlKeyIndex({
  filePath: PROFILE_LOG_PATH,
  keyFn: (row) => {
    const id = normalizeProfileId(row?.id || row?.profileId);
    return id === 'anonymous' ? '' : id;
  }
});
export const reviewIndex = createJsonlKeyIndex({ filePath: REVIEW_LOG_PATH, keyFn: (row) => sanitizePublicId(row?.id || row?.publicId) });
export const poiCorrectionIndex = createJsonlKeyIndex({ filePath: POI_CORRECTION_LOG_PATH, keyFn: (row) => sanitizePublicId(row?.id) });

export async function getSavedRoutebook(publicId) {
  const id = sanitizePublicId(publicId);
  if (!id) return null;
  // 按 id 查最新快照必须允许扫到文件头：旧路书被全局尾窗挤出后返回 404，
  // 客户端会用同一 ID 重建草稿并把历史版本链打断。反向分块读取内存仍有界。
  // H5：用 id → 最新行字节偏移的内存索引代替每次全文件倒扫。
  return routebookIndex.get(id);
}

export async function getSavedProfile(profileId) {
  const id = normalizeProfileId(profileId);
  if (!id || id === 'anonymous') return null;
  // 同 getSavedRoutebook：老 profile 被尾窗挤出会被误判为未注册，扫到文件头。
  return profileIndex.get(id);
}

export async function getSavedReview(publicId) {
  const id = sanitizePublicId(publicId);
  if (!id) return null;
  return reviewIndex.get(id);
}

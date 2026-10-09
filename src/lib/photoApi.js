import { adminHeaders, checkinPhotoUrl, ownerHeaders } from './api.js';

/** @param {string} photoId @param {{profileId?: string, access?: 'owner'|'admin'|'public', signal?: AbortSignal}} options */
export async function fetchCheckinPhoto(photoId, { profileId = '', access = 'public', signal } = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(photoId ?? ''))) throw new Error('照片标识无效');
  const headers = access === 'public' ? {} : access === 'admin' ? adminHeaders() : ownerHeaders(profileId);
  const response = await fetch(checkinPhotoUrl(photoId), { headers, signal, cache: 'no-store' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || '照片不存在或当前账号无权访问'), { status: response.status, code: data.code });
  }
  const blob = await response.blob();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) throw new Error('照片响应格式不正确');
  return blob;
}

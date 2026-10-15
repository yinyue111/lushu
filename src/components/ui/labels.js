// Friendly Chinese labels for internal enum values. End-user pages must never
// show raw values such as `published`, `user-generated` or provider ids.

const PUBLISH_STATUS = {
  draft: '草稿',
  review: '已申请公开',
  pending: '已申请公开',
  published: '已公开',
  featured: '精选',
  archived: '已下架',
  rejected: '未通过'
};

const SOURCE_AUTHORIZATION = {
  'user-generated': '用户原创',
  authorized: '已获授权',
  licensed: '已获授权',
  official: '官方内容',
  curated: '编辑精选'
};

const SYNC_STATUS = {
  synced: '已同步',
  queued: '等待联网上传',
  pending: '等待联网上传',
  uploading: '上传中',
  failed: '上传失败，会自动重试',
  conflict: '需要处理冲突'
};

/** @param {string | undefined | null} value */
export function publishStatusLabel(value) {
  return PUBLISH_STATUS[String(value || 'draft')] ?? '草稿';
}

/** @param {string | undefined | null} value */
export function sourceAuthorizationLabel(value) {
  return SOURCE_AUTHORIZATION[String(value || 'user-generated')] ?? '用户原创';
}

/** @param {string | undefined | null} value */
export function syncStatusText(value) {
  return SYNC_STATUS[String(value || '')] ?? '';
}

/** @param {unknown} value */
export function isPublicStatus(value) {
  return value === 'published' || value === 'featured';
}

import { saveRoutebook } from './storage.js';

const CONFLICT_TITLE_SUFFIX = '（冲突副本）';

export function preserveRoutebookConflictDraft(routebook, actionLabel = '版本冲突') {
  const draft = createRoutebookConflictDraft(routebook, actionLabel);
  return {
    draft,
    saved: Boolean(draft && saveRoutebook(draft))
  };
}

export function createRoutebookConflictDraft(routebook, actionLabel = '版本冲突') {
  if (!routebook?.city || !Array.isArray(routebook.stops) || routebook.stops.length < 2) return null;
  const now = new Date().toISOString();
  const sourceId = String(routebook.publicId || routebook.id || '').trim();
  const sourceVersion = routebookVersion(routebook);
  const {
    id: _id,
    publicId: _publicId,
    editToken: _editToken,
    expectedVersion: _expectedVersion,
    profileAccessToken: _profileAccessToken,
    accessToken: _accessToken,
    apiKey: _apiKey,
    shareUrl: _shareUrl,
    publishedAt: _publishedAt,
    archivedAt: _archivedAt,
    versionAudit: _versionAudit,
    ...recoverable
  } = routebook;
  const id = conflictDraftId(sourceId);
  const title = conflictDraftTitle(routebook.title);

  return {
    ...recoverable,
    id,
    publicId: id,
    title,
    editToken: '',
    schemaVersion: 2,
    version: 0,
    parentVersion: null,
    publishStatus: 'draft',
    sourceAuthorization: 'user-generated',
    changeReason: '版本冲突保留副本',
    actorType: 'user',
    copyCount: 0,
    createdAt: now,
    updatedAt: now,
    provider: {
      ...(routebook.provider ?? {}),
      generatedAt: now,
      editedAt: now,
      copiedAt: now
    },
    conflictSource: {
      routebookId: sourceId,
      version: sourceVersion,
      action: String(actionLabel || '版本冲突').slice(0, 80),
      savedAt: now
    }
  };
}

function conflictDraftId(sourceId) {
  const source = String(sourceId || 'routebook').replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 36) || 'routebook';
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12) || Math.random().toString(36).slice(2, 14);
  return `conflict-${source}-${Date.now().toString(36)}-${random}`;
}

function conflictDraftTitle(title) {
  const base = String(title || '未命名路书').replace(/（冲突副本）$/u, '').slice(0, 68);
  return `${base}${CONFLICT_TITLE_SUFFIX}`;
}

function routebookVersion(routebook) {
  const value = Number(routebook?.version ?? routebook?.currentVersion ?? routebook?.revision);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

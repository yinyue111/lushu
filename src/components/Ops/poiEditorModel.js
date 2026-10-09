import { isValidCoordinate } from '../../lib/coordinates.js';
const trustedCities = ['杭州', '上海', '苏州'];

export const REVIEW_STATUS_OPTIONS = [
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已驳回' }
];

// 与 server/poi/catalog.mjs 的 POI_SOURCE_TYPES 保持一致。
export const SOURCE_TYPE_OPTIONS = [
  { value: 'official', label: '官方来源' },
  { value: 'first-party', label: '一方实拍' },
  { value: 'editorial', label: '编辑维护' },
  { value: 'field-check', label: '实地核验' },
  { value: 'user-report', label: '用户上报' },
  { value: 'derived', label: '推导数据' },
  { value: 'ai', label: 'AI 生成' },
  { value: 'fallback', label: '种子兜底' }
];

export const EVIDENCE_TYPE_OPTIONS = [
  { value: 'web', label: '网页' },
  { value: 'document', label: '受控文档' },
  { value: 'photo', label: '照片' },
  { value: 'receipt', label: '票据' },
  { value: 'field-note', label: '实地记录' },
  { value: 'api', label: '接口数据' },
  { value: 'other', label: '其他' }
];

const REVIEW_STATUS_VALUES = new Set(REVIEW_STATUS_OPTIONS.map((item) => item.value));

export function buildInitialPoiEditorForm(poi) {
  return {
    name: String(poi?.name ?? ''),
    city: String(poi?.city ?? trustedCities[0]),
    lat: hasValue(poi?.location?.lat) ? String(poi.location.lat) : '',
    lng: hasValue(poi?.location?.lng) ? String(poi.location.lng) : '',
    address: String(poi?.location?.address ?? ''),
    category: String(poi?.category ?? ''),
    aliases: (Array.isArray(poi?.aliases) ? poi.aliases : []).join('、'),
    reviewStatus: REVIEW_STATUS_VALUES.has(poi?.reviewStatus) ? poi.reviewStatus : 'pending',
    sourceType: sourceTypeValue(poi?.sourceType, 'editorial'),
    evidence: (Array.isArray(poi?.evidence) ? poi.evidence : []).map((item) => evidenceFormRow(item, true)),
    facts: (Array.isArray(poi?.facts) ? poi.facts : []).map((item) => factFormRow(item, true)),
    reviewNote: ''
  };
}

export function createEmptyEvidence(poiId = '') {
  return evidenceFormRow(
    {
      id: createChildId('evidence', poiId),
      type: 'web',
      sourceType: 'official',
      reviewStatus: 'pending'
    },
    false
  );
}

export function createEmptyFact(poiId = '') {
  return factFormRow(
    {
      id: createChildId('fact', poiId),
      sourceType: 'editorial',
      reviewStatus: 'pending',
      evidenceIds: []
    },
    false
  );
}

export function collectPoiReviewChanges(poi, form) {
  const changes = [];
  const originalPoiStatus = REVIEW_STATUS_VALUES.has(poi?.reviewStatus) ? poi.reviewStatus : 'pending';
  if (originalPoiStatus !== form.reviewStatus) {
    changes.push(`POI：${reviewStatusLabel(originalPoiStatus)} → ${reviewStatusLabel(form.reviewStatus)}`);
  }

  const originalEvidence = new Map((Array.isArray(poi?.evidence) ? poi.evidence : []).map((item) => [item?.id, item]));
  form.evidence.forEach((item, index) => {
    const previous = originalEvidence.get(item.id);
    const previousStatus = previous?.reviewStatus || previous?.status || 'pending';
    if ((previous && previousStatus !== item.reviewStatus) || (!previous && item.reviewStatus !== 'pending')) {
      changes.push(`证据「${evidenceDisplayName(item, index)}」：${reviewStatusLabel(previousStatus)} → ${reviewStatusLabel(item.reviewStatus)}`);
    }
  });

  const originalFacts = new Map((Array.isArray(poi?.facts) ? poi.facts : []).map((item) => [item?.id, item]));
  form.facts.forEach((item, index) => {
    const previous = originalFacts.get(item.id);
    const previousStatus = previous?.reviewStatus || previous?.status || 'pending';
    if ((previous && previousStatus !== item.reviewStatus) || (!previous && item.reviewStatus !== 'pending')) {
      changes.push(`事实「${item.field.trim() || `事实 ${index + 1}`}」：${reviewStatusLabel(previousStatus)} → ${reviewStatusLabel(item.reviewStatus)}`);
    }
  });
  return changes;
}

export function validatePoiEditorForm(poi, form) {
  const errors = [];
  const warnings = [];
  const reviewChanges = collectPoiReviewChanges(poi, form);
  if (reviewChanges.length && !form.reviewNote.trim()) {
    errors.push('审核状态发生变化，请填写审核备注。');
  }

  const evidenceById = new Map(form.evidence.map((item) => [item.id, item]));
  form.evidence.forEach((item, index) => {
    if (isEmptyEvidenceDraft(item)) return;
    const label = evidenceDisplayName(item, index);
    if (item.reviewStatus === 'approved' && !item.url.trim() && !item.documentId.trim()) {
      errors.push(`证据「${label}」审核通过前，必须填写 URL 或受控文档 ID。`);
    }
    if (item.reviewStatus === 'approved' && !item.capturedAt) {
      errors.push(`证据「${label}」审核通过前，必须填写采集日期。`);
    }
  });

  form.facts.forEach((item, index) => {
    if (isEmptyFactDraft(item)) return;
    const label = item.field.trim() || `事实 ${index + 1}`;
    const approvedEvidence = item.evidenceIds.some((id) => evidenceById.get(id)?.reviewStatus === 'approved');
    if (item.reviewStatus === 'approved' && !approvedEvidence) {
      errors.push(`事实「${label}」审核通过前，必须关联至少一条已通过证据。`);
    }
    if (item.reviewStatus === 'approved' && !item.validUntil) {
      warnings.push(`事实「${label}」没有有效期，保存后仍不会进入“新鲜/已核验”状态。`);
    }
  });

  if (form.reviewStatus === 'approved') {
    const verifiedCandidate = form.facts.some(
      (fact) =>
        !isEmptyFactDraft(fact) &&
        fact.reviewStatus === 'approved' &&
        fact.validUntil &&
        fact.evidenceIds.some((id) => evidenceById.get(id)?.reviewStatus === 'approved')
    );
    if (!verifiedCandidate) {
      warnings.push('POI 已设为通过，但尚无“已通过证据 + 已通过事实 + 有效期”的完整组合。');
    }
  }
  return { errors, warnings, reviewChanges };
}

export function buildPoiEditorPayload(poi, form, { auditCreatedAt = new Date().toISOString() } = {}) {
  const evidence = form.evidence
    .filter((item) => !isEmptyEvidenceDraft(item))
    .map((item) => ({
      id: item.id,
      type: item.type,
      sourceType: item.sourceType,
      url: item.url.trim(),
      documentId: item.documentId.trim(),
      title: item.title.trim(),
      capturedAt: item.capturedAt,
      publishedAt: item.publishedAt,
      publisher: item.publisher.trim(),
      note: item.note.trim(),
      reviewStatus: item.reviewStatus
    }));
  const retainedEvidenceIds = new Set(evidence.map((item) => item.id));
  const facts = form.facts
    .filter((item) => !isEmptyFactDraft(item))
    .map((item) => ({
      id: item.id,
      field: item.field.trim(),
      value: item.value.trim(),
      sourceType: item.sourceType,
      reviewStatus: item.reviewStatus,
      validFrom: item.validFrom,
      validUntil: item.validUntil,
      verifiedAt: item.verifiedAt,
      evidenceIds: [...new Set(item.evidenceIds.filter((id) => retainedEvidenceIds.has(id)))],
      note: item.note.trim()
    }));
  const audits = (Array.isArray(poi?.audits) ? poi.audits : []).map((item) => ({ ...item }));
  const reviewChanges = collectPoiReviewChanges(poi, form);
  const reviewNote = form.reviewNote.trim();
  if (reviewNote) {
    audits.push({
      action: reviewChanges.length ? 'manual-review' : 'manual-edit',
      reviewStatus: form.reviewStatus,
      note: reviewChanges.length ? `${reviewNote}｜${reviewChanges.join('；')}` : reviewNote,
      createdAt: auditCreatedAt,
      actorType: 'admin',
      source: 'ops-editor'
    });
  }
  const lat = Number(form.lat);
  const lng = Number(form.lng);
  const validLocation = isValidCoordinate(lat, lng);
  return {
    poiId: String(poi?.poiId || poi?.id || ''),
    city: form.city.trim(),
    name: form.name.trim(),
    aliases: form.aliases
      .split(/[、,，;；\n]/)
      .map((alias) => alias.trim())
      .filter(Boolean),
    category: form.category.trim(),
    location: {
      lat: validLocation ? lat : null,
      lng: validLocation ? lng : null,
      address: form.address.trim()
    },
    sourceType: form.sourceType,
    reviewStatus: form.reviewStatus,
    facts,
    evidence,
    audits,
    createdAt: poi?.createdAt || ''
  };
}

export function evidenceDisplayName(item, index = 0) {
  return item.title.trim() || item.publisher.trim() || item.documentId.trim() || item.url.trim() || `证据 ${index + 1}`;
}

function evidenceFormRow(item, existing) {
  return {
    id: String(item?.id || item?.evidenceId || createChildId('evidence')),
    type: EVIDENCE_TYPE_OPTIONS.some((option) => option.value === item?.type) ? item.type : 'web',
    sourceType: sourceTypeValue(item?.sourceType, 'editorial'),
    url: String(item?.url ?? item?.sourceUrl ?? ''),
    documentId: String(item?.documentId ?? item?.controlledDocumentId ?? ''),
    title: String(item?.title ?? item?.label ?? ''),
    capturedAt: dateInputValue(item?.capturedAt ?? item?.observedAt ?? item?.verifiedAt),
    publishedAt: dateInputValue(item?.publishedAt),
    publisher: String(item?.publisher ?? item?.sourceName ?? ''),
    note: String(item?.note ?? item?.summary ?? ''),
    reviewStatus: REVIEW_STATUS_VALUES.has(item?.reviewStatus || item?.status) ? item.reviewStatus || item.status : 'pending',
    existing
  };
}

function factFormRow(item, existing) {
  return {
    id: String(item?.id || item?.factId || createChildId('fact')),
    field: String(item?.field ?? item?.type ?? item?.key ?? ''),
    value: String(item?.value ?? ''),
    sourceType: sourceTypeValue(item?.sourceType, 'editorial'),
    reviewStatus: REVIEW_STATUS_VALUES.has(item?.reviewStatus || item?.status) ? item.reviewStatus || item.status : 'pending',
    validFrom: dateInputValue(item?.validFrom ?? item?.effectiveAt),
    validUntil: dateInputValue(item?.validUntil ?? item?.expiresAt),
    verifiedAt: dateInputValue(item?.verifiedAt),
    evidenceIds: Array.isArray(item?.evidenceIds) ? [...new Set(item.evidenceIds.filter(Boolean))] : item?.evidenceId ? [item.evidenceId] : [],
    note: String(item?.note ?? ''),
    existing
  };
}

function isEmptyEvidenceDraft(item) {
  return (
    !item.existing &&
    !item.url.trim() &&
    !item.documentId.trim() &&
    !item.title.trim() &&
    !item.publisher.trim() &&
    !item.note.trim() &&
    !item.capturedAt &&
    !item.publishedAt &&
    item.reviewStatus === 'pending'
  );
}

function isEmptyFactDraft(item) {
  return (
    !item.existing &&
    !item.field.trim() &&
    !item.value.trim() &&
    !item.note.trim() &&
    !item.validFrom &&
    !item.validUntil &&
    !item.verifiedAt &&
    item.evidenceIds.length === 0 &&
    item.reviewStatus === 'pending'
  );
}

function reviewStatusLabel(value) {
  return REVIEW_STATUS_OPTIONS.find((item) => item.value === value)?.label || String(value || '待审核');
}

function sourceTypeValue(value, fallback) {
  return SOURCE_TYPE_OPTIONS.some((item) => item.value === value) ? value : fallback;
}

function dateInputValue(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : text;
}

function createChildId(prefix, poiId = '') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const scope = String(poiId)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 40);
  return [prefix, scope, random].filter(Boolean).join('-');
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

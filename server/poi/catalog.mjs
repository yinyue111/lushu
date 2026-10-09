// Trusted POI catalog: seed data, operational POI batches, validation and coverage.
import { createHash, createHmac } from 'node:crypto';
import { statSync, existsSync, readFileSync } from 'node:fs';
import {
  stableJsonStringify,
  truncateString,
  isHttpUrl,
  sanitizePublicId,
  normalizeRoutebookActorType,
  isValidCoordinate,
  canonicalizeJsonValue,
  positiveInteger,
  nullablePercent,
  normalizeCityName,
  hashText
} from '../lib/util.mjs';
import { coordinateDistanceWarning } from '../geo/coordinates.mjs';
import { PROFILE_ID_SECRET, POI_LOG_PATH } from '../config/index.mjs';
import { safeTokenEqual } from '../auth/tokens.mjs';
import { readJsonLines, appendJsonLine, onJsonlAppend } from '../storage/jsonl.mjs';
import { usesPostgresStorage, withStorageEntityLock } from '../storage/runtime.mjs';

// openHours is only filled where the pattern is structural and stable (always-open
// streets and stations, museum rest days). Anything time-sensitive stays absent so the
// validator reports "无营业时间数据" instead of inventing a schedule; ops fills the rest
// through the POI fact pipeline, where each entry carries evidence and a review date.
// closedWeekdays uses 0=周日 .. 6=周六.
const ALWAYS_OPEN_HOURS = { alwaysOpen: true, closedWeekdays: [] };
const TRUSTED_POI_CATALOG = [
  { poiId: 'poi-hz-hangzhou-east', city: '杭州', name: '杭州东站', aliases: [], lat: 30.2936, lng: 120.2154, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-liulang-wenying', city: '杭州', name: '柳浪闻莺', aliases: ['柳浪闻莺公园'], lat: 30.242, lng: 120.1617, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-southern-song-street', city: '杭州', name: '南宋御街', aliases: [], lat: 30.2432, lng: 120.1696, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-beishan-street', city: '杭州', name: '北山街', aliases: ['北山街日落线'], lat: 30.2596, lng: 120.1472, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-faxi-temple', city: '杭州', name: '法喜寺', aliases: ['上天竺法喜讲寺'], lat: 30.2366, lng: 120.0954 },
  { poiId: 'poi-hz-longjing-tea', city: '杭州', name: '龙井茶园', aliases: ['龙井村茶园'], lat: 30.2248, lng: 120.1032 },
  { poiId: 'poi-hz-maojiabu', city: '杭州', name: '茅家埠', aliases: [], lat: 30.2468, lng: 120.1139, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-hz-caa-xiangshan', city: '杭州', name: '中国美院象山', aliases: ['中国美术学院象山校区'], lat: 30.1679, lng: 120.078 },
  {
    poiId: 'poi-hz-zhejiang-art-museum',
    city: '杭州',
    name: '浙江美术馆',
    aliases: [],
    lat: 30.2443,
    lng: 120.1591,
    openHours: { closedWeekdays: [1], note: '周一闭馆（法定节假日另行公告）' }
  },
  { poiId: 'poi-hz-hubin-intime', city: '杭州', name: '湖滨银泰', aliases: ['湖滨银泰in77'], lat: 30.2583, lng: 120.1641 },
  { poiId: 'poi-sh-wukang-road', city: '上海', name: '武康路', aliases: ['武康路历史文化名街'], lat: 31.2123, lng: 121.4382, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-sh-anfu-road', city: '上海', name: '安福路', aliases: [], lat: 31.217, lng: 121.4431, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-sh-exhibition-center', city: '上海', name: '上海展览中心', aliases: ['上海展览馆'], lat: 31.2264, lng: 121.4512 },
  { poiId: 'poi-sz-humble-admin-garden', city: '苏州', name: '拙政园', aliases: [], lat: 31.3243, lng: 120.6252 },
  { poiId: 'poi-sz-pingjiang-road', city: '苏州', name: '平江路', aliases: ['平江历史文化街区'], lat: 31.3156, lng: 120.6314, openHours: ALWAYS_OPEN_HOURS },
  { poiId: 'poi-sz-shantang-street', city: '苏州', name: '山塘街', aliases: ['七里山塘'], lat: 31.3267, lng: 120.6004, openHours: ALWAYS_OPEN_HOURS }
];

const OPERATIONAL_POI_CITIES = ['杭州', '上海', '苏州'];
export const OPERATIONAL_POI_CITY_SET = new Set(OPERATIONAL_POI_CITIES);
export const POI_REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);
const POI_SOURCE_TYPES = new Set(['official', 'first-party', 'editorial', 'field-check', 'user-report', 'derived', 'ai', 'fallback']);
const POI_EVIDENCE_TYPES = new Set(['web', 'document', 'photo', 'receipt', 'field-note', 'api', 'other']);
const POI_FACT_EXPIRING_SOON_DAYS = 30;

function fullContentHash(value) {
  return createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex');
}

function stablePoiChildId(prefix, poiId, value) {
  return `${prefix}-${fullContentHash(`${poiId}:${stableJsonStringify(value)}`).slice(0, 20)}`;
}

function poiValidationIssue(code, path, message) {
  return { code, path, message };
}

function normalizePoiDateValue(value) {
  const text = truncateString(value, 60);
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const timestamp = Date.parse(`${text}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text ? text : null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parsePoiBatchRows(input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, 'rows')) {
    if (!Array.isArray(input.rows)) {
      return {
        hashSource: stableJsonStringify(input.rows),
        parsedRows: [{ line: 1, raw: null, parseError: poiValidationIssue('ROWS_NOT_ARRAY', 'rows', 'rows 必须是数组') }]
      };
    }
    return {
      hashSource: stableJsonStringify(input.rows),
      parsedRows: input.rows.map((raw, index) => ({ line: index + 1, raw }))
    };
  }

  const content = String(input?.content ?? '');
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      hashSource: content,
      parsedRows: [{ line: 1, raw: null, parseError: poiValidationIssue('CONTENT_REQUIRED', 'content', 'content 或 rows 不能为空') }]
    };
  }
  try {
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : [parsed];
    return {
      hashSource: content,
      parsedRows: rows.map((raw, index) => ({ line: index + 1, raw }))
    };
  } catch {
    const parsedRows = [];
    content.split(/\r?\n/).forEach((lineText, index) => {
      if (!lineText.trim()) return;
      try {
        parsedRows.push({ line: index + 1, raw: JSON.parse(lineText) });
      } catch {
        parsedRows.push({
          line: index + 1,
          raw: null,
          parseError: poiValidationIssue('INVALID_JSON', `line[${index + 1}]`, '该行不是合法 JSON')
        });
      }
    });
    return { hashSource: content, parsedRows };
  }
}

function normalizePoiEvidence(raw, poiId, index, errors) {
  const path = `evidence[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(poiValidationIssue('EVIDENCE_NOT_OBJECT', path, '证据必须是对象'));
    return null;
  }
  const inputStatus = truncateString(raw.reviewStatus || raw.status, 24) || 'pending';
  if (!POI_REVIEW_STATUSES.has(inputStatus)) {
    errors.push(poiValidationIssue('INVALID_EVIDENCE_STATUS', `${path}.reviewStatus`, '证据状态只能是 pending/approved/rejected'));
  }
  const inputType = truncateString(raw.type, 24) || 'web';
  if (!POI_EVIDENCE_TYPES.has(inputType)) {
    errors.push(poiValidationIssue('INVALID_EVIDENCE_TYPE', `${path}.type`, '证据类型不在允许范围内'));
  }
  const sourceType = truncateString(raw.sourceType, 24) || 'editorial';
  if (!POI_SOURCE_TYPES.has(sourceType)) {
    errors.push(poiValidationIssue('INVALID_SOURCE_TYPE', `${path}.sourceType`, '证据来源类型不在允许范围内'));
  }
  const url = truncateString(raw.url || raw.sourceUrl, 500);
  if (url && !isHttpUrl(url)) {
    errors.push(poiValidationIssue('INVALID_HTTP_URL', `${path}.url`, '证据 URL 必须使用 http 或 https'));
  }
  const documentId = truncateString(raw.documentId || raw.controlledDocumentId || raw.sourceDocumentId, 160);
  const capturedAt = normalizePoiDateValue(raw.capturedAt || raw.observedAt || raw.verifiedAt);
  const publishedAt = normalizePoiDateValue(raw.publishedAt);
  if (capturedAt === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.capturedAt`, 'capturedAt 不是合法日期'));
  if (publishedAt === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.publishedAt`, 'publishedAt 不是合法日期'));
  if (inputStatus === 'approved' && !url && !documentId) {
    errors.push(poiValidationIssue('AUDITABLE_EVIDENCE_SOURCE_REQUIRED', path, '通过审核的证据必须包含 URL 或受控文档 ID'));
  }
  if (inputStatus === 'approved' && !capturedAt) {
    errors.push(poiValidationIssue('EVIDENCE_CAPTURED_AT_REQUIRED', `${path}.capturedAt`, '通过审核的证据必须记录采集时间'));
  }
  const identity = {
    type: inputType,
    sourceType,
    url,
    documentId,
    title: truncateString(raw.title || raw.label, 160),
    capturedAt: capturedAt || '',
    publishedAt: publishedAt || ''
  };
  return {
    id: sanitizePublicId(raw.id || raw.evidenceId) || stablePoiChildId('evidence', poiId, identity),
    ...identity,
    publisher: truncateString(raw.publisher || raw.sourceName, 100),
    note: truncateString(raw.note || raw.summary, 500),
    reviewStatus: POI_REVIEW_STATUSES.has(inputStatus) ? inputStatus : 'pending'
  };
}

function normalizePoiFact(raw, poiId, index, errors) {
  const path = `facts[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(poiValidationIssue('FACT_NOT_OBJECT', path, '事实必须是对象'));
    return null;
  }
  const field = truncateString(raw.field || raw.type || raw.key, 80);
  const value = truncateString(raw.value, 1000);
  if (!field) errors.push(poiValidationIssue('FACT_FIELD_REQUIRED', `${path}.field`, '事实字段不能为空'));
  if (!value) errors.push(poiValidationIssue('FACT_VALUE_REQUIRED', `${path}.value`, '事实值不能为空'));
  const inputStatus = truncateString(raw.reviewStatus || raw.status, 24) || 'pending';
  if (!POI_REVIEW_STATUSES.has(inputStatus)) {
    errors.push(poiValidationIssue('INVALID_FACT_STATUS', `${path}.reviewStatus`, '事实状态只能是 pending/approved/rejected'));
  }
  const sourceType = truncateString(raw.sourceType, 24) || 'editorial';
  if (!POI_SOURCE_TYPES.has(sourceType)) {
    errors.push(poiValidationIssue('INVALID_SOURCE_TYPE', `${path}.sourceType`, '事实来源类型不在允许范围内'));
  }
  const validFrom = normalizePoiDateValue(raw.validFrom || raw.effectiveAt);
  const validUntil = normalizePoiDateValue(raw.validUntil || raw.expiresAt);
  const verifiedAt = normalizePoiDateValue(raw.verifiedAt);
  if (validFrom === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.validFrom`, 'validFrom 不是合法日期'));
  if (validUntil === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.validUntil`, 'validUntil 不是合法日期'));
  if (verifiedAt === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.verifiedAt`, 'verifiedAt 不是合法日期'));
  if (validFrom && validUntil && Date.parse(validFrom) > Date.parse(validUntil)) {
    errors.push(poiValidationIssue('INVALID_DATE_RANGE', `${path}.validUntil`, 'validUntil 不能早于 validFrom'));
  }
  const evidenceIds = Array.isArray(raw.evidenceIds)
    ? [...new Set(raw.evidenceIds.map((id) => sanitizePublicId(id)).filter(Boolean))]
    : raw.evidenceId
      ? [sanitizePublicId(raw.evidenceId)].filter(Boolean)
      : [];
  const identity = { field, value, sourceType, evidenceIds };
  return {
    id: sanitizePublicId(raw.id || raw.factId) || stablePoiChildId('fact', poiId, identity),
    field,
    value,
    sourceType: POI_SOURCE_TYPES.has(sourceType) ? sourceType : 'editorial',
    reviewStatus: POI_REVIEW_STATUSES.has(inputStatus) ? inputStatus : 'pending',
    validFrom: validFrom || '',
    validUntil: validUntil || '',
    verifiedAt: verifiedAt || '',
    evidenceIds,
    note: truncateString(raw.note, 500)
  };
}

function normalizePoiAudit(raw, poiId, index, errors) {
  const path = `audits[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(poiValidationIssue('AUDIT_NOT_OBJECT', path, '审核记录必须是对象'));
    return null;
  }
  const status = truncateString(raw.reviewStatus || raw.status, 24);
  if (status && !POI_REVIEW_STATUSES.has(status)) {
    errors.push(poiValidationIssue('INVALID_AUDIT_STATUS', `${path}.reviewStatus`, '审核状态只能是 pending/approved/rejected'));
  }
  const createdAt = normalizePoiDateValue(raw.createdAt || raw.reviewedAt);
  if (createdAt === null) errors.push(poiValidationIssue('INVALID_DATE', `${path}.createdAt`, '审核时间不是合法日期'));
  const identity = {
    action: truncateString(raw.action, 40) || 'review',
    reviewStatus: POI_REVIEW_STATUSES.has(status) ? status : '',
    note: truncateString(raw.note || raw.reason, 500),
    createdAt: createdAt || ''
  };
  return {
    id: sanitizePublicId(raw.id || raw.auditId) || stablePoiChildId('audit', poiId, identity),
    ...identity,
    actorType: normalizeRoutebookActorType(raw.actorType || 'admin'),
    source: truncateString(raw.source, 40) || 'import'
  };
}

function validateUniquePoiChildren(items, kind, errors) {
  const seen = new Set();
  items.forEach((item, index) => {
    if (!item?.id) return;
    if (seen.has(item.id)) {
      errors.push(poiValidationIssue(`DUPLICATE_${kind}_ID`, `${kind.toLowerCase()}[${index}].id`, `${kind} ID 在同一 POI 中重复`));
    }
    seen.add(item.id);
  });
}

function normalizeOperationalPoiRow(raw, line = 1) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      line,
      status: 'error',
      errors: [poiValidationIssue('POI_NOT_OBJECT', `line[${line}]`, 'POI 行必须是对象')],
      warnings,
      normalized: null
    };
  }
  const cityText = truncateString(raw.city, 40).replace(/市$/u, '');
  if (!cityText) errors.push(poiValidationIssue('CITY_REQUIRED', 'city', '城市不能为空'));
  if (cityText && !OPERATIONAL_POI_CITY_SET.has(cityText)) {
    errors.push(poiValidationIssue('UNSUPPORTED_OPERATIONAL_CITY', 'city', '运营内容当前只支持杭州、上海、苏州'));
  }
  const name = truncateString(raw.name || raw.poiName, 120);
  if (!name) errors.push(poiValidationIssue('POI_NAME_REQUIRED', 'name', 'POI 名称不能为空'));
  const lat = Number(raw.location?.lat ?? raw.lat);
  const lng = Number(raw.location?.lng ?? raw.lng);
  if (!isValidCoordinate(lat, lng)) {
    errors.push(poiValidationIssue('INVALID_LOCATION', 'location', 'location.lat/lng 必须是合法经纬度'));
  } else if (cityText && OPERATIONAL_POI_CITY_SET.has(cityText)) {
    const distanceWarning = coordinateDistanceWarning(lat, lng, cityText);
    if (distanceWarning) {
      errors.push(poiValidationIssue('LOCATION_CITY_MISMATCH', 'location', `坐标不在${cityText}可接受范围内`));
    }
  }
  const reviewStatusInput = truncateString(raw.reviewStatus || raw.status, 24) || 'pending';
  if (!POI_REVIEW_STATUSES.has(reviewStatusInput)) {
    errors.push(poiValidationIssue('INVALID_POI_STATUS', 'reviewStatus', 'POI 状态只能是 pending/approved/rejected'));
  }
  const sourceType = truncateString(raw.sourceType, 24) || 'editorial';
  if (!POI_SOURCE_TYPES.has(sourceType)) {
    errors.push(poiValidationIssue('INVALID_SOURCE_TYPE', 'sourceType', 'POI 来源类型不在允许范围内'));
  }
  const fallbackPoiId = cityText && name ? `poi-${fullContentHash(`${cityText}:${normalizePoiName(name)}`).slice(0, 20)}` : '';
  const poiId = sanitizePublicId(raw.poiId || raw.id) || fallbackPoiId;
  if (!poiId) errors.push(poiValidationIssue('POI_ID_REQUIRED', 'poiId', '无法生成 POI ID'));
  const aliases = Array.isArray(raw.aliases) ? [...new Set(raw.aliases.map((alias) => truncateString(alias, 120)).filter(Boolean))].slice(0, 20) : [];
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).map((item, index) => normalizePoiEvidence(item, poiId, index, errors)).filter(Boolean);
  const facts = (Array.isArray(raw.facts) ? raw.facts : []).map((item, index) => normalizePoiFact(item, poiId, index, errors)).filter(Boolean);
  const audits = (Array.isArray(raw.audits) ? raw.audits : []).map((item, index) => normalizePoiAudit(item, poiId, index, errors)).filter(Boolean);
  validateUniquePoiChildren(evidence, 'EVIDENCE', errors);
  validateUniquePoiChildren(facts, 'FACT', errors);
  validateUniquePoiChildren(audits, 'AUDIT', errors);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  facts.forEach((fact, factIndex) => {
    fact.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!evidenceIds.has(evidenceId)) {
        errors.push(
          poiValidationIssue('UNKNOWN_EVIDENCE_REFERENCE', `facts[${factIndex}].evidenceIds[${evidenceIndex}]`, `事实引用了不存在的证据 ${evidenceId}`)
        );
      }
    });
  });
  if (!facts.length) warnings.push(poiValidationIssue('NO_FACTS', 'facts', 'POI 尚未录入可审核事实'));
  if (reviewStatusInput === 'pending') warnings.push(poiValidationIssue('POI_PENDING_REVIEW', 'reviewStatus', 'POI 仍处于待审核状态'));
  if (reviewStatusInput === 'approved' && !facts.some((fact) => fact.reviewStatus === 'approved' && fact.evidenceIds.length)) {
    warnings.push(poiValidationIssue('APPROVED_WITHOUT_EVIDENCE_BACKED_FACT', 'facts', '已审核 POI 尚无通过审核且关联证据的事实'));
  }
  const createdAt = normalizePoiDateValue(raw.createdAt);
  if (createdAt === null) errors.push(poiValidationIssue('INVALID_DATE', 'createdAt', 'createdAt 不是合法日期'));
  return {
    line,
    status: errors.length ? 'error' : 'new',
    errors,
    warnings,
    normalized: {
      schemaVersion: 1,
      poiId,
      city: cityText,
      name,
      aliases,
      category: truncateString(raw.category, 80),
      location: {
        lat: isValidCoordinate(lat, lng) ? lat : null,
        lng: isValidCoordinate(lat, lng) ? lng : null,
        address: truncateString(raw.location?.address || raw.address, 240)
      },
      sourceKind: 'operational',
      sourceType: POI_SOURCE_TYPES.has(sourceType) ? sourceType : 'editorial',
      reviewStatus: POI_REVIEW_STATUSES.has(reviewStatusInput) ? reviewStatusInput : 'pending',
      facts,
      evidence,
      audits,
      createdAt: createdAt || ''
    }
  };
}

function latestItemsById(existingItems = [], incomingItems = []) {
  const map = new Map();
  for (const item of [...existingItems, ...incomingItems]) {
    const id = sanitizePublicId(item?.id);
    if (id) map.set(id, item);
  }
  return [...map.values()];
}

function mergeOperationalPoiSnapshot(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    facts: latestItemsById(existing.facts, incoming.facts),
    evidence: latestItemsById(existing.evidence, incoming.evidence),
    audits: latestItemsById(existing.audits, incoming.audits),
    createdAt: existing.createdAt || incoming.createdAt
  };
}

function comparablePoiSnapshot(row) {
  if (!row) return null;
  const audits = (row.audits ?? []).filter((audit) => audit?.source !== 'batch-commit');
  return canonicalizeJsonValue({
    schemaVersion: positiveInteger(row.schemaVersion, 1),
    poiId: row.poiId,
    city: row.city,
    name: row.name,
    aliases: row.aliases ?? [],
    category: row.category ?? '',
    location: row.location,
    sourceKind: 'operational',
    sourceType: row.sourceType,
    reviewStatus: row.reviewStatus,
    facts: row.facts ?? [],
    evidence: row.evidence ?? [],
    audits,
    createdAt: row.createdAt ?? ''
  });
}

function poiBatchPayloadHash(rows) {
  return fullContentHash(
    stableJsonStringify(
      rows.map((row) => ({
        normalized: row.normalized,
        errors: row.errors.filter((error) => error.code !== 'POI_IDENTITY_CONFLICT').map((error) => ({ code: error.code, path: error.path }))
      }))
    )
  );
}

function poiBatchTargetHash(value) {
  return fullContentHash(stableJsonStringify(value)).slice(0, 32);
}

function poiBatchScalarValues(row) {
  return {
    schemaVersion: positiveInteger(row?.schemaVersion, 1),
    city: row?.city ?? '',
    name: row?.name ?? '',
    aliases: row?.aliases ?? [],
    category: row?.category ?? '',
    location: row?.location ?? null,
    sourceKind: row?.sourceKind ?? '',
    sourceType: row?.sourceType ?? '',
    reviewStatus: row?.reviewStatus ?? ''
  };
}

function poiBatchChildScope(existingItems, incomingItems) {
  const existingById = new Map((existingItems ?? []).map((item) => [sanitizePublicId(item?.id), item]));
  return (incomingItems ?? [])
    .map((item) => sanitizePublicId(item?.id))
    .filter(Boolean)
    .sort()
    .map((id) => [id, poiBatchTargetHash(existingById.has(id) ? existingById.get(id) : null)]);
}

function poiBatchScopedBaseline(rows, existingById) {
  return rows.map((row, index) => {
    const incoming = row.normalized;
    if (!incoming) return { index, poiId: '', scalars: [], facts: [], evidence: [], audits: [] };
    const existing = existingById.get(incoming.poiId);
    const existingScalars = existing ? poiBatchScalarValues(existing) : {};
    const scalarNames = Object.keys(poiBatchScalarValues(incoming)).sort();
    return {
      index,
      poiId: incoming.poiId,
      scalars: scalarNames.map((name) => [name, poiBatchTargetHash(existing ? existingScalars[name] : null)]),
      facts: poiBatchChildScope(existing?.facts, incoming.facts),
      evidence: poiBatchChildScope(existing?.evidence, incoming.evidence),
      audits: poiBatchChildScope(existing?.audits, incoming.audits)
    };
  });
}

function poiBatchIncomingScope(rows) {
  const incomingById = new Map(
    rows
      .map((row) => row.normalized)
      .filter(Boolean)
      .map((row) => [row.poiId, row])
  );
  return poiBatchScopedBaseline(rows, incomingById);
}

function flattenPoiBatchScope(scope) {
  const targets = new Map();
  for (const row of scope ?? []) {
    const prefix = `${row.index}:${row.poiId}`;
    for (const [name, hash] of row.scalars ?? []) targets.set(`${prefix}:scalar:${name}`, hash);
    for (const type of ['facts', 'evidence', 'audits']) {
      for (const [id, hash] of row[type] ?? []) targets.set(`${prefix}:${type}:${id}`, hash);
    }
  }
  return targets;
}

function poiBatchBaselineIsStale(baselineScope, currentScope, incomingScope) {
  const baseline = flattenPoiBatchScope(baselineScope);
  const current = flattenPoiBatchScope(currentScope);
  const incoming = flattenPoiBatchScope(incomingScope);
  for (const [target, baselineHash] of baseline) {
    const currentHash = current.get(target);
    if (!currentHash || (currentHash !== baselineHash && currentHash !== incoming.get(target))) return true;
  }
  return false;
}

function buildPoiBatchId(payloadHash, baselineHash) {
  return `poi-batch-v2-${payloadHash.slice(0, 16)}-${baselineHash.slice(0, 16)}`;
}

function buildPoiCommitToken(payloadHash, baselineHash, baselineScope) {
  const encoded = Buffer.from(JSON.stringify({ v: 2, p: payloadHash, h: baselineHash, b: baselineScope })).toString('base64url');
  const signature = createHmac('sha256', PROFILE_ID_SECRET).update(`poi-commit-v2:${encoded}`).digest('hex');
  return `poi-commit-v2.${encoded}.${signature}`;
}

function parsePoiCommitToken(commitToken) {
  const match = /^poi-commit-v2\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(String(commitToken ?? ''));
  if (!match) return null;
  const expectedSignature = createHmac('sha256', PROFILE_ID_SECRET).update(`poi-commit-v2:${match[1]}`).digest('hex');
  if (!safeTokenEqual(match[2], expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (payload?.v !== 2 || !/^[a-f0-9]{64}$/.test(payload?.p) || !/^[a-f0-9]{64}$/.test(payload?.h) || !Array.isArray(payload?.b)) return null;
    if (fullContentHash(stableJsonStringify(payload.b)) !== payload.h) return null;
    return { payloadHash: payload.p, baselineHash: payload.h, baselineScope: payload.b };
  } catch {
    return null;
  }
}

async function listPoiBatchEnvelopes(limit = 50000) {
  return (await readJsonLines(POI_LOG_PATH, limit)).filter((row) => row?.kind === 'poi-batch' && Array.isArray(row.rows));
}

async function listOperationalPoiSnapshots() {
  const envelopes = (await listPoiBatchEnvelopes()).reverse();
  const latestById = new Map();
  for (const envelope of envelopes) {
    for (const row of envelope.rows) {
      const poiId = sanitizePublicId(row?.poiId || row?.id);
      if (poiId) latestById.set(poiId, row);
    }
  }
  return [...latestById.values()];
}

function seedPoiSnapshot(seed) {
  return {
    schemaVersion: 1,
    poiId: seed.poiId,
    city: seed.city,
    name: seed.name,
    aliases: seed.aliases ?? [],
    category: '',
    location: { lat: seed.lat, lng: seed.lng, address: '' },
    sourceKind: 'seed',
    sourceType: 'fallback',
    reviewStatus: 'pending',
    facts: [],
    evidence: [],
    audits: [],
    createdAt: '',
    updatedAt: '',
    batchId: ''
  };
}

// rank12②：seed + 运营合并 POI 目录的进程内缓存。以 pois.jsonl 的 (mtimeMs, size)
// 指纹失效；本进程 appendJsonLine 落 POI 批次时主动失效，外部直写靠指纹兜底。
// 同步加载（readFileSync）是为了让 findTrustedPoi/resolvePoiId 等同步调用链
// 也能读到运营 POI；文件仅在批次提交时增长，重建频率低。
const mergedPoiCache = { fingerprint: null, pois: null, trustedLookup: null, checkedAtMs: 0 };
const MERGED_POI_FINGERPRINT_TTL_MS = 2000;

function invalidateMergedPoiCache() {
  mergedPoiCache.fingerprint = null;
  mergedPoiCache.pois = null;
  mergedPoiCache.trustedLookup = null;
  mergedPoiCache.checkedAtMs = 0;
}

onJsonlAppend(POI_LOG_PATH, async () => {
  invalidateMergedPoiCache();
  if (usesPostgresStorage()) await refreshPoiCatalog({ force: true });
});

let postgresPoiRefresh = null;

// Called before serving requests so synchronous coordinate resolution sees the
// current database snapshot. Local appends refresh immediately; other writers
// are observed through the same short TTL as the JSONL fingerprint cache.
export async function refreshPoiCatalog({ force = false } = {}) {
  if (!usesPostgresStorage()) return refreshMergedPoiCatalog();
  if (!force && mergedPoiCache.pois && Date.now() - mergedPoiCache.checkedAtMs < MERGED_POI_FINGERPRINT_TTL_MS) return mergedPoiCache;
  if (postgresPoiRefresh) return postgresPoiRefresh;
  postgresPoiRefresh = (async () => {
    const merged = new Map(TRUSTED_POI_CATALOG.map((seed) => [seed.poiId, seedPoiSnapshot(seed)]));
    for (const envelope of (await readJsonLines(POI_LOG_PATH, Number.POSITIVE_INFINITY)).reverse()) {
      if (envelope?.kind !== 'poi-batch' || !Array.isArray(envelope.rows)) continue;
      for (const row of envelope.rows) if (sanitizePublicId(row?.poiId)) merged.set(row.poiId, row);
    }
    mergedPoiCache.pois = [...merged.values()];
    mergedPoiCache.trustedLookup = buildTrustedPoiLookup(mergedPoiCache.pois);
    mergedPoiCache.checkedAtMs = Date.now();
    return mergedPoiCache;
  })();
  try {
    return await postgresPoiRefresh;
  } finally {
    postgresPoiRefresh = null;
  }
}

function poiLogFingerprintSync() {
  try {
    const stats = statSync(POI_LOG_PATH);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

export function refreshMergedPoiCatalog() {
  if (usesPostgresStorage()) {
    if (!mergedPoiCache.pois) throw new Error('POI catalog must be initialized before serving requests');
    return mergedPoiCache;
  }
  const now = Date.now();
  if (mergedPoiCache.pois && now - mergedPoiCache.checkedAtMs < MERGED_POI_FINGERPRINT_TTL_MS) {
    return mergedPoiCache;
  }
  const fingerprint = poiLogFingerprintSync();
  mergedPoiCache.checkedAtMs = now;
  if (mergedPoiCache.pois && mergedPoiCache.fingerprint === fingerprint) return mergedPoiCache;
  const merged = new Map(TRUSTED_POI_CATALOG.map((seed) => [seed.poiId, seedPoiSnapshot(seed)]));
  if (existsSync(POI_LOG_PATH)) {
    let text = '';
    try {
      text = readFileSync(POI_LOG_PATH, 'utf8');
    } catch {
      text = '';
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const envelope = JSON.parse(line);
        if (envelope?.kind !== 'poi-batch' || !Array.isArray(envelope.rows)) continue;
        for (const row of envelope.rows) {
          const poiId = sanitizePublicId(row?.poiId || row?.id);
          if (poiId) merged.set(poiId, row);
        }
      } catch {
        // Skip corrupted historical JSONL rows.
      }
    }
  }
  mergedPoiCache.pois = [...merged.values()];
  mergedPoiCache.trustedLookup = buildTrustedPoiLookup(mergedPoiCache.pois);
  mergedPoiCache.fingerprint = fingerprint;
  return mergedPoiCache;
}

export async function listMergedPois() {
  return (await refreshPoiCatalog()).pois;
}

// rank12①：把「运营已审核 POI」映射为 findTrustedPoi 可用的可信条目：
// location 事实映射为坐标，营业时间事实映射为 openHours。种子目录先建索引，
// 同名（同城规范化名称）时运营 approved 数据覆盖种子。
function buildTrustedPoiLookup(pois) {
  const lookup = new Map();
  const seedsById = new Map(TRUSTED_POI_CATALOG.map((seed) => [seed.poiId, seed]));
  const register = (entry) => {
    for (const name of [entry.name, ...(entry.aliases ?? [])]) {
      const normalizedName = normalizePoiName(name);
      if (normalizedName) lookup.set(`${entry.city}::${normalizedName}`, entry);
    }
  };
  for (const poi of pois ?? []) {
    if (poi?.sourceKind !== 'seed') continue;
    const seed = seedsById.get(poi.poiId);
    if (!seed) continue;
    register({
      poiId: seed.poiId,
      city: seed.city,
      name: seed.name,
      aliases: seed.aliases ?? [],
      lat: seed.lat,
      lng: seed.lng,
      openHours: seed.openHours,
      sourceKind: 'seed'
    });
  }
  for (const poi of pois ?? []) {
    if (poi?.sourceKind === 'seed' || poi?.reviewStatus !== 'approved') continue;
    register({
      poiId: poi.poiId,
      city: poi.city,
      name: poi.name,
      aliases: poi.aliases ?? [],
      lat: Number(poi?.location?.lat),
      lng: Number(poi?.location?.lng),
      openHours: operationalOpenHoursFromFacts(poi),
      facts: Array.isArray(poi.facts) ? poi.facts : [],
      evidence: Array.isArray(poi.evidence) ? poi.evidence : [],
      sourceKind: 'operational'
    });
  }
  return lookup;
}

const POI_WEEKDAY_CHAR_MAP = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

// 只有能确定闭馆日（或明确全天开放）时才产出 openHours；无法判定时返回 undefined，
// 让营业时间校验如实报告「无数据」而不是虚构班表。
function operationalOpenHoursFromFacts(poi) {
  const facts = Array.isArray(poi?.facts) ? poi.facts : [];
  const fact = facts.find(
    (item) => item?.reviewStatus === 'approved' && /开放时间|营业时间/.test(String(item?.field ?? '')) && String(item?.value ?? '').trim()
  );
  if (!fact) return undefined;
  const value = String(fact.value);
  if (/全天|24\s*小时|不打烊|全年无休/.test(value)) {
    return { alwaysOpen: true, closedWeekdays: [], note: truncateString(value, 60) };
  }
  const closedWeekdays = new Set();
  const closurePattern =
    /(?:周|星期|礼拜)([日天一二三四五六])(?:\s*[至到~-]\s*(?:周|星期|礼拜)?([日天一二三四五六]))?\s*(?:闭馆|闭园|闭店|关闭|停业|歇业|休息|休馆|不开放)/g;
  let match;
  while ((match = closurePattern.exec(value)) !== null) {
    const start = POI_WEEKDAY_CHAR_MAP[match[1]];
    const end = match[2] != null ? POI_WEEKDAY_CHAR_MAP[match[2]] : start;
    if (start == null || end == null) continue;
    let day = start;
    for (let step = 0; step < 7; step += 1) {
      closedWeekdays.add(day);
      if (day === end) break;
      day = (day + 1) % 7;
    }
  }
  if (!closedWeekdays.size) return undefined;
  return { closedWeekdays: [...closedWeekdays].sort(), note: truncateString(value, 60) };
}

function summarizePoiValidationRows(rows) {
  const summary = { total: rows.length, new: 0, update: 0, unchanged: 0, conflict: 0, error: 0 };
  for (const row of rows) summary[row.status] = (summary[row.status] ?? 0) + 1;
  return summary;
}

function poiReviewStatusChanges(existing, incoming) {
  if (!existing || !incoming) return [];
  const changes = [];
  if (existing.reviewStatus !== incoming.reviewStatus) changes.push('poi');
  for (const collection of ['evidence', 'facts']) {
    const previousById = new Map((existing[collection] ?? []).map((item) => [item.id, item]));
    for (const item of incoming[collection] ?? []) {
      const previous = previousById.get(item.id);
      if ((previous && previous.reviewStatus !== item.reviewStatus) || (!previous && item.reviewStatus !== 'pending')) {
        changes.push(`${collection}:${item.id}`);
      }
    }
  }
  return changes;
}

function hasNewPoiReviewAudit(existing, incoming) {
  const existingIds = new Set((existing.audits ?? []).map((item) => item.id));
  return (incoming.audits ?? []).some(
    (audit) => !existingIds.has(audit.id) && audit.source !== 'batch-commit' && Boolean(audit.note?.trim()) && Number.isFinite(Date.parse(audit.createdAt))
  );
}

export async function validatePoiBatch(input = {}, { includeBaselineScope = false } = {}) {
  const { parsedRows } = parsePoiBatchRows(input);
  const existingById = new Map((await listMergedPois()).map((row) => [row.poiId, row]));
  const rows = parsedRows.map((parsed) => {
    if (parsed.parseError) {
      return { line: parsed.line, status: 'error', errors: [parsed.parseError], warnings: [], normalized: null };
    }
    const result = normalizeOperationalPoiRow(parsed.raw, parsed.line);
    if (result.errors.length || !result.normalized) return result;
    const existing = existingById.get(result.normalized.poiId);
    if (existing && (existing.city !== result.normalized.city || normalizePoiName(existing.name) !== normalizePoiName(result.normalized.name))) {
      result.status = 'conflict';
      result.errors.push(poiValidationIssue('POI_IDENTITY_CONFLICT', 'poiId', '该 POI ID 已绑定到不同城市或名称'));
      return result;
    }
    if (!existing) {
      result.status = 'new';
      return result;
    }
    if (poiReviewStatusChanges(existing, result.normalized).length && !hasNewPoiReviewAudit(existing, result.normalized)) {
      result.status = 'error';
      result.errors.push(poiValidationIssue('REVIEW_AUDIT_NOTE_REQUIRED', 'audits', 'POI、证据或事实审核状态变化时，必须新增包含备注和时间的审核记录'));
      return result;
    }
    const merged = mergeOperationalPoiSnapshot(existing, result.normalized);
    result.status = stableJsonStringify(comparablePoiSnapshot(merged)) === stableJsonStringify(comparablePoiSnapshot(existing)) ? 'unchanged' : 'update';
    return result;
  });
  const rowsByPoiId = new Map();
  rows.forEach((row) => {
    const poiId = row.normalized?.poiId;
    if (!poiId) return;
    const matches = rowsByPoiId.get(poiId) ?? [];
    matches.push(row);
    rowsByPoiId.set(poiId, matches);
  });
  for (const [poiId, matches] of rowsByPoiId) {
    if (matches.length < 2) continue;
    for (const row of matches) {
      row.status = 'conflict';
      row.errors.push(poiValidationIssue('DUPLICATE_POI_ID', 'poiId', `批次内重复 POI ID：${poiId}`));
    }
  }
  const payloadHash = poiBatchPayloadHash(rows);
  const baselineScope = poiBatchScopedBaseline(rows, existingById);
  const baselineHash = fullContentHash(stableJsonStringify(baselineScope));
  const contentHash = fullContentHash(stableJsonStringify({ payloadHash, baselineHash }));
  const batchId = buildPoiBatchId(payloadHash, baselineHash);
  const commitToken = buildPoiCommitToken(payloadHash, baselineHash, baselineScope);
  const summary = summarizePoiValidationRows(rows);
  return {
    batchId,
    commitToken,
    contentHash,
    payloadHash,
    baselineHash,
    canCommit: rows.length > 0 && summary.error === 0 && summary.conflict === 0,
    summary,
    rows,
    ...(includeBaselineScope ? { baselineScope } : {})
  };
}

function dateValueEndTimestamp(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T15:59:59.999Z`);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isDerivedPoiSource(sourceType) {
  return ['derived', 'ai', 'fallback'].includes(sourceType);
}

function approvedEvidenceForFact(fact, evidenceById) {
  if (isDerivedPoiSource(fact?.sourceType)) return [];
  return (fact?.evidenceIds ?? [])
    .map((id) => evidenceById.get(id))
    .filter(
      (evidence) =>
        evidence?.reviewStatus === 'approved' &&
        !isDerivedPoiSource(evidence?.sourceType) &&
        Boolean(evidence?.url || evidence?.documentId) &&
        Number.isFinite(Date.parse(evidence?.capturedAt ?? ''))
    );
}

function poiFactFreshnessState(fact, evidenceById, nowMs = Date.now()) {
  if (fact?.reviewStatus !== 'approved') return fact?.reviewStatus === 'rejected' ? 'rejected' : 'pending';
  if (!approvedEvidenceForFact(fact, evidenceById).length) return 'pending';
  const expiry = dateValueEndTimestamp(fact.validUntil);
  if (!Number.isFinite(expiry)) return 'pending';
  if (expiry < nowMs) return 'stale';
  if (expiry <= nowMs + POI_FACT_EXPIRING_SOON_DAYS * 86400000) return 'expiringSoon';
  return 'fresh';
}

function derivePoiOperationalState(poi, nowMs = Date.now()) {
  const evidenceById = new Map((poi.evidence ?? []).map((evidence) => [evidence.id, evidence]));
  const factStates = (poi.facts ?? []).map((fact) => ({
    fact,
    state: poi.reviewStatus === 'approved' ? poiFactFreshnessState(fact, evidenceById, nowMs) : fact?.reviewStatus === 'rejected' ? 'rejected' : 'pending'
  }));
  const counts = {
    totalFacts: factStates.length,
    freshFacts: factStates.filter((item) => item.state === 'fresh').length,
    expiringSoonFacts: factStates.filter((item) => item.state === 'expiringSoon').length,
    staleFacts: factStates.filter((item) => item.state === 'stale').length,
    pendingFacts: factStates.filter((item) => item.state === 'pending').length
  };
  const evidenceBacked = factStates.some((item) => item.fact.reviewStatus === 'approved' && approvedEvidenceForFact(item.fact, evidenceById).length > 0);
  const currentlyVerified = counts.freshFacts + counts.expiringSoonFacts > 0;
  const trustState =
    poi.reviewStatus === 'rejected'
      ? 'rejected'
      : poi.reviewStatus !== 'approved'
        ? 'pending'
        : currentlyVerified
          ? 'verified'
          : counts.staleFacts > 0
            ? 'stale'
            : 'collecting';
  const freshnessState = counts.freshFacts > 0 ? 'fresh' : counts.expiringSoonFacts > 0 ? 'expiringSoon' : counts.staleFacts > 0 ? 'stale' : 'pending';
  return { ...counts, evidenceBacked, currentlyVerified, trustState, freshnessState };
}

// Number of reviewed facts on a trusted POI entry that currently count as
// verified: approved, backed by approved non-derived evidence, and inside their
// validity window. Seed entries carry no evidence and therefore count 0.
export function countVerifiedPoiFacts(trusted, nowMs = Date.now()) {
  if (!trusted || trusted.sourceKind !== 'operational') return 0;
  const evidenceById = new Map((trusted.evidence ?? []).map((evidence) => [evidence.id, evidence]));
  return (trusted.facts ?? []).filter((fact) => {
    const state = poiFactFreshnessState(fact, evidenceById, nowMs);
    return state === 'fresh' || state === 'expiringSoon';
  }).length;
}

// F02: value of an approved fact that is backed by approved, traceable evidence
// and still inside its validity window. Stale or evidence-free facts return ''.
export function currentPoiFactValue(poi, fieldPattern, nowMs = Date.now()) {
  if (!poi || poi.reviewStatus !== 'approved') return '';
  const evidenceById = new Map((poi.evidence ?? []).map((evidence) => [evidence.id, evidence]));
  const fact = (Array.isArray(poi.facts) ? poi.facts : []).find((item) => {
    if (!fieldPattern.test(String(item?.field ?? '')) || !String(item?.value ?? '').trim()) return false;
    const state = poiFactFreshnessState(item, evidenceById, nowMs);
    return state === 'fresh' || state === 'expiringSoon';
  });
  return fact ? String(fact.value).trim() : '';
}

export function publicOperationalPoiView(poi, nowMs = Date.now()) {
  const state = derivePoiOperationalState(poi, nowMs);
  return {
    ...poi,
    ...state,
    pendingReview: poi.reviewStatus === 'pending'
  };
}

function summarizePoiCoverage(pois, city) {
  const totalPois = pois.length;
  const approvedPois = pois.filter((poi) => poi.reviewStatus === 'approved').length;
  const evidenceBackedPois = pois.filter((poi) => poi.reviewStatus === 'approved' && poi.evidenceBacked).length;
  const verifiedPois = pois.filter((poi) => poi.reviewStatus === 'approved' && poi.currentlyVerified).length;
  const totalFacts = pois.reduce((sum, poi) => sum + poi.totalFacts, 0);
  const freshFacts = pois.reduce((sum, poi) => sum + poi.freshFacts, 0);
  const expiringSoonFacts = pois.reduce((sum, poi) => sum + poi.expiringSoonFacts, 0);
  const staleFacts = pois.reduce((sum, poi) => sum + poi.staleFacts, 0);
  const pendingFacts = pois.reduce((sum, poi) => sum + poi.pendingFacts, 0);
  const pendingReview = pois.filter((poi) => poi.reviewStatus === 'pending').length;
  const trustStates = { verified: 0, collecting: 0, pending: 0, stale: 0, rejected: 0 };
  pois.forEach((poi) => {
    trustStates[poi.trustState] = (trustStates[poi.trustState] ?? 0) + 1;
  });
  return {
    city,
    totalPois,
    approvedPois,
    evidenceBackedPois,
    verifiedPois,
    totalFacts,
    freshFacts,
    expiringSoonFacts,
    staleFacts,
    pendingFacts,
    pendingReview,
    trustStates,
    approvedPercent: nullablePercent(approvedPois, totalPois),
    evidenceCoveragePercent: nullablePercent(evidenceBackedPois, totalPois),
    verifiedCoveragePercent: nullablePercent(verifiedPois, totalPois),
    currentFactPercent: nullablePercent(freshFacts + expiringSoonFacts, totalFacts)
  };
}

export async function buildPoiCoverageSnapshot() {
  const snapshotAt = new Date().toISOString();
  const nowMs = Date.parse(snapshotAt);
  const pois = (await listMergedPois()).map((poi) => publicOperationalPoiView(poi, nowMs));
  const cities = OPERATIONAL_POI_CITIES.map((city) =>
    summarizePoiCoverage(
      pois.filter((poi) => poi.city === city),
      city
    )
  );
  const totals = summarizePoiCoverage(
    pois.filter((poi) => OPERATIONAL_POI_CITY_SET.has(poi.city)),
    '全部'
  );
  return {
    snapshotAt,
    supportedCities: OPERATIONAL_POI_CITIES,
    cities,
    totals,
    rules: {
      expiringSoonDays: POI_FACT_EXPIRING_SOON_DAYS,
      verifiedCoverage: 'approved POI + approved non-derived evidence with URL/documentId and capturedAt + approved linked fact + unexpired validUntil',
      seedReviewStatus: 'pending'
    }
  };
}

// rank27⑥：锁外/锁内两处「同 batchId 重放」分支完全同构，抽出共用构造器。
function buildPoiBatchReplayResponse(envelope, submittedBatchId, validation, validationView) {
  const storedPayloadHash = envelope.payloadHash || envelope.contentHash;
  if (storedPayloadHash !== validation.payloadHash) {
    return { statusCode: 409, error: 'batchId 与提交内容不匹配', code: 'BATCH_ID_MISMATCH', ...validationView };
  }
  return {
    statusCode: 200,
    ok: true,
    batchId: submittedBatchId,
    contentHash: envelope.contentHash,
    payloadHash: storedPayloadHash,
    baselineHash: envelope.baselineHash || '',
    replayed: true,
    committedAt: envelope.committedAt,
    summary: envelope.summary,
    rows: validation.rows
  };
}

export async function commitPoiBatch(input) {
  const validation = await validatePoiBatch(input, { includeBaselineScope: true });
  const { baselineScope: _currentBaselineScope, commitToken: _generatedCommitToken, ...validationView } = validation;
  if (!input?.batchId) {
    return { statusCode: 400, error: '提交批次必须携带 validate 返回的 batchId', code: 'BATCH_ID_REQUIRED', ...validationView };
  }
  if (!input?.commitToken) {
    return { statusCode: 400, error: '提交批次必须携带 validate 返回的 commitToken', code: 'COMMIT_TOKEN_REQUIRED', ...validationView };
  }
  const submittedBatchId = String(input.batchId);
  const batchToken = parsePoiCommitToken(input.commitToken);
  if (!batchToken) {
    return { statusCode: 409, error: 'commitToken 无效或已失效', code: 'COMMIT_TOKEN_INVALID', ...validationView };
  }
  if (submittedBatchId !== buildPoiBatchId(batchToken.payloadHash, batchToken.baselineHash) || batchToken.payloadHash !== validation.payloadHash) {
    return { statusCode: 409, error: 'batchId 与提交内容不匹配', code: 'BATCH_ID_MISMATCH', ...validationView };
  }
  const existingEnvelope = (await listPoiBatchEnvelopes()).find((row) => row.batchId === submittedBatchId);
  if (existingEnvelope) {
    return buildPoiBatchReplayResponse(existingEnvelope, submittedBatchId, validation, validationView);
  }
  return withStorageEntityLock('poi', 'catalog', async () => {
    const replayEnvelope = (await listPoiBatchEnvelopes()).find((row) => row.batchId === submittedBatchId);
    if (replayEnvelope) {
      return buildPoiBatchReplayResponse(replayEnvelope, submittedBatchId, validation, validationView);
    }
    const lockedValidation = await validatePoiBatch(input, { includeBaselineScope: true });
    const { baselineScope: lockedBaselineScope, commitToken: _lockedGeneratedCommitToken, ...lockedValidationView } = lockedValidation;
    if (batchToken.payloadHash !== lockedValidation.payloadHash) {
      return { statusCode: 409, error: 'batchId 与提交内容不匹配', code: 'BATCH_ID_MISMATCH', ...lockedValidationView };
    }
    if (poiBatchBaselineIsStale(batchToken.baselineScope, lockedBaselineScope, poiBatchIncomingScope(lockedValidation.rows))) {
      return {
        statusCode: 409,
        error: '校验后 POI 目录已变更，请重新执行预检',
        code: 'POI_BATCH_STALE',
        replayed: false,
        ...lockedValidationView
      };
    }
    if (!lockedValidation.canCommit) {
      return { statusCode: 400, error: '批次包含错误或冲突，未写入任何数据', code: 'POI_BATCH_INVALID', replayed: false, ...lockedValidationView };
    }
    const existingById = new Map((await listOperationalPoiSnapshots()).map((row) => [row.poiId, row]));
    const committedAt = new Date().toISOString();
    const committedRows = lockedValidation.rows.map((row) => {
      const incoming = row.normalized;
      const existing = existingById.get(incoming.poiId);
      const merged = mergeOperationalPoiSnapshot(existing, incoming);
      const commitAudit = {
        id: stablePoiChildId('audit', incoming.poiId, { batchId: submittedBatchId, action: 'batch-upsert' }),
        action: 'batch-upsert',
        reviewStatus: incoming.reviewStatus,
        note: '',
        createdAt: committedAt,
        actorType: 'admin',
        source: 'batch-commit'
      };
      return {
        ...merged,
        schemaVersion: 1,
        sourceKind: 'operational',
        createdAt: existing?.createdAt || incoming.createdAt || committedAt,
        updatedAt: committedAt,
        batchId: submittedBatchId,
        audits: latestItemsById(merged.audits, [commitAudit])
      };
    });
    const contentHash = fullContentHash(
      stableJsonStringify({
        payloadHash: batchToken.payloadHash,
        baselineHash: batchToken.baselineHash
      })
    );
    const envelope = {
      kind: 'poi-batch',
      schemaVersion: 1,
      batchId: submittedBatchId,
      contentHash,
      payloadHash: batchToken.payloadHash,
      baselineHash: batchToken.baselineHash,
      committedAt,
      summary: lockedValidation.summary,
      rows: committedRows
    };
    await appendJsonLine(POI_LOG_PATH, envelope);
    return {
      statusCode: 200,
      ok: true,
      batchId: submittedBatchId,
      contentHash,
      payloadHash: batchToken.payloadHash,
      baselineHash: batchToken.baselineHash,
      replayed: false,
      committedAt,
      summary: lockedValidation.summary,
      rows: lockedValidation.rows
    };
  });
}

export function normalizePoiName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s·•，。、“”‘’'"()（）[\]【】_-]+/g, '')
    .replace(/景区|风景区$/g, '')
    .toLowerCase();
}

// rank12①：从只查 16 条硬编码种子改为查 seed + 运营合并目录（运营侧仅
// reviewStatus=approved 参与），coordinateForName/poiOpenHours/resolvePoiId
// 调用链随之继承运营 POI 的坐标与营业时间事实。
export function findTrustedPoi(stop, city = '') {
  const cityName = truncateString(city || stop?.city, 40);
  if (!cityName) return null;
  const normalizedCity = normalizeCityName(cityName);
  const normalizedName = normalizePoiName(stop?.name || stop?.stopName);
  if (!normalizedName) return null;
  return refreshMergedPoiCatalog().trustedLookup.get(`${normalizedCity}::${normalizedName}`) ?? null;
}

export function resolvePoiId(stop, city = '') {
  const normalizedName = normalizePoiName(stop?.name || stop?.stopName);
  if (!normalizedName) return sanitizePublicId(stop?.poiId);
  const trusted = findTrustedPoi(stop, city);
  if (trusted) return trusted.poiId;
  const cityName = truncateString(city || stop?.city, 40);
  const normalizedCity = cityName ? normalizeCityName(cityName) : '未知';
  return `poi-${hashText(`${normalizedCity}:${normalizedName}`)}`;
}

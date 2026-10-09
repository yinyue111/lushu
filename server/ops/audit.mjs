import { createHmac } from 'node:crypto';
import { CHECKIN_LOG_PATH, IMPORT_LOG_PATH, OPS_AUDIT_LOG_PATH, PROFILE_ID_SECRET } from '../config/index.mjs';
import { appendJsonLine, readJsonLines } from '../storage/jsonl.mjs';
import { findLatestByEntityKey } from '../storage/keyedLookup.mjs';
import { withStorageEntityLock } from '../storage/runtime.mjs';
import { listSavedRoutebooks } from '../routebooks/list.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { clampNumber, createHttpError, sanitizePublicId, truncateString } from '../lib/util.mjs';
import { importSourceId } from './source-identity.mjs';
import { SOURCE_AUTHORIZATION_SCOPES, applyImportSourceOpsOverlay, defaultSourceDisposition, hasValidImportedSourceProof } from './sources.mjs';

const ENTITY_TYPES = new Set(['checkin', 'import-source']);
const CHECKIN_ACTIONS = new Set(['exclude', 'restore', 'mark-commercial-incentive', 'clear-commercial-incentive']);
const SOURCE_ACTIONS = new Set(['update-authorization', 'revoke-authorization', 'feature', 'unfeature']);

export function buildOpsAuditContextFromRows(rows = []) {
  const histories = new Map();
  const latest = new Map();
  for (const event of rows) {
    if (!ENTITY_TYPES.has(event?.entityType) || !sanitizePublicId(event.entityId)) continue;
    const key = `${event.entityType}:${event.entityId}`;
    const history = histories.get(key) ?? [];
    history.push(event);
    histories.set(key, history);
    if (!latest.has(key)) latest.set(key, event);
  }
  return {
    histories,
    checkinOverlays: new Map([...latest.values()].filter((event) => event.entityType === 'checkin').map((event) => [event.entityId, event])),
    sourceOverlays: new Map([...latest.values()].filter((event) => event.entityType === 'import-source').map((event) => [event.entityId, event]))
  };
}

export async function buildOpsAuditContext() {
  return buildOpsAuditContextFromRows(await readJsonLines(OPS_AUDIT_LOG_PATH, Number.POSITIVE_INFINITY));
}

export function applyCheckinOpsOverlay(checkin, context) {
  const event = context?.checkinOverlays?.get(sanitizePublicId(checkin?.id));
  return {
    ...checkin,
    opsDisposition: {
      excluded: event?.state?.excluded === true,
      commercialIncentive: event?.state?.commercialIncentive === true,
      action: event?.action ?? '',
      reason: event?.reason ?? '',
      actor: event?.actor ?? '',
      updatedAt: event?.createdAt ?? ''
    },
    opsAuditHistory: context?.histories?.get(`checkin:${checkin?.id}`) ?? []
  };
}

export function isOpsSuppressedCheckin(checkin) {
  return checkin?.opsDisposition?.excluded === true || checkin?.opsDisposition?.commercialIncentive === true;
}

export function validateOpsAuditInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createHttpError('处置请求必须是对象', 400, 'OPS_AUDIT_INPUT_INVALID');
  for (const field of ['id', 'createdAt', 'updatedAt', 'actor', 'state']) {
    if (Object.hasOwn(input, field)) throw createHttpError('审计事件 ID、时间、处置人和状态只能由服务端生成', 400, 'OPS_AUDIT_SERVER_FIELDS_FORBIDDEN');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 8) throw createHttpError('处置原因至少填写 8 个字符', 400, 'OPS_AUDIT_REASON_REQUIRED');
  if (reason.length > 500) throw createHttpError('处置原因不能超过 500 个字符', 400, 'OPS_AUDIT_REASON_TOO_LONG');
  return reason;
}

async function findImportSource(sourceId) {
  for (const row of await readJsonLines(IMPORT_LOG_PATH, Number.POSITIVE_INFINITY)) {
    const source = (row.sources ?? []).find((item) => importSourceId(item) === sourceId);
    if (source) return source;
  }
  return null;
}

/** Pseudonymous ops actor: an HMAC of the admin token, never the token itself. */
export function opsActorForRequest(req) {
  const token = String(req?.headers?.['x-routebook-admin-token'] ?? '');
  return token ? `admin-${createHmac('sha256', PROFILE_ID_SECRET).update(`ops-actor:${token}`).digest('hex').slice(0, 12)}` : 'local-admin';
}

export async function createOpsAuditEvent(req, entityType, entityId, input = {}) {
  if (!ENTITY_TYPES.has(entityType) || !sanitizePublicId(entityId)) throw createHttpError('审计对象不合法', 400, 'OPS_AUDIT_ENTITY_INVALID');
  const reason = validateOpsAuditInput(input);
  const action = truncateString(input.action, 60);
  return withStorageEntityLock('ops-audit', `${entityType}:${entityId}`, async () => {
    const context = await buildOpsAuditContext();
    let state;
    if (entityType === 'checkin') {
      if (!CHECKIN_ACTIONS.has(action)) throw createHttpError('打卡处置动作不在允许范围内', 400, 'OPS_CHECKIN_ACTION_INVALID');
      const checkin = await findLatestByEntityKey(CHECKIN_LOG_PATH, entityId);
      if (!checkin || checkin.deleted === true) throw createHttpError('打卡记录不存在', 404, 'OPS_CHECKIN_NOT_FOUND');
      const previous = context.checkinOverlays.get(entityId)?.state ?? { excluded: false, commercialIncentive: false };
      state = {
        ...previous,
        ...(action === 'exclude' ? { excluded: true } : {}),
        ...(action === 'restore' ? { excluded: false } : {}),
        ...(action === 'mark-commercial-incentive' ? { commercialIncentive: true } : {}),
        ...(action === 'clear-commercial-incentive' ? { commercialIncentive: false } : {})
      };
    } else {
      if (!SOURCE_ACTIONS.has(action)) throw createHttpError('来源处置动作不在允许范围内', 400, 'OPS_SOURCE_ACTION_INVALID');
      const source = await findImportSource(entityId);
      if (!source) throw createHttpError('攻略来源不存在', 404, 'OPS_SOURCE_NOT_FOUND');
      state = { ...(context.sourceOverlays.get(entityId)?.state ?? defaultSourceDisposition()) };
      if (action === 'update-authorization') {
        const status = String(input.authorizationStatus ?? '');
        if (!Object.hasOwn(SOURCE_AUTHORIZATION_SCOPES, status) || input.authorizationScope !== SOURCE_AUTHORIZATION_SCOPES[status]) {
          throw createHttpError('授权状态与授权范围不一致', 400, 'OPS_SOURCE_AUTHORIZATION_MISMATCH');
        }
        state.authorizationStatus = status;
        state.authorizationScope = SOURCE_AUTHORIZATION_SCOPES[status];
      }
      if (action === 'revoke-authorization') Object.assign(state, { authorizationStatus: 'revoked', authorizationScope: 'none' });
      if ((state.authorizationStatus === 'authorized-public' || action === 'feature') && !hasValidImportedSourceProof(source)) {
        throw createHttpError('来源缺少有效服务端签名，重新导入后才能公开授权或精选', 409, 'OPS_SOURCE_PROOF_REQUIRED');
      }
      if (action === 'feature' && state.authorizationStatus !== 'authorized-public') {
        throw createHttpError('只有已获公开授权的来源可以精选', 409, 'OPS_SOURCE_PUBLIC_AUTHORIZATION_REQUIRED');
      }
      if (action === 'feature') state.featured = true;
      if (action === 'unfeature' || state.authorizationStatus !== 'authorized-public') state.featured = false;
    }
    const actor = opsActorForRequest(req);
    const event = { id: cryptoRandomId(), entityType, entityId, action, reason, actor, createdAt: new Date().toISOString(), state };
    await appendJsonLine(OPS_AUDIT_LOG_PATH, event);
    return {
      event,
      overlay: { ...state, action, reason, actor, updatedAt: event.createdAt },
      history: [event, ...(context.histories.get(`${entityType}:${entityId}`) ?? [])]
    };
  });
}

export async function listOpsAuditEvents({ entityType = '', entityId = '', limit = 100 } = {}) {
  if (entityType && !ENTITY_TYPES.has(entityType)) throw createHttpError('审计对象类型不合法', 400, 'OPS_AUDIT_ENTITY_INVALID');
  return (await readJsonLines(OPS_AUDIT_LOG_PATH, Number.POSITIVE_INFINITY))
    .filter((event) => (!entityType || event.entityType === entityType) && (!entityId || event.entityId === entityId))
    .slice(0, clampNumber(limit, 1, 500, 100));
}

export async function buildImportOperationsView(limit = 100) {
  const [rows, context, routebooks] = await Promise.all([
    readJsonLines(IMPORT_LOG_PATH, clampNumber(limit, 1, 200, 100)),
    buildOpsAuditContext(),
    listSavedRoutebooks(Number.POSITIVE_INFINITY)
  ]);
  const relations = new Map();
  for (const routebook of routebooks) {
    for (const source of routebook.importedSources ?? []) {
      const id = importSourceId(source);
      const relation = relations.get(id) ?? { routebooks: new Map(), pois: new Set() };
      const routeId = sanitizePublicId(routebook.publicId || routebook.id);
      if (routeId) relation.routebooks.set(routeId, { id: routeId, title: truncateString(routebook.title, 100) });
      for (const stop of routebook.stops ?? []) {
        if ((stop.sourceEvidence ?? []).some((evidence) => (evidence.sourceId || evidence.id) === id)) relation.pois.add(stop.poiId || stop.id || stop.name);
      }
      relations.set(id, relation);
    }
  }
  return rows.map((row) => ({
    ...row,
    sources: (row.sources ?? []).map((source) => {
      const projected = applyImportSourceOpsOverlay(source, context);
      const relation = relations.get(projected.sourceId);
      const linked = [...(relation?.routebooks?.values() ?? [])];
      return { ...projected, routebooks: linked, routebookTitle: linked.map((routebook) => routebook.title).join('、'), poiCount: relation?.pois?.size ?? 0 };
    })
  }));
}

import { NO_POI_CATALOG, route } from '../http/router.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { verifyAdminAccess } from '../auth/request-access.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { CHECKIN_LOG_PATH } from '../config/index.mjs';
import { readJsonLines } from '../storage/jsonl.mjs';
import { clampNumber, createHttpError, safeDecodePathSegment, sanitizePublicId } from '../lib/util.mjs';
import { CHECKIN_OPS_FILTERS, checkinMatchesOpsFilter } from '../../src/lib/checkinOpsFilter.js';
import { paginateRows } from '../ops/paging.mjs';
import { applyCheckinOpsOverlay, buildImportOperationsView, buildOpsAuditContext, createOpsAuditEvent, listOpsAuditEvents } from '../ops/audit.mjs';
import { listReviewQueue } from '../ops/reviewQueue.mjs';
import { decideModeration, listModerationQueue } from '../moderation/index.mjs';
import { shadowAgreementSummary } from '../shadow/index.mjs';
import { listPoiDuplicateQueue, listPoiMergeDecisions, recordPoiMergeDecision } from '../poi/merges.mjs';

// Upper bound for one ops check-in scan; readJsonLines treats non-finite limits as 50.
const OPS_CHECKIN_SCAN_LIMIT = 200000;

export const opsRoutes = [
  route(
    'GET',
    '/api/ops/review-queue',
    async ({ req, res, url }) => {
      // Ops listings scan whole streams; throttle before auth so token guessing is bounded too.
      enforceRateLimit(req, 'ops-read');
      verifyAdminAccess(req);
      return sendJson(res, 200, {
        ok: true,
        ...(await listReviewQueue({
          city: url.searchParams.get('city') || '',
          status: url.searchParams.get('status') || '',
          limit: url.searchParams.get('limit') || undefined,
          cursor: url.searchParams.get('cursor') || ''
        }))
      });
    },
    NO_POI_CATALOG
  ),
  route('GET', '/api/ops/checkins', async ({ req, res, url }) => {
    // Ops listings scan whole streams; throttle before auth so token guessing is bounded too.
    enforceRateLimit(req, 'ops-read');
    verifyAdminAccess(req);
    // F17: filter + keyset paging run on the server over the whole stream.
    const filter = String(url.searchParams.get('filter') || 'all');
    if (!CHECKIN_OPS_FILTERS.includes(filter)) throw createHttpError('打卡筛选不支持', 400, 'INVALID_CHECKIN_FILTER');
    const [rows, context] = await Promise.all([readJsonLines(CHECKIN_LOG_PATH, OPS_CHECKIN_SCAN_LIMIT), buildOpsAuditContext()]);
    const matching = rows.map((row) => applyCheckinOpsOverlay(row, context)).filter((row) => checkinMatchesOpsFilter(row, filter));
    const { page, total, nextCursor, hasMore } = paginateRows(matching, {
      limit: clampNumber(url.searchParams.get('limit') ?? 100, 1, 200, 100),
      cursor: url.searchParams.get('cursor') || '',
      fields: ['createdAt']
    });
    return sendJson(res, 200, { ok: true, checkins: page, total, filter, nextCursor, hasMore });
  }),
  route('GET', '/api/ops/imports', async ({ req, res, url }) => {
    // Ops listings scan whole streams; throttle before auth so token guessing is bounded too.
    enforceRateLimit(req, 'ops-read');
    verifyAdminAccess(req);
    return sendJson(res, 200, { ok: true, imports: await buildImportOperationsView(Number(url.searchParams.get('limit') ?? 100)) });
  }),
  route(
    'GET',
    '/api/ops/audits',
    async ({ req, res, url }) => {
      // Ops listings scan whole streams; throttle before auth so token guessing is bounded too.
      enforceRateLimit(req, 'ops-read');
      verifyAdminAccess(req);
      return sendJson(res, 200, {
        ok: true,
        events: await listOpsAuditEvents({
          entityType: url.searchParams.get('entityType') || '',
          entityId: sanitizePublicId(url.searchParams.get('entityId')),
          limit: Number(url.searchParams.get('limit') ?? 100)
        })
      });
    },
    NO_POI_CATALOG
  ),
  route('POST', '/api/ops/checkins/:id/audits', async ({ req, res, params }) => {
    enforceRateLimit(req);
    verifyAdminAccess(req);
    return sendJson(res, 200, {
      ok: true,
      ...(await createOpsAuditEvent(req, 'checkin', sanitizePublicId(safeDecodePathSegment(params.id)), await readJsonBody(req)))
    });
  }),
  route('POST', '/api/ops/import-sources/:id/audits', async ({ req, res, params }) => {
    enforceRateLimit(req);
    verifyAdminAccess(req);
    return sendJson(res, 200, {
      ok: true,
      ...(await createOpsAuditEvent(req, 'import-source', sanitizePublicId(safeDecodePathSegment(params.id)), await readJsonBody(req)))
    });
  }),
  // Jev shadow pilot: agreement / order-consistency summary only (no raw states).
  route(
    'GET',
    '/api/ops/shadow-judgments',
    async ({ req, res }) => {
      enforceRateLimit(req, 'ops-read');
      verifyAdminAccess(req);
      return sendJson(res, 200, { ok: true, ...(await shadowAgreementSummary()) });
    },
    NO_POI_CATALOG
  ),
  route('GET', '/api/ops/poi-duplicates', async ({ req, res, url }) => {
    enforceRateLimit(req, 'ops-read');
    verifyAdminAccess(req);
    return sendJson(res, 200, {
      ok: true,
      ...(await listPoiDuplicateQueue({
        city: url.searchParams.get('city') || '',
        limit: clampNumber(url.searchParams.get('limit') || undefined, 1, 500, 100)
      }))
    });
  }),
  route('GET', '/api/ops/poi-merges', async ({ req, res, url }) => {
    enforceRateLimit(req, 'ops-read');
    verifyAdminAccess(req);
    return sendJson(res, 200, { ok: true, decisions: await listPoiMergeDecisions(clampNumber(url.searchParams.get('limit') || undefined, 1, 1000, 200)) });
  }),
  route('POST', '/api/ops/poi-merges', async ({ req, res }) => {
    enforceRateLimit(req);
    verifyAdminAccess(req);
    return sendJson(res, 200, { ok: true, ...(await recordPoiMergeDecision(req, await readJsonBody(req))) });
  }),
  route('GET', '/api/ops/moderation', async ({ req, res, url }) => {
    enforceRateLimit(req, 'ops-read');
    verifyAdminAccess(req);
    const status = String(url.searchParams.get('status') || 'open');
    if (!['open', 'pending', 'blocked', 'approved', 'rejected', 'passed', 'all'].includes(status)) {
      throw createHttpError('审核状态筛选不支持', 400, 'INVALID_MODERATION_FILTER');
    }
    return sendJson(res, 200, {
      ok: true,
      ...(await listModerationQueue({ status, limit: clampNumber(url.searchParams.get('limit') || undefined, 1, 500, 100) }))
    });
  }),
  route('POST', '/api/ops/moderation/:entityType/:entityId', async ({ req, res, params }) => {
    enforceRateLimit(req);
    verifyAdminAccess(req);
    return sendJson(res, 200, {
      ok: true,
      ...(await decideModeration(req, safeDecodePathSegment(params.entityType), safeDecodePathSegment(params.entityId), await readJsonBody(req)))
    });
  })
];

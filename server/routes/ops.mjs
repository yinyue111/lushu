import { NO_POI_CATALOG, route } from '../http/router.mjs';
import { readJsonBody, sendJson } from '../http/response.mjs';
import { verifyAdminAccess } from '../auth/request-access.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { CHECKIN_LOG_PATH } from '../config/index.mjs';
import { readJsonLines } from '../storage/jsonl.mjs';
import { clampNumber, safeDecodePathSegment, sanitizePublicId } from '../lib/util.mjs';
import { applyCheckinOpsOverlay, buildImportOperationsView, buildOpsAuditContext, createOpsAuditEvent, listOpsAuditEvents } from '../ops/audit.mjs';
import { listReviewQueue } from '../ops/reviewQueue.mjs';

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
    const [rows, context] = await Promise.all([
      readJsonLines(CHECKIN_LOG_PATH, clampNumber(url.searchParams.get('limit') ?? 100, 1, 200, 100)),
      buildOpsAuditContext()
    ]);
    return sendJson(res, 200, { ok: true, checkins: rows.map((row) => applyCheckinOpsOverlay(row, context)) });
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
  })
];

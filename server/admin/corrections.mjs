// Enrichment correction queue (PRD P2): user reports + operator actions.
// Actions (all need a reason, all audited with before → after):
//   reset   → this routebook shows 待确认; shared cache + verified fact for the cache key dropped;
//             optional batch (admin only): every routebook with the same cache key.
//   verify  → value + at least one source URL (required) → verified fact (expires after enrich.verifiedFactDays)
//             and this routebook shows the value with 「人工核实 · 日期」.
//   reject  → report dismissed, the original value shows again.
//   rerun   → re-queue enrichment for the routebook.
import { enrichStore } from '../enrich/store.mjs';
import { enqueueEnrichment } from '../enrich/service.mjs';
import { stopKeyOf } from '../enrich/engine.mjs';
import { getSavedRoutebook } from '../storage/records.mjs';
import { getConfig } from '../config/runtime.mjs';
import { adminStore } from './store.mjs';
import { adminAudit } from './audit.mjs';
import { createHttpError, cryptoRandomId } from './util.mjs';

const FIELDS = new Set(['price', 'hours']);

function requireReason(reason) {
  const text = String(reason ?? '').trim();
  if (text.length < 4) throw createHttpError('请写明原因（至少 4 个字）', 400, 'ADMIN_REASON_REQUIRED');
  return text.slice(0, 300);
}

/** Sources as shown in the queue: type, domain, link, quote, query date. */
function sourceRows(claim) {
  return (claim?.sources ?? []).map((s) => ({
    kind: s.kind ?? 'web',
    domain: s.domain ?? '',
    url: s.url ?? '',
    title: String(s.title ?? '').slice(0, 120),
    quote: String(s.quote ?? '').slice(0, 120),
    retrievedAt: s.retrievedAt ?? claim.retrievedAt ?? null
  }));
}

export async function listCorrectionQueue({ status = '', city = '', field = '', since = '', until = '', limit = 200 } = {}) {
  const store = enrichStore();
  const [reports, states] = await Promise.all([store.listReports({ limit: 1000 }), adminStore().reportStates()]);
  const out = [];
  const routebooks = new Map();
  const affected = new Map();
  for (const report of reports) {
    const state = states.get(report.id);
    const reportStatus = state?.status ?? (report.status && report.status !== 'open' ? report.status : 'open');
    if (status && reportStatus !== status) continue;
    if (field && report.field !== field) continue;
    if (since && report.createdAt < since) continue;
    if (until && report.createdAt > until) continue;
    if (!routebooks.has(report.routebookId)) routebooks.set(report.routebookId, await getSavedRoutebook(report.routebookId).catch(() => null));
    const routebook = routebooks.get(report.routebookId);
    if (city && routebook?.city !== city) continue;
    const result = await store.getResult(report.routebookId);
    const claim = result?.claims?.find((c) => c.stopKey === report.stopKey && c.field === report.field) ?? null;
    if (report.cacheKey && !affected.has(report.cacheKey)) affected.set(report.cacheKey, (await store.routebooksWithCacheKey(report.cacheKey)).length);
    out.push({
      id: report.id,
      status: reportStatus,
      source: report.source ?? 'user',
      routebookId: report.routebookId,
      city: routebook?.city ?? '',
      stopKey: report.stopKey,
      stopName: claim?.stopName ?? '',
      field: report.field,
      value: claim?.value ?? report.value ?? '',
      claimStatus: claim?.status ?? 'none',
      method: claim?.method ?? '',
      sources: sourceRows(claim),
      conditions: (claim?.conditions ?? []).map((c) => ({
        kind: c.kind,
        label: c.label,
        quote: String(c.quote ?? '').slice(0, 120),
        verifiedCount: c.verifiedCount ?? (c.sources ?? []).length
      })),
      note: report.note ?? '',
      cacheKey: report.cacheKey ?? '',
      affectedRoutebooks: affected.get(report.cacheKey) ?? 0,
      createdAt: report.createdAt,
      resolvedBy: state?.resolvedBy ?? null,
      resolvedAt: state?.resolvedAt ?? null
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function findReport(reportId) {
  const report = (await enrichStore().listReports({ limit: 5000 })).find((r) => r.id === reportId);
  if (!report) throw createHttpError('报错记录不存在', 404, 'ADMIN_REPORT_NOT_FOUND');
  return report;
}

async function setClaim(routebookId, stopKey, field, update) {
  const store = enrichStore();
  const result = await store.getResult(routebookId);
  const claims = result?.claims ?? [];
  const index = claims.findIndex((c) => c.stopKey === stopKey && c.field === field);
  const before = index >= 0 ? claims[index] : null;
  const next = update(before);
  const list = index >= 0 ? claims.map((c, i) => (i === index ? next : c)) : [...claims, next];
  await store.putResult(routebookId, list);
  return { before, after: next };
}

const brief = (claim) => (claim ? { status: claim.status, value: claim.value ?? '', method: claim.method ?? '' } : null);

/**
 * @param {{ admin: any, req: any, reportId?: string, routebookId?: string, stopKey?: string, field?: string, action: string,
 *   reason: string, value?: string, sources?: { url: string, retrievedAt?: string, title?: string }[], batch?: boolean }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function applyCorrection(input) {
  const { admin, req } = input;
  const reason = requireReason(input.reason);
  const report = input.reportId ? await findReport(input.reportId) : null;
  const routebookId = report?.routebookId ?? String(input.routebookId ?? '');
  const stopKey = report?.stopKey ?? String(input.stopKey ?? '');
  const field = report?.field ?? String(input.field ?? '');
  if (!routebookId || (input.action !== 'rerun' && (!stopKey || !FIELDS.has(field))))
    throw createHttpError('缺少路书 / 站点 / 字段', 400, 'ADMIN_CORRECTION_TARGET');
  const routebook = await getSavedRoutebook(routebookId);
  if (!routebook) throw createHttpError('路书不存在', 404, 'ROUTEBOOK_NOT_FOUND');
  const store = enrichStore();
  const now = new Date().toISOString();
  let detail = {};

  if (input.action === 'rerun') {
    const job = await enqueueEnrichment({ routebookId, userId: (await store.getJob(routebookId))?.userId || 'admin', refresh: true });
    detail = { queued: Boolean(job) };
  } else if (input.action === 'reset') {
    const existing = (await store.getResult(routebookId))?.claims?.find((c) => c.stopKey === stopKey && c.field === field);
    const cacheKey = report?.cacheKey || existing?.cacheKey || '';
    let targets = [routebookId];
    if (input.batch) {
      if (admin.role !== 'admin') throw createHttpError('按 cacheKey 批量改回只有管理员能做', 403, 'ADMIN_FORBIDDEN');
      if (!cacheKey) throw createHttpError('这条没有 cacheKey，不能批量', 400, 'ADMIN_CORRECTION_NO_CACHE_KEY');
      targets = [...new Set([routebookId, ...(await store.routebooksWithCacheKey(cacheKey))])];
    }
    const changed = [];
    for (const id of targets) {
      const result = await store.getResult(id);
      const claims = result?.claims ?? [];
      let touched = false;
      const next = claims.map((c) => {
        const match = id === routebookId && !input.batch ? c.stopKey === stopKey && c.field === field : c.cacheKey === cacheKey;
        if (!match || (c.status !== 'filled' && c.status !== 'reported')) return c;
        touched = true;
        return { ...c, status: 'disputed', resetBy: admin.username, resetAt: now };
      });
      if (touched) {
        await store.putResult(id, next);
        changed.push(id);
      }
    }
    if (cacheKey) {
      await store.deleteCache(cacheKey);
      await adminStore().deleteVerifiedFact(cacheKey);
    }
    detail = { before: brief(existing), after: { status: '待确认' }, cacheKey, routebooks: changed, batch: Boolean(input.batch) };
  } else if (input.action === 'verify') {
    const value = String(input.value ?? '')
      .trim()
      .slice(0, 80);
    if (!value) throw createHttpError('请填核实后的值', 400, 'ADMIN_VERIFY_VALUE_REQUIRED');
    const sources = (Array.isArray(input.sources) ? input.sources : [])
      .map((s) => ({
        url: String(s?.url ?? '').trim(),
        retrievedAt: String(s?.retrievedAt ?? '').trim() || now.slice(0, 10),
        title: String(s?.title ?? '').slice(0, 120)
      }))
      .filter((s) => s.url);
    if (!sources.length) throw createHttpError('设为核实值必须填至少 1 个来源链接', 400, 'ADMIN_VERIFY_SOURCE_REQUIRED');
    for (const s of sources) {
      let url;
      try {
        url = new URL(s.url);
      } catch {
        throw createHttpError(`来源链接不对：${s.url.slice(0, 60)}`, 400, 'ADMIN_VERIFY_SOURCE_INVALID');
      }
      if (!['http:', 'https:'].includes(url.protocol)) throw createHttpError('来源链接需要 http(s)', 400, 'ADMIN_VERIFY_SOURCE_INVALID');
      if (!/^\d{4}-\d{2}-\d{2}/.test(s.retrievedAt)) throw createHttpError('查询日期格式 YYYY-MM-DD', 400, 'ADMIN_VERIFY_DATE_INVALID');
    }
    const stop = (routebook.stops ?? []).find((st, i) => stopKeyOf(st, i) === stopKey) ?? null;
    const { before, after } = await setClaim(routebookId, stopKey, field, (prev) => {
      const cacheKey = prev?.cacheKey ?? report?.cacheKey ?? '';
      const day = now.slice(0, 10);
      return {
        ...(prev ?? {}),
        stopKey,
        stopName: prev?.stopName ?? String(stop?.name ?? ''),
        field,
        status: 'filled',
        value,
        display: `${field === 'price' ? '门票' : '开放时间'}：${value} · 人工核实 · ${day}`,
        sources: sources.map((s) => ({ kind: 'ops', url: s.url, title: s.title || '人工核实来源', domain: safeHost(s.url), retrievedAt: s.retrievedAt })),
        retrievedAt: now,
        method: 'ops-verified',
        verifiedBy: admin.username,
        verifiedAt: now,
        cacheKey,
        conditions: []
      };
    });
    if (after.cacheKey) {
      const [city, place] = String(after.cacheKey).split('|');
      await adminStore().putVerifiedFact({
        cacheKey: after.cacheKey,
        city: city ?? routebook.city ?? '',
        place: place ?? after.stopName,
        field,
        value,
        sources: after.sources,
        scope: 'cache-key',
        verifiedBy: admin.username,
        verifiedAt: now,
        expiresAt: new Date(Date.now() + getConfig('enrich.verifiedFactDays') * 86400000).toISOString()
      });
    }
    // The verified value belongs to the place, not one routebook: every routebook whose claim shares the
    // cache key (city|place|field) shows it now, not only after its next enrichment.
    const propagated = [];
    if (after.cacheKey) {
      const store = enrichStore();
      for (const id of await store.routebooksWithCacheKey(after.cacheKey)) {
        if (id === routebookId) continue;
        const result = await store.getResult(id);
        let touched = false;
        const next = (result?.claims ?? []).map((c) => {
          if (c.cacheKey !== after.cacheKey || c.field !== field) return c;
          touched = true;
          const { reportId: _drop, ...rest } = c;
          return {
            ...rest,
            status: 'filled',
            value,
            display: after.display,
            sources: after.sources,
            retrievedAt: now,
            method: 'ops-verified',
            verifiedBy: admin.username,
            verifiedAt: now,
            conditions: []
          };
        });
        if (touched) {
          await store.putResult(id, next);
          propagated.push(id);
        }
      }
      // Open reports about the same place are answered by this verification too.
      const states = await adminStore().reportStates();
      for (const other of await store.listReports({ limit: 1000 })) {
        if (other.id !== report?.id && other.cacheKey === after.cacheKey && other.field === field) {
          const state = states.get(other.id);
          if (!state || state.status === 'open')
            await adminStore().setReportState(other.id, { status: 'resolved', resolvedBy: admin.username, resolvedAt: now });
        }
      }
    }
    detail = { before: brief(before), after: brief(after), sources: sources.map((s) => s.url), routebooks: [routebookId, ...propagated] };
  } else if (input.action === 'reject') {
    if (!report) throw createHttpError('驳回需要针对一条报错', 400, 'ADMIN_REJECT_NEEDS_REPORT');
    const { before, after } = await setClaim(routebookId, stopKey, field, (prev) =>
      prev && (prev.status === 'disputed' || prev.status === 'reported') ? { ...prev, status: 'filled', reportId: undefined } : prev
    );
    detail = { before: brief(before), after: brief(after) };
  } else {
    throw createHttpError('不支持的纠错动作', 400, 'ADMIN_CORRECTION_ACTION');
  }

  await adminStore().addCorrection({
    id: `cor_${cryptoRandomId()}`,
    routebookId,
    stopKey,
    field: field || '-',
    action: input.action,
    value: input.value ?? '',
    sourceUrl: input.sources?.[0]?.url ?? '',
    reportId: report?.id ?? null,
    reason,
    actor: admin.username,
    createdAt: now
  });
  if (report && input.action !== 'rerun')
    await adminStore().setReportState(report.id, { status: input.action === 'reject' ? 'rejected' : 'resolved', resolvedBy: admin.username, resolvedAt: now });
  await adminAudit(req, {
    admin,
    action: `correction.${input.action}`,
    target: `routebook:${routebookId}:${stopKey}:${field}`,
    before: detail.before,
    after: detail.after,
    reason,
    extra: { ...detail, before: undefined, after: undefined, reportId: report?.id ?? null }
  });
  return { ok: true, action: input.action, ...detail };
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

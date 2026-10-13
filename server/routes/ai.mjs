// Generation, OCR and import API routes.
import { generationBudgetMs } from '../config/runtimeViews.mjs';
import { deletedRoutebookIds } from '../routebooks/tombstones.mjs';
import { clampNumber, createHttpError, safeDecodePathSegment, truncateString } from '../lib/util.mjs';
import {
  AI_LOG_PATH,
  GENERATION_DEDUP_TTL_MS,
  GENERATION_JOB_POLL_WAIT_MS,
  IMPORT_LOG_PATH,
  MAX_IMPORT_URLS,
  MAX_OCR_IMAGES,
  MAX_OCR_REQUEST_BYTES
} from '../config/index.mjs';
import { appendJsonLine, readJsonLines } from '../storage/jsonl.mjs';
import { analyzeSourceUrl, detectPlatform, extractUrls } from '../import/source-page.mjs';
import { cryptoRandomId, normalizeProfileId } from '../auth/tokens.mjs';
import {
  hasAdminAccess,
  requestClientKey,
  resolveWriteProfile,
  verifyPlanningAccess,
  requestAccount,
  verifyProfileReadAccess,
  verifySensitiveReadAccess
} from '../auth/request-access.mjs';
import { bindRequestAbortSignal, readJsonBody, sendJson } from '../http/response.mjs';
import { NO_POI_CATALOG, route } from '../http/router.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { safeSourceUrl } from '../lib/urls.mjs';
import { signImportedSource } from '../routebooks/normalize.mjs';
import { analyzeGuideImages, normalizeOcrImage, sanitizePayload } from '../ai/generate.mjs';
import { enforceGenerationQuota, generationInputHash, withGenerationDedup } from '../ai/generationGuard.mjs';
import { generateAndStoreRoutebook, recentGenerationEstimate } from '../ai/generationRun.mjs';
import {
  cancelGenerationJob,
  findDuplicateGenerationJob,
  generationJobSnapshot,
  getGenerationJob,
  startGenerationJob,
  forgetGenerationDedup,
  waitForGenerationJob
} from '../ai/generationJobs.mjs';
import { importSourceId } from '../ops/source-identity.mjs';
import { quotaForUser } from '../accounts/service.mjs';
import { enqueueEnrichment } from '../enrich/service.mjs';
import { scheduleShadowJudgment } from '../shadow/index.mjs';
import { buildAiObservabilitySummary, normalizeAiGenerationStages, normalizeCostEstimate, normalizeStoredModelUsage } from '../analytics/aiObservability.mjs';

const IMPORT_STATUS_TEXT = { fetched: '已读取公开内容', 'metadata-only': '只识别到链接', unavailable: '页面已删除或需登录', failed: '抓取失败' };

// Signed-in accounts use their own quota (ops can override it per user); everyone else the default.
/** Logged-in users only: queue background 门票/开放时间 checking once the routebook is saved. */
function afterSaved(account, result) {
  const routebookId = result?.publicId || result?.id;
  if (account?.user?.id && routebookId) void enqueueEnrichment({ routebookId, userId: account.user.id });
  return result;
}

async function quotaOptionsFor(req) {
  const account = await requestAccount(req);
  return account ? { quota: quotaForUser(account.user) } : {};
}

export const aiRoutes = [
  route('POST', '/api/ocr-guide', async ({ req, res }) => {
    enforceRateLimit(req, 'ai');
    await verifyPlanningAccess(req);
    const body = await readJsonBody(req, MAX_OCR_REQUEST_BYTES);
    const images = (Array.isArray(body?.images) ? body.images : []).slice(0, MAX_OCR_IMAGES).map((image, index) => normalizeOcrImage(image, index));
    if (!images.length) throw createHttpError('请上传至少 1 张攻略截图', 400, 'OCR_IMAGE_REQUIRED');
    return sendJson(res, 200, await analyzeGuideImages(images, bindRequestAbortSignal(req)));
  }),
  route('POST', '/api/generate-routebook', async ({ req, res }) => {
    // Synchronous (legacy) generation: holds the request until the routebook is saved.
    // The web app uses /api/generation-jobs; this stays for scripts and older clients.
    enforceRateLimit(req, 'ai');
    await verifyPlanningAccess(req);
    const sanitizedPayload = sanitizePayload(await readJsonBody(req));
    const actor = await resolveWriteProfile(req, sanitizedPayload.profileId);
    const payload = { ...sanitizedPayload, profileId: actor.profileId };
    const requestId = /** @type {any} */ (req).requestId || cryptoRandomId();
    // Phase 2: identical requests reuse one result; registered profiles have a quota.
    const { result: responseBody, deduplicated } = await withGenerationDedup(payload, async () => {
      await enforceGenerationQuota(normalizeProfileId(payload.profileId), { ...(await quotaOptionsFor(req)), mode: payload.mode });
      return afterSaved(
        await requestAccount(req),
        await generateAndStoreRoutebook(payload, {
          signal: bindRequestAbortSignal(req),
          requestId,
          deadline: Date.now() + generationBudgetMs(payload.mode)
        })
      );
    });
    return sendJson(res, 200, deduplicated ? { ...responseBody, deduplicated: true } : responseBody);
  }),
  route('POST', '/api/generation-jobs', async ({ req, res }) => {
    enforceRateLimit(req, 'ai');
    await verifyPlanningAccess(req);
    const sanitizedPayload = sanitizePayload(await readJsonBody(req));
    const actor = await resolveWriteProfile(req, sanitizedPayload.profileId);
    const payload = { ...sanitizedPayload, profileId: actor.profileId };
    const profileId = normalizeProfileId(payload.profileId);
    const clientKey = requestClientKey(req);
    // Anonymous users share one profile id, so their dedup key also carries the client
    // address: identical input from two strangers must never return the same routebook.
    const dedupKey = GENERATION_DEDUP_TTL_MS
      ? generationInputHash({ ...payload, profileId: profileId === 'anonymous' ? `anonymous:${clientKey}` : profileId })
      : '';
    let duplicate = findDuplicateGenerationJob(dedupKey);
    // Same input as a finished job whose routebook was deleted since: generate a fresh one instead of
    // handing back the deleted (tombstoned) routebook.
    if (duplicate?.status === 'succeeded') {
      const resultId = duplicate.result?.publicId || duplicate.result?.id;
      if (resultId && (await deletedRoutebookIds([resultId])).length) {
        forgetGenerationDedup(duplicate);
        duplicate = null;
      }
    }
    if (duplicate) return sendJson(res, 200, { ok: true, deduplicated: true, job: generationJobSnapshot(duplicate) });
    await enforceGenerationQuota(profileId, { ...(await quotaOptionsFor(req)), mode: payload.mode });
    const requestId = /** @type {any} */ (req).requestId || cryptoRandomId();
    const account = await requestAccount(req);
    const { job, deduplicated } = startGenerationJob({
      dedupKey,
      clientKey,
      profileId,
      timeoutMs: generationBudgetMs(payload.mode),
      mode: payload.mode,
      estimate: await recentGenerationEstimate(undefined, Date.now(), payload.mode),
      parseDetail: [`${payload.guide.length} 字攻略`, payload.importedSources?.length ? `${payload.importedSources.length} 个导入来源` : '']
        .filter(Boolean)
        .join(' · '),
      run: async (signal, onStage, jobId, deadline) =>
        afterSaved(account, await generateAndStoreRoutebook(payload, { signal, requestId, onStage, jobId, deadline }))
    });
    // The rejection is reported through the job; never let it surface as unhandled.
    job.promise?.catch(() => {});
    return sendJson(res, deduplicated ? 200 : 202, { ok: true, deduplicated, job: generationJobSnapshot(job) });
  }),
  route(
    'GET',
    '/api/generation-jobs/:id',
    async ({ req, res, params, url }) => {
      enforceRateLimit(req, 'public-read');
      await verifyPlanningAccess(req);
      const job = await readableGenerationJob(req, params.id);
      const after = Number(url.searchParams.get('after'));
      if (Number.isInteger(after) && after >= 0) {
        await waitForGenerationJob(job, after, GENERATION_JOB_POLL_WAIT_MS, bindRequestAbortSignal(req));
      }
      return sendJson(res, 200, { ok: true, job: generationJobSnapshot(job) });
    },
    NO_POI_CATALOG
  ),
  route(
    'POST',
    '/api/generation-jobs/:id/cancel',
    async ({ req, res, params }) => {
      enforceRateLimit(req, 'core-write');
      await verifyPlanningAccess(req);
      const job = await readableGenerationJob(req, params.id);
      cancelGenerationJob(job);
      return sendJson(res, 200, { ok: true, job: generationJobSnapshot(job) });
    },
    NO_POI_CATALOG
  ),
  route('GET', '/api/logs', async ({ req, res, url }) => {
    verifySensitiveReadAccess(req);
    const history = await readJsonLines(AI_LOG_PATH, Number.POSITIVE_INFINITY);
    const limit = clampNumber(url.searchParams.get('limit') ?? 50, 1, 200, 50);
    return sendJson(res, 200, {
      ok: true,
      logs: history.slice(0, limit).map((row) => ({
        ...row,
        modelUsage: normalizeStoredModelUsage(row.modelUsage),
        costEstimate: normalizeCostEstimate(row.costEstimate),
        stages: normalizeAiGenerationStages(row.stages)
      })),
      summary: buildAiObservabilitySummary(history, { asOf: Date.now(), windowDays: 30 })
    });
  }),
  route('POST', '/api/import-guide', async ({ req, res }) => {
    enforceRateLimit(req, 'ai');
    await verifyPlanningAccess(req);
    const body = await readJsonBody(req);
    const urls = Array.isArray(body?.urls) ? body.urls.map((item) => truncateString(item, 800)).filter(Boolean) : extractUrls(body?.text);
    if (!urls.length) {
      throw createHttpError('请提供小红书、抖音或公开网页链接', 400, 'SOURCE_URL_REQUIRED');
    }
    const uniqueUrls = [...new Set(urls)].slice(0, MAX_IMPORT_URLS);
    const signal = bindRequestAbortSignal(req);
    const analyzedSources = await Promise.all(
      uniqueUrls.map(async (sourceUrl) => {
        try {
          return await analyzeSourceUrl(sourceUrl, signal);
        } catch (error) {
          const platform = detectPlatform(sourceUrl);
          const safeUrl = safeSourceUrl(sourceUrl);
          return {
            url: safeUrl,
            finalUrl: safeUrl,
            platform: platform.name,
            platformId: platform.id,
            status: 'failed',
            title: `${platform.name} 链接待补充`,
            description: '',
            excerpt: '',
            trustScore: 28,
            signals: ['已识别链接来源'],
            warnings: [error.message ?? '链接无法公开抓取', platform.note],
            fetchedAt: new Date().toISOString()
          };
        }
      })
    );
    const sources = analyzedSources.map((source) => ({ ...source, sourceId: importSourceId(source), proof: signImportedSource(source) }));
    const averageTrust = Math.round(sources.reduce((sum, source) => sum + source.trustScore, 0) / sources.length);
    const importLog = {
      id: cryptoRandomId(),
      sourceCount: sources.length,
      averageTrust,
      platforms: [...new Set(sources.map((source) => source.platform))],
      lowTrustCount: sources.filter((source) => source.trustScore < 45).length,
      createdAt: new Date().toISOString(),
      // Retain the signed fields for later authorization/revocation checks.
      sources
    };
    await appendJsonLine(IMPORT_LOG_PATH, importLog);
    // Shadow mode (off by default): ask Jev the same gate question; the response is unaffected.
    const shadowCity = truncateString(body?.city, 40);
    for (const source of sources) {
      scheduleShadowJudgment('import-gate', { source, city: shadowCity, ruleUsable: isUsableImportedSource(source) });
    }
    return sendJson(res, 200, {
      ok: true,
      importId: importLog.id,
      sourceCount: sources.length,
      averageTrust,
      sources,
      guideText: sources
        .map((source, index) =>
          [
            `来源 ${index + 1}｜${source.platform}｜可信 ${source.trustScore}｜${source.unavailableReason === 'too-little' ? '内容太少' : (IMPORT_STATUS_TEXT[source.status] ?? source.status)}`,
            `标题：${source.title}`,
            source.description ? `摘要：${source.description}` : '',
            source.excerpt ? `公开正文摘录：${source.excerpt}` : '',
            `可信信号：${source.signals.join('；')}`,
            `风险提示：${source.warnings.join('；')}`,
            `链接：${source.url}`
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n\n')
    });
  }),
  route('GET', '/api/imports', async ({ req, res, url }) => {
    verifySensitiveReadAccess(req);
    return sendJson(res, 200, {
      ok: true,
      imports: await readJsonLines(IMPORT_LOG_PATH, clampNumber(url.searchParams.get('limit') || undefined, 1, 200, 50))
    });
  })
];

/** The job id is the capability; a registered profile's job additionally needs that profile's token. */
async function readableGenerationJob(req, rawId) {
  const job = getGenerationJob(safeDecodePathSegment(rawId));
  if (!job) throw createHttpError('生成任务不存在或已过期（服务可能已重启），请重新生成', 404, 'GENERATION_JOB_NOT_FOUND');
  if (job.profileId !== 'anonymous' && !hasAdminAccess(req) && !(await verifyProfileReadAccess(req, job.profileId))) {
    throw createHttpError('生成任务不存在或已过期（服务可能已重启），请重新生成', 404, 'GENERATION_JOB_NOT_FOUND');
  }
  return job;
}

/** Mirrors the builder's gate (BuilderFlow hasActionableGuideInput) plus the low-trust threshold. */
export function isUsableImportedSource(source) {
  if (source?.status !== 'fetched' || Number(source?.trustScore) < 45) return false;
  return [source.description, source.excerpt].some((value) => String(value ?? '').trim().length >= 20);
}

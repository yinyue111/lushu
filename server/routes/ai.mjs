// Generation, OCR and import API routes.
import { hashText, clampNumber, createHttpError, truncateString } from '../lib/util.mjs';
import { AI_LOG_PATH, IMPORT_LOG_PATH, MAX_IMPORT_URLS, MAX_OCR_IMAGES, MAX_OCR_REQUEST_BYTES } from '../config/index.mjs';
import { appendJsonLine, readJsonLines } from '../storage/jsonl.mjs';
import { analyzeSourceUrl, detectPlatform, extractUrls } from '../import/source-page.mjs';
import { createRouteEditToken, cryptoRandomId, normalizeProfileId, sanitizeEditToken } from '../auth/tokens.mjs';
import { resolveWriteProfile, verifyApiAccess, verifySensitiveReadAccess } from '../auth/request-access.mjs';
import { bindRequestAbortSignal, readJsonBody, sendJson } from '../http/response.mjs';
import { route } from '../http/router.mjs';
import { enforceRateLimit } from '../http/rate-limit.mjs';
import { safeSourceUrl } from '../lib/urls.mjs';
import { normalizeRoutebookForStorage, signImportedSource } from '../routebooks/normalize.mjs';
import { analyzeGuideImages, generateRoutebook, generationFailureReason, normalizeOcrImage, sanitizePayload } from '../ai/generate.mjs';
import { enrichRoutebook } from '../trust/feedback.mjs';
import { appendVersionedRoutebook } from '../routebooks/versions.mjs';
import { normalizeUserRouteCreator } from '../routebooks/mutations.mjs';
import { importSourceId } from '../ops/source-identity.mjs';
import { buildAiObservabilitySummary, normalizeAiGenerationStages, normalizeCostEstimate, normalizeStoredModelUsage } from '../analytics/aiObservability.mjs';

function guideLogMeta(payload) {
  const guide = String(payload?.guide ?? '');
  return {
    inputHash: hashText(guide),
    inputLength: guide.length,
    sourceCount: payload?.importedSources?.length ?? 0
  };
}

export const aiRoutes = [
  route('POST', '/api/ocr-guide', async ({ req, res }) => {
    enforceRateLimit(req, 'ai');
    verifyApiAccess(req);
    const body = await readJsonBody(req, MAX_OCR_REQUEST_BYTES);
    const images = (Array.isArray(body?.images) ? body.images : []).slice(0, MAX_OCR_IMAGES).map((image, index) => normalizeOcrImage(image, index));
    if (!images.length) throw createHttpError('请上传至少 1 张攻略截图', 400, 'OCR_IMAGE_REQUIRED');
    return sendJson(res, 200, await analyzeGuideImages(images, bindRequestAbortSignal(req)));
  }),
  route('POST', '/api/generate-routebook', async ({ req, res }) => {
    enforceRateLimit(req, 'ai');
    verifyApiAccess(req);
    const sanitizedPayload = sanitizePayload(await readJsonBody(req));
    const actor = await resolveWriteProfile(req, sanitizedPayload.profileId);
    const payload = { ...sanitizedPayload, profileId: actor.profileId };
    const startedAt = Date.now();
    const requestId = /** @type {any} */ (req).requestId || cryptoRandomId();
    const inputMeta = guideLogMeta(payload);
    let observability = null;
    let persistenceStartedAt = null;
    let persistenceCompleted = false;
    try {
      const routebook = await generateRoutebook(payload, bindRequestAbortSignal(req));
      observability = routebook.observability;
      const profileId = normalizeProfileId(payload.profileId);
      const storedRoutebook = normalizeRoutebookForStorage(
        {
          ...routebook,
          schemaVersion: 2,
          version: 1,
          parentVersion: null,
          changeReason: 'AI 生成初始草稿',
          actorType: 'user',
          profileId,
          creator: normalizeUserRouteCreator(payload, profileId),
          sourceAuthorization: 'user-generated',
          editToken: sanitizeEditToken(payload.editToken) || createRouteEditToken()
        },
        routebook.publicId
      );
      persistenceStartedAt = Date.now();
      await appendVersionedRoutebook(storedRoutebook, 'generated');
      persistenceCompleted = true;
      observability.stages.persistence = { durationMs: Date.now() - persistenceStartedAt, status: 'completed', timedOut: false };
      await appendJsonLine(AI_LOG_PATH, {
        requestId,
        kind: 'generate-routebook',
        status: 'ok',
        city: payload.city,
        profileId,
        provider: routebook.provider,
        ...inputMeta,
        ...observability,
        outputTitle: storedRoutebook.title,
        trustScore: storedRoutebook.trustScore,
        stopCount: storedRoutebook.stops.length,
        publicId: storedRoutebook.publicId,
        durationMs: Date.now() - startedAt,
        createdAt: new Date().toISOString()
      });
      return sendJson(res, 200, { ...(await enrichRoutebook(storedRoutebook)), shareUrl: '' });
    } catch (error) {
      observability = error.observability ?? observability;
      if (observability && persistenceStartedAt != null && !persistenceCompleted) {
        observability = {
          ...observability,
          failureStage: 'persistence',
          stages: { ...observability.stages, persistence: { durationMs: Date.now() - persistenceStartedAt, status: 'failed', timedOut: false } }
        };
      }
      await appendJsonLine(AI_LOG_PATH, {
        requestId,
        kind: 'generate-routebook',
        status: 'error',
        city: payload.city,
        ...inputMeta,
        ...(observability ?? {}),
        code: error.code ?? 'MODEL_ERROR',
        failureReason: generationFailureReason(error),
        upstreamStatus: error.upstreamStatus,
        upstreamDetail: truncateString(error.upstreamDetail, 400),
        durationMs: Date.now() - startedAt,
        createdAt: new Date().toISOString()
      });
      throw error;
    }
  }),
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
    verifyApiAccess(req);
    const body = await readJsonBody(req);
    const urls = Array.isArray(body?.urls) ? body.urls.map((item) => truncateString(item, 800)).filter(Boolean) : extractUrls(body?.text);
    if (!urls.length) {
      throw createHttpError('请提供小红书、抖音、X 或公开网页链接', 400, 'SOURCE_URL_REQUIRED');
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
    return sendJson(res, 200, {
      ok: true,
      importId: importLog.id,
      sourceCount: sources.length,
      averageTrust,
      sources,
      guideText: sources
        .map((source, index) =>
          [
            `来源 ${index + 1}｜${source.platform}｜可信 ${source.trustScore}｜${source.status}`,
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
      imports: await readJsonLines(IMPORT_LOG_PATH, clampNumber(url.searchParams.get('limit'), 1, 200, 50))
    });
  })
];

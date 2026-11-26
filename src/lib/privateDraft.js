// Private draft copy sanitization (§4.3 & §7):
// Regardless of whether the caller copies from a public share view, public detail view,
// curated template or the original owner's full view, the local draft retains ONLY
// a valid Builder transport option and whitelisted/enum-clamped validation rows (no detail,
// no budget/must-go/avoid constraints, no matchedText guide quotes).
import { modernTermCopy, publicValidationRows, redactPrivatePreferenceProse } from '../../server/lib/termCopy.mjs';
import { TRANSPORT_OPTIONS } from '../components/Builder/builderModel.js';
import { isAiGeneratedRoutebook } from './aigc.js';
import { createRouteEditToken, profileRoutebookFields } from './profile.js';

const VALID_TRANSPORTS = new Set(TRANSPORT_OPTIONS);
const PUBLIC_STOP_ORIGINS = new Set(['user-guide', 'imported-source', 'editorial', 'user-added', 'model', 'unknown']);
const SYSTEM_METRIC_LABELS = new Set([
  '道路核对',
  '路线已查',
  '道路距离',
  '道路耗时',
  '资料核对分',
  '定位待复核',
  '预算估算',
  '编辑核对',
  '真实打卡',
  '主线完成率',
  '来源状态'
]);

export function sanitizeCopiedTransport(source) {
  const candidate = String(source?.transport || source?.constraints?.transport || '').trim();
  return VALID_TRANSPORTS.has(candidate) ? candidate : '';
}

function sanitizeCopiedProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') return undefined;
  const origin = PUBLIC_STOP_ORIGINS.has(provenance.origin) ? provenance.origin : 'unknown';
  return {
    origin,
    ...(origin === 'editorial' && provenance.name ? { name: String(provenance.name).slice(0, 48) } : {}),
    reviewedPoi: provenance.reviewedPoi === true,
    verifiedFactCount: Math.max(0, Math.min(20, Math.floor(Number(provenance.verifiedFactCount) || 0)))
  };
}

export function stripLivePoiTrust(stops, redactContext = undefined) {
  if (!Array.isArray(stops)) return [];
  const ctx = redactContext && typeof redactContext === 'object' ? redactContext : undefined;
  return stops.map((raw) => {
    const { poiTrust: _poiTrust, score: _score, provenance, facts, verify, risk, ...stop } = raw ?? {};
    const cleanProvenance = sanitizeCopiedProvenance(provenance);
    return {
      ...stop,
      ...(typeof verify === 'string' ? { verify: modernTermCopy(redactPrivatePreferenceProse(verify, ctx)) } : {}),
      ...(typeof risk === 'string' ? { risk: modernTermCopy(redactPrivatePreferenceProse(risk, ctx)) } : {}),
      ...(cleanProvenance ? { provenance: cleanProvenance } : {}),
      ...(Array.isArray(facts)
        ? {
            facts: facts
              .map(({ sourceUrl: _sourceUrl, ...fact }) => ({
                ...fact,
                ...(typeof fact?.value === 'string' ? { value: modernTermCopy(redactPrivatePreferenceProse(fact.value, ctx)) } : {}),
                ...(typeof fact?.sourceLabel === 'string' ? { sourceLabel: modernTermCopy(fact.sourceLabel) } : {}),
                ...(typeof fact?.status === 'string' ? { status: modernTermCopy(fact.status) } : {})
              }))
              .filter((fact) => fact?.value !== '')
          }
        : {})
    };
  });
}

function sanitizeCopiedRouteLegs(routeLegs) {
  if (!Array.isArray(routeLegs)) return [];
  return routeLegs.map((leg) => {
    if (!leg || typeof leg !== 'object') return leg;
    const { proof: _proof, ...rest } = leg;
    return rest;
  });
}

function sanitizeCopiedMetrics(metrics) {
  if (!Array.isArray(metrics)) return [];
  return metrics
    .map((item) => ({
      label: modernTermCopy(String(item?.label ?? '')),
      value: modernTermCopy(String(item?.value ?? ''))
    }))
    .filter((item) => SYSTEM_METRIC_LABELS.has(item.label))
    .slice(0, 9);
}

export function createPrivateRoutebookId() {
  const uuid = globalThis.crypto?.randomUUID?.().replace(/-/g, '');
  return uuid ? `route_${uuid}` : `route_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

export function createPrivateRoutebookDraft(source, profile) {
  const now = new Date().toISOString();
  const transport = sanitizeCopiedTransport(source);
  const fellBackFrom = ['fast', 'deep'].includes(source?.provider?.fellBackFrom) ? source.provider.fellBackFrom : '';
  const redactContext = {
    constraints: source?.constraints,
    stopNames: Array.isArray(source?.stops) ? source.stops.map((stop) => stop?.name).filter(Boolean) : []
  };
  const stops = stripLivePoiTrust(source?.stops, redactContext);
  const days =
    Array.isArray(source?.days) && source.days.length
      ? source.days.map((day) => String(day ?? '').slice(0, 24)).filter(Boolean)
      : [...new Set(stops.map((stop) => stop?.day || 'Day 1'))];

  return {
    id: createPrivateRoutebookId(),
    title: String(source?.title ?? '').slice(0, 80),
    summary: modernTermCopy(redactPrivatePreferenceProse(String(source?.summary ?? ''), redactContext)).slice(0, 220),
    city: String(source?.city ?? '').slice(0, 40),
    ...(transport ? { transport } : {}),
    constraints: transport ? { transport } : {},
    days,
    stops,
    routeLegs: sanitizeCopiedRouteLegs(source?.routeLegs),
    assets: Array.isArray(source?.assets)
      ? source.assets.slice(0, 12).map((item) => ({
          label: String(item?.label ?? '').slice(0, 30),
          type: String(item?.type ?? '').slice(0, 24),
          ...(item?.confidence == null ? {} : { confidence: Number(item.confidence) || 0 })
        }))
      : [],
    validations: publicValidationRows(source?.validations),
    metrics: sanitizeCopiedMetrics(source?.metrics),
    variants: Array.isArray(source?.variants)
      ? source.variants.slice(0, 8).map((variant) => {
          const variantContext = {
            constraints: source?.constraints,
            stopNames: Array.isArray(variant?.stops) ? variant.stops.map((stop) => stop?.name).filter(Boolean) : redactContext.stopNames
          };
          return {
            id: variant?.id,
            mode: variant?.mode,
            label: variant?.label,
            summary: typeof variant?.summary === 'string' ? modernTermCopy(redactPrivatePreferenceProse(variant.summary, variantContext)) : '',
            days: Array.isArray(variant?.days) ? variant.days : days,
            stops: stripLivePoiTrust(variant?.stops, variantContext),
            routeLegs: sanitizeCopiedRouteLegs(variant?.routeLegs),
            validations: publicValidationRows(variant?.validations),
            metrics: sanitizeCopiedMetrics(variant?.metrics)
          };
        })
      : [],
    ...(source?.activeVariantId ? { activeVariantId: source.activeVariantId } : {}),
    ...profileRoutebookFields(profile),
    editToken: createRouteEditToken(),
    schemaVersion: 2,
    version: 0,
    parentVersion: null,
    changeReason: '复制为个人草稿',
    actorType: 'user',
    publishStatus: 'draft',
    sourceAuthorization: 'user-generated',
    copyCount: 0,
    provider: {
      ...(fellBackFrom ? { fellBackFrom } : {}),
      ...(isAiGeneratedRoutebook(source) ? { generatedAt: source?.provider?.generatedAt || now } : { name: 'curation' }),
      copiedAt: now
    },
    updatedAt: now
  };
}

export function normalizeSavedPrivateDraft(remote, local, profile) {
  const { shareUrl: _shareUrl, ...saved } = remote ?? {};
  return {
    ...local,
    ...saved,
    ...profileRoutebookFields(profile),
    editToken: saved.editToken || local.editToken,
    publishStatus: 'draft',
    sourceAuthorization: 'user-generated',
    copyCount: 0
  };
}

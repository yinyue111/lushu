import { safeEqualHex } from '../auth/tokens.mjs';
import { signImportedSource } from '../routebooks/normalize.mjs';
import { importSourceId } from './source-identity.mjs';

export const SOURCE_AUTHORIZATION_SCOPES = {
  'personal-use-only': 'private-routebook-generation',
  'authorization-pending': 'private-routebook-generation',
  'authorized-public': 'public-routebook-citation',
  revoked: 'none',
  'not-applicable': 'none'
};

export function hasValidImportedSourceProof(source = {}) {
  return safeEqualHex(String(source.proof ?? ''), signImportedSource(source));
}

export function defaultSourceDisposition() {
  return { authorizationStatus: 'personal-use-only', authorizationScope: 'private-routebook-generation', featured: false };
}

export function applyImportSourceOpsOverlay(source, context) {
  const sourceId = importSourceId(source);
  const event = context?.sourceOverlays?.get(sourceId);
  const proofReady = hasValidImportedSourceProof(source);
  // Revocation also applies to legacy records; promotion requires a valid content signature.
  const applicable = proofReady || event?.state?.authorizationStatus === 'revoked';
  const state = applicable && event ? event.state : defaultSourceDisposition();
  return {
    ...source,
    sourceId,
    proofReady,
    authorizationStatus: state.authorizationStatus,
    authorizationScope: state.authorizationScope,
    opsFeatured: state.featured === true && state.authorizationStatus === 'authorized-public',
    opsDisposition: { ...state, action: event?.action ?? '', reason: event?.reason ?? '', actor: event?.actor ?? '', updatedAt: event?.createdAt ?? '' },
    opsAuditHistory: context?.histories?.get(`import-source:${sourceId}`) ?? []
  };
}

export function applyImportSourceOpsToRoutebook(routebook, context) {
  if (!routebook) return routebook;
  const importedSources = (routebook.importedSources ?? []).map((source) => applyImportSourceOpsOverlay(source, context));
  const byId = new Map(importedSources.map((source) => [source.sourceId, source]));
  const mapStops = (stops = []) =>
    stops.map((stop) => ({
      ...stop,
      sourceEvidence: (stop.sourceEvidence ?? [])
        .map((evidence) => {
          const source = byId.get(evidence.sourceId || evidence.id);
          if (!source) return ['matched-source', 'route-source'].includes(evidence.type) ? { ...evidence, authorizationStatus: 'personal-use-only' } : evidence;
          return {
            ...evidence,
            sourceId: source.sourceId,
            authorizationStatus: source.authorizationStatus,
            authorizationScope: source.authorizationScope,
            opsFeatured: source.opsFeatured
          };
        })
        .filter((evidence) => !evidence.authorizationStatus || ['authorized-public', 'not-applicable'].includes(evidence.authorizationStatus))
    }));
  return {
    ...routebook,
    importedSources,
    stops: mapStops(routebook.stops),
    variants: (routebook.variants ?? []).map((variant) => ({ ...variant, stops: mapStops(variant.stops) }))
  };
}

export function sourcesPreventPublicStatus(routebook, context) {
  return (routebook?.importedSources ?? []).some((source) => {
    const disposition = applyImportSourceOpsOverlay(source, context);
    return !['authorized-public', 'not-applicable'].includes(disposition.authorizationStatus);
  });
}

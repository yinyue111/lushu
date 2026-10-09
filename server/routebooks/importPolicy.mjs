// Publishing policy for routebooks generated from imported third-party guides.
// See IMPORTED_ROUTEBOOK_PUBLIC_POLICY in server/config/index.mjs.
import { IMPORTED_ROUTEBOOK_PUBLIC_POLICY, PUBLIC_PUBLISHING_ENABLED } from '../config/index.mjs';
import { sourcesPreventPublicStatus } from '../ops/sources.mjs';
import { IMPORTED_PUBLIC_EXPLANATION, PUBLIC_PUBLISHING_DISABLED_EXPLANATION, routebookGuideOrigins } from '../../src/lib/importOrigins.js';

/**
 * Owner-facing description of what the routebook may do. `context` is the ops audit
 * context (source authorization overlays); omit it to treat sources as unauthorized.
 * @param {Record<string, any> | null | undefined} routebook
 * @param {any} [context]
 * @param {string} [policy]
 * @param {boolean} [publishingEnabled]
 */
export function routebookPublicationPolicy(
  routebook,
  context = null,
  policy = IMPORTED_ROUTEBOOK_PUBLIC_POLICY,
  publishingEnabled = PUBLIC_PUBLISHING_ENABLED
) {
  const origins = routebookGuideOrigins(routebook);
  const imported = origins.length > 0;
  const base = { policy, imported, origins, friendLinkAllowed: true };
  if (!publishingEnabled) {
    return {
      ...base,
      publicAllowed: false,
      publishingDisabled: true,
      canClaimAuthorship: false,
      code: 'PUBLIC_PUBLISHING_DISABLED',
      reason: PUBLIC_PUBLISHING_DISABLED_EXPLANATION
    };
  }
  if (!imported) return { ...base, publicAllowed: true, canClaimAuthorship: false, code: '', reason: '' };
  if (policy === 'authorization-required') {
    return { ...base, publicAllowed: true, canClaimAuthorship: false, code: '', reason: '' };
  }
  const sourcesAuthorized = origins.includes('link') && !origins.includes('ocr') && !sourcesPreventPublicStatus(routebook, context);
  if (policy === 'unlisted-unless-authorized' && sourcesAuthorized) {
    return { ...base, publicAllowed: true, canClaimAuthorship: false, code: '', reason: '' };
  }
  return {
    ...base,
    publicAllowed: false,
    // Original authors can still go through the existing authorization review.
    canClaimAuthorship: policy === 'unlisted-unless-authorized',
    claimedAuthorship: routebook?.authorshipClaim?.claimed === true,
    code: 'IMPORTED_ROUTEBOOK_PUBLIC_DISABLED',
    reason: IMPORTED_PUBLIC_EXPLANATION
  };
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isImportedRoutebook, normalizeGuideOrigins, routebookGuideOrigins } from '../../src/lib/importOrigins.js';
import { routebookPublicationPolicy } from '../../server/routebooks/importPolicy.mjs';

test('guide origins: links imply "link", unknown values are dropped', () => {
  assert.deepEqual(normalizeGuideOrigins(['ocr', 'evil', 'link', 'ocr']), ['link', 'ocr']);
  assert.deepEqual(routebookGuideOrigins({ importedSources: [{ url: 'https://x.com/a' }] }), ['link']);
  assert.equal(isImportedRoutebook({ guideOrigins: [] }), false);
  assert.equal(isImportedRoutebook({ guideOrigins: ['ocr'] }), true);
});

test('publication policy per mode', () => {
  const ocr = { guideOrigins: ['ocr'] };
  assert.equal(routebookPublicationPolicy({}, null, 'unlisted-only').publicAllowed, true, 'original content is unaffected');
  assert.equal(routebookPublicationPolicy(ocr, null, 'unlisted-unless-authorized').publicAllowed, false);
  assert.equal(routebookPublicationPolicy(ocr, null, 'unlisted-unless-authorized').canClaimAuthorship, true);
  assert.equal(routebookPublicationPolicy(ocr, null, 'unlisted-only').canClaimAuthorship, false);
  assert.equal(routebookPublicationPolicy(ocr, null, 'authorization-required').publicAllowed, true);
  assert.match(routebookPublicationPolicy(ocr, null, 'unlisted-only').reason, /原作者/);
});

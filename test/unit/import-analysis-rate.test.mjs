import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeImportAnalysis } from '../../server/analytics/dashboard.mjs';

test('deleted / login-wall sources count as failed parses instead of leaving the denominator', () => {
  const summary = summarizeImportAnalysis([
    { sources: [{ status: 'fetched' }, { status: 'unavailable' }] },
    { sources: [{ status: 'metadata-only' }, { status: 'failed' }, { status: 'pending' }] },
    { sources: null }
  ]);
  assert.equal(summary.recordedImportSources.length, 4);
  assert.equal(summary.importAnalysisSucceeded, 1);
  assert.equal(summary.importAnalysisFailed, 3);
});

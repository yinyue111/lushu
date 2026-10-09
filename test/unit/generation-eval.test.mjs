import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockRunner, readCases, runGenerationEval, scoreRoutebook } from '../../scripts/eval/run-generation-eval.mjs';

test('generation eval: mock runner passes every case offline', async () => {
  const cases = readCases();
  assert.ok(cases.length >= 8);
  const report = await runGenerationEval(cases, mockRunner);
  assert.equal(report.passed, report.total, JSON.stringify(report.results.filter((result) => !result.pass)));
});

test('generation eval: scoring catches missing must-go, avoided stops, day count and off-city stops', async () => {
  const [evalCase] = readCases().filter((item) => item.id === 'hz-mustgo-1');
  const bad = scoreRoutebook(evalCase, {
    stops: [
      { day: 'Day 1', name: '柳浪闻莺', lat: 30.242, lng: 120.1617 },
      { day: 'Day 2', name: '外滩', lat: 31.24, lng: 121.49 }
    ]
  });
  assert.equal(bad.pass, false);
  assert.deepEqual(
    bad.checks.filter((check) => !check.pass).map((check) => check.id),
    ['must-go-avoid', 'day-count', 'in-city-coordinates']
  );
  const failing = await runGenerationEval([evalCase], async () => {
    throw new Error('model down');
  });
  assert.equal(failing.results[0].error, 'model down');
});

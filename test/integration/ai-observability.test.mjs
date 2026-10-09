import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { API_TOKEN, adminHeaders, fetchJson, jsonHeaders, startServer } from '../helpers/server.mjs';

let server;
let provider;
let scenario = 'retry';
let attempt = 0;
const generated = {
  title: '杭州三站测试路线',
  city: '杭州',
  days: ['第1天'],
  stops: ['柳浪闻莺', '南宋御街', '北山街'].map((name, index) => ({
    name,
    day: '第1天',
    time: `${10 + index}:00`,
    stay: '30分钟',
    cost: '免费',
    area: '杭州',
    score: 75,
    geoConfidence: 90
  }))
};

before(async () => {
  provider = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume the local test request */
    }
    attempt += 1;
    res.setHeader('content-type', 'application/json');
    if (scenario === 'retry' && attempt === 1) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'json_schema not supported' } }));
      return;
    }
    res.end(
      JSON.stringify({
        output_text: scenario === 'bad-output' ? 'not json' : JSON.stringify(generated),
        usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 }
      })
    );
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = /** @type {import('node:net').AddressInfo} */ (provider.address());
  server = await startServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AI_INPUT_COST_PER_MILLION_TOKENS: '2',
      AI_OUTPUT_COST_PER_MILLION_TOKENS: '8',
      AI_COST_CURRENCY: 'CNY'
    }
  });
});
after(async () => {
  await server?.stop();
  provider?.closeAllConnections();
  await new Promise((resolve) => provider?.close(resolve));
});

async function generate() {
  return fetchJson(`${server.baseUrl}/api/generate-routebook`, {
    method: 'POST',
    headers: jsonHeaders({ 'x-routebook-token': API_TOKEN }),
    body: JSON.stringify({ city: '杭州', guide: '柳浪闻莺、南宋御街和北山街一日游', constraints: { days: 1 } })
  });
}
const logs = () => fetchJson(`${server.baseUrl}/api/logs?limit=50`, { headers: adminHeaders() });

test('usage covers all upstream attempts and partial data never invents cost', async () => {
  const result = await generate();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const row = (await logs()).data.logs[0];
  assert.equal(row.modelUsage.attemptCount, 2);
  assert.equal(row.modelUsage.reportedAttemptCount, 1);
  assert.equal(row.modelUsage.status, 'partial');
  assert.equal(row.modelUsage.totalTokens, 160);
  assert.equal(row.costEstimate.status, 'unavailable');
  assert.equal(row.costEstimate.amount, null);
  assert.ok(row.stages.model.durationMs >= 0);
  assert.equal(row.stages.routing.status, 'degraded');
  assert.equal(row.stages.persistence.status, 'completed');
});

test('complete usage plus explicit prices yields an auditable estimate', async () => {
  scenario = 'success';
  attempt = 0;
  assert.equal((await generate()).status, 200);
  const row = (await logs()).data.logs[0];
  assert.equal(row.modelUsage.status, 'reported');
  assert.equal(row.costEstimate.status, 'estimated');
  assert.equal(row.costEstimate.currency, 'CNY');
  assert.ok(Math.abs(row.costEstimate.amount - 0.00056) < 1e-10);
  assert.equal(row.costEstimate.basis, 'environment-price-snapshot');
});

test('failed output records model-stage failure and rolling summaries keep unavailable metrics explicit', async () => {
  scenario = 'bad-output';
  attempt = 0;
  const result = await generate();
  assert.equal(result.status, 502);
  const data = (await logs()).data;
  assert.equal(data.logs[0].failureStage, 'model');
  assert.equal(data.logs[0].stages.model.status, 'failed');
  assert.equal(data.summary.totalCount, 3);
  assert.equal(data.summary.successCount, 2);
  assert.equal(data.summary.failureCount, 1);
  assert.equal(data.summary.costCoverage.estimatedCount, 2);
  const dashboard = await fetchJson(`${server.baseUrl}/api/dashboard`, { headers: adminHeaders() });
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.data));
  assert.equal(dashboard.data.dashboard.funnel.aiSatisfactionRate, null);
  assert.equal(dashboard.data.dashboard.funnel.unusableComplaintRateStatus, 'not-instrumented');
  // Redirects after a product click are not collected yet: null, never 0%.
  assert.equal(dashboard.data.dashboard.funnel.redirectRate, null);
  assert.equal(dashboard.data.dashboard.funnel.redirectRateStatus, 'not-instrumented');
  assert.ok(dashboard.data.dashboard.funnel.constraintSatisfaction, 'constraint satisfaction breakdown is exposed');
  assert.ok(dashboard.data.dashboard.metricDefinitions.constraintSatisfaction.denominator);
});

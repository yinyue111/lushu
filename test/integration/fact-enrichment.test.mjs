import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_TOKEN, adminHeaders, startServer } from '../helpers/server.mjs';
import { authEnv, createClient, signUpWithEmail } from '../helpers/accounts.mjs';

// Background 门票/开放时间 enrichment end to end with a mock model, mock AMap, mock relay web search and
// mock cited pages: only logged-in users' routebooks are queued; only scenic stops are filled, and only
// with two agreeing sources; a chain and a conflict stay 待确认; a transient relay error is retried;
// the queue survives a restart; a "wrong" report hides the value; ops sees the stats.
const PASSWORD = '西湖边走一走2026';
const generated = {
  title: '联网补全测试',
  city: '杭州',
  days: ['第1天'],
  stops: [
    { name: '灵隐寺', cost: '门票待确认' },
    { name: '知味观', cost: '人均待确认' },
    { name: '河坊街', cost: '免费' }
  ].map((stop, index) => ({ ...stop, day: '第1天', time: `${9 + index * 2}:00`, stay: '1小时', area: '杭州', lat: 30.24, lng: 120.1, geoConfidence: 80 }))
};
let searchCalls = 0;
let failNextSearch = true;

function mock(port) {
  const base = `http://127.0.0.1:${port}`;
  return async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, base);
    const json = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/v1/responses') {
      const body = JSON.parse(raw);
      if (!body.tools?.some((t) => t.type === 'web_search')) {
        return json({ output_text: JSON.stringify(generated), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
      }
      searchCalls += 1;
      if (failNextSearch) {
        failNextSearch = false;
        return json({ error: { message: 'upstream busy' } }, 502);
      }
      const place = String(body.input).match(/「(.+?)」/)[1];
      const answers = {
        灵隐寺: { price: '免费', priceSources: [`${base}/a/lingyin`], hours: '07:30-17:30', hoursSources: [`${base}/a/lingyin`] },
        河坊街: { hours: '09:00-22:00' }
      };
      const cited = [`${base}/a/lingyin`, `http://localhost:${port}/b/lingyin`, `https://www.dianping.com/shop/1`, `${base}/a/hefang`];
      return json({
        output: [
          { type: 'web_search_call', action: { type: 'search', sources: cited.map((u) => ({ type: 'url', url: u })) } },
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answers[place] ?? {}), annotations: [] }] }
        ],
        usage: { cost_in_usd_ticks: 5e8, server_side_tool_usage_details: { web_search_calls: 2 } }
      });
    }
    if (url.pathname === '/v5/place/text') {
      const keywords = url.searchParams.get('keywords');
      const poi = (name, type, hours) => ({ id: `B-${name}`, name, type, location: '120.105,30.242', business: { opentime_week: hours } });
      const pois = {
        灵隐寺: [poi('灵隐寺', '风景名胜;风景名胜;国家级景点', '周一至周日 07:30-17:30 最晚进入17:00')],
        知味观: [poi('知味观(湖滨总店)', '餐饮服务;中餐厅', '08:30-21:30'), poi('知味观(采荷店)', '餐饮服务;中餐厅', '07:00-20:00')],
        河坊街: [poi('河坊街', '购物服务;特色商业街;步行街', '周一至周日 00:00-24:00')]
      };
      return json({ status: '1', pois: pois[keywords] ?? [] });
    }
    if (url.pathname.startsWith('/v3/')) return json({ status: '1', count: '0', pois: [], geocodes: [] });
    if (url.pathname === '/robots.txt') return res.end('User-agent: *\nDisallow: /secret\n');
    const pages = {
      '/a/lingyin': '<title>灵隐寺公告</title><p>灵隐寺 自2025年12月1日起免费开放，开放时间 7:30—17:30</p>',
      '/b/lingyin': '<title>新闻</title><p>灵隐飞来峰景区、灵隐寺免票，需实名预约</p>',
      '/a/hefang': '<p>河坊街 营业 9:00-22:00</p>'
    };
    if (pages[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pages[url.pathname]);
    }
    res.writeHead(404);
    res.end();
  };
}

test('logged-in routebooks are enriched in the background with sourced 门票/开放时间 only', async (t) => {
  const upstream = createServer();
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;
  upstream.on('request', mock(port));
  const env = authEnv('both', {
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    AMAP_GEOCODE_KEY: 'test-key',
    AMAP_API_BASE_URL: `http://127.0.0.1:${port}`,
    ENRICH_ENABLED: 'true',
    ENRICH_ALLOW_PRIVATE_FETCH_FOR_TESTS: 'true',
    ENRICH_POLL_MS: '100',
    ENRICH_LEASE_MS: '1500',
    ENRICH_RETRY_BASE_MS: '200',
    GENERATION_JOB_POLL_WAIT_MS: '2000'
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'enrich-it-'));
  let server = await startServer({ env, dataDir });
  t.after(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });

  const generate = async (client, profileId, headers = {}) => {
    const started = await client.request('/api/generation-jobs', {
      method: 'POST',
      body: { city: '杭州', guide: '灵隐寺、知味观吃小笼、河坊街', profileId },
      headers
    });
    assert.ok([200, 202].includes(started.status), JSON.stringify(started.data));
    let job = started.data.job;
    for (let i = 0; i < 30 && !['succeeded', 'failed'].includes(job.status); i += 1) {
      job = (await client.request(`/api/generation-jobs/${job.jobId}?after=${job.seq}&profileId=${profileId}`, { headers })).data.job;
    }
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error ?? job));
    const routebook = job.result.routebook ?? job.result;
    return routebook.publicId || routebook.id;
  };

  let user = createClient(server.baseUrl);
  const registered = await signUpWithEmail(server, user, 'enrich@example.com', { password: PASSWORD });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  const profileId = registered.data.account.profileId;
  const id = await generate(user, profileId);

  const read = async (client = user) => (await client.request(`/api/routebooks/${id}/enrichment`)).data;
  const first = await read();
  assert.ok(['pending', 'done'].includes(first.enrichment.status), JSON.stringify(first));

  // The first web search fails with 502: retried with backoff, then done. Restart the server meanwhile.
  await server.stop();
  server = await startServer({ env, dataDir });
  user = createClient(server.baseUrl);
  const relogin = await user.post('/api/auth/login', { identifier: 'enrich@example.com', password: PASSWORD });
  assert.equal(relogin.status, 200, JSON.stringify(relogin.data));
  let view;
  for (let i = 0; i < 100; i += 1) {
    view = (await read()).enrichment;
    if (view.status === 'done' || view.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(view.status, 'done', JSON.stringify(view) + JSON.stringify(server.output).slice(-3000));
  assert.ok(searchCalls >= 2, 'the failed search was retried');

  const claim = (name, field) => view.claims.find((c) => c.stopName === name && c.field === field);
  assert.equal(claim('灵隐寺', 'price').value, '免费');
  assert.match(claim('灵隐寺', 'price').display, /^免费 · 来自灵隐寺公告等2个来源 · 查询于\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(
    claim('灵隐寺', 'price').sources.map((s) => s.domain),
    ['127.0.0.1', 'localhost'].map((d) => d)
  );
  assert.equal(claim('灵隐寺', 'hours').value, '07:30-17:30');
  assert.equal(claim('灵隐寺', 'hours').sources[0].kind, 'amap');
  assert.equal(claim('知味观', 'price'), undefined, 'chain: never filled');
  assert.equal(claim('知味观', 'hours'), undefined);
  assert.equal(claim('河坊街', 'hours'), undefined, 'AMap 24h vs page 9:00-22:00: conflict keeps 待确认');
  assert.ok(!view.claims.some((c) => c.sources.some((s) => /dianping/.test(s.url))));

  // The routebook itself is unchanged (the fact guard's output stands; enrichment is shown beside it).
  const book = (await user.request(`/api/routebooks/${id}`)).data.routebook;
  assert.equal(book.stops[0].cost, '门票待确认');

  // "This is wrong": hidden on this routebook, cache entry dropped, ops sees the report.
  const reported = await user.post(`/api/routebooks/${id}/enrichment/report`, { stopKey: claim('灵隐寺', 'price').stopKey, field: 'price', note: '现场收费' });
  assert.equal(reported.status, 200, JSON.stringify(reported.data));
  assert.equal(
    (await read()).enrichment.claims.find((c) => c.stopName === '灵隐寺' && c.field === 'price'),
    undefined
  );

  const ops = await createClient(server.baseUrl).request('/api/ops/enrichment', { headers: adminHeaders() });
  assert.equal(ops.status, 200, JSON.stringify(ops.data));
  assert.equal(ops.data.enrichment.reports, 1);
  assert.ok(ops.data.enrichment.byStatus.done >= 1);
  assert.ok(ops.data.enrichment.spend[0].searches >= 1);

  // Guests are never enriched.
  const guest = createClient(server.baseUrl);
  const guestId = await generate(guest, 'anonymous', { 'x-routebook-token': API_TOKEN, 'x-forwarded-for': '203.0.113.9' });
  const queued = (await readFile(join(dataDir, 'enrichment.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => row.t === 'job');
  assert.ok(queued.some((row) => row.v.routebookId === id));
  assert.ok(!queued.some((row) => row.v.routebookId === guestId), 'guest routebooks are never queued');
});

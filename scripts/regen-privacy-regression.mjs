// Regeneration privacy regression (release-v7 §4.5):
// Uses a local HTTP model stub (never calls real AI) that deliberately echoes the owner's
// private budget, must-go, avoid items and avoid counts into model-written validations,
// riskNotes and logs. After generating and publishing the routebook, all four public APIs
// (detail, share, public list, copy) must expose ONLY the 9 whitelisted validation IDs,
// ONLY { id, label, state } (no detail), ONLY allowed enum state strings, and ZERO private text.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PUBLIC_VALIDATION_STATES } from '../server/lib/termCopy.mjs';
import { startServer, API_TOKEN, adminHeaders, fetchJson, jsonHeaders } from '../test/helpers/server.mjs';

const PRIVATE_BUDGET = '人均 4912 元';
const PRIVATE_MUST_GO = '私藏玄武茶寮';
const PRIVATE_AVOID = '前同事网红馆';

const FORBIDDEN_PATTERNS = [/4912/, /私藏玄武茶寮/, /前同事网红馆/, /人均预算/, /\d+\s*个避开/, /避开项/];

const generatedPayload = {
  title: '杭州西湖二日路线',
  summary: `第一天走西湖南线，第二天去寺院和茶山。全程按${PRIVATE_BUDGET}控制，已避开${PRIVATE_AVOID}。`,
  city: '杭州',
  days: ['Day 1', 'Day 2'],
  stops: [
    {
      name: '柳浪闻莺',
      day: 'Day 1',
      time: '09:30',
      stay: '60 分钟',
      cost: '免费',
      area: '西湖',
      verify: `出发前确认入口；必去未找到：${PRIVATE_MUST_GO}。`,
      risk: `已按要求避开 1 个避开项（${PRIVATE_AVOID}）；周末可能人多。`,
      geoConfidence: 90
    },
    { name: '南宋御街', day: 'Day 1', time: '11:30', stay: '90 分钟', cost: '80 元', area: '上城', geoConfidence: 90 },
    { name: '法喜寺', day: 'Day 2', time: '09:30', stay: '90 分钟', cost: '10 元', area: '西湖西南', geoConfidence: 90 }
  ],
  // Stub model deliberately tries to leak private constraints via validations, riskNotes and logs:
  validations: [
    {
      id: 'model-budget-echo',
      label: '预算核对',
      state: `按${PRIVATE_BUDGET}控制`,
      detail: `全程${PRIVATE_BUDGET}，必去：${PRIVATE_MUST_GO}，已排除 1 个避开项（${PRIVATE_AVOID}）。`
    },
    {
      id: 'edit-routing',
      label: '路线',
      state: `避开${PRIVATE_AVOID}`,
      detail: `含必去 ${PRIVATE_MUST_GO}`
    }
  ],
  riskNotes: [{ label: '预算提醒', detail: `${PRIVATE_BUDGET}，避开 ${PRIVATE_AVOID}（共 1 个避开项）` }],
  logs: [{ stage: '偏好复述', input: PRIVATE_BUDGET, result: `${PRIVATE_MUST_GO} / 1 个避开项`, status: '完成' }]
};

async function main() {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain */
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        output_text: JSON.stringify(generatedPayload),
        usage: { input_tokens: 100, output_tokens: 80, total_tokens: 180 }
      })
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;

  const server = await startServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_API_KEY: 'regen-privacy-stub-key',
      OPENAI_MODEL: 'regen-stub-model',
      AI_MODEL_FAST: 'regen-stub-model',
      AI_MODEL_DEEP: 'regen-stub-model',
      AI_STREAM: 'false',
      ENRICH_ENABLED: 'false',
      REQUIRE_LOCAL_ADMIN_TOKEN: 'true',
      ALLOW_LOCAL_ADMIN_BYPASS: 'false'
    }
  });

  try {
    const gen = await fetchJson(`${server.baseUrl}/api/generate-routebook`, {
      method: 'POST',
      headers: jsonHeaders({ 'x-routebook-token': API_TOKEN }),
      body: JSON.stringify({
        city: '杭州',
        guide: '柳浪闻莺、南宋御街、法喜寺两日游',
        constraints: {
          duration: '2 天 1 晚',
          budget: PRIVATE_BUDGET,
          mustGo: PRIVATE_MUST_GO,
          avoid: PRIVATE_AVOID,
          transport: '公交地铁 + 步行'
        }
      })
    });
    assert.equal(gen.status, 200, `generate failed: ${JSON.stringify(gen.data)}`);
    const generated = gen.data.routebook ?? gen.data;
    const routeId = generated?.publicId || generated?.id;
    assert.ok(routeId, 'generated routebook must have an id');

    const published = await fetchJson(`${server.baseUrl}/api/routebooks/${encodeURIComponent(routeId)}/status`, {
      method: 'POST',
      headers: jsonHeaders(adminHeaders()),
      body: JSON.stringify({
        status: 'published',
        expectedVersion: generated.version ?? 1,
        note: '再生隐私回归测试发布审核备注',
        allowUnverifiedRouting: true,
        routingOverrideReason: '本地再生隐私回归无高德密钥'
      })
    });
    assert.equal(published.status, 200, `admin publish failed: ${JSON.stringify(published.data)}`);

    const detail = await fetchJson(`${server.baseUrl}/api/routebooks/${encodeURIComponent(routeId)}`);
    const share = await fetchJson(`${server.baseUrl}/api/share/${encodeURIComponent(routeId)}`);
    const list = await fetchJson(`${server.baseUrl}/api/routebooks?status=published&city=${encodeURIComponent('杭州')}`);
    const copy = await fetchJson(`${server.baseUrl}/api/routebooks/${encodeURIComponent(routeId)}/copy`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ surface: 'public-share' })
    });

    assert.equal(detail.status, 200);
    assert.equal(share.status, 200);
    assert.equal(list.status, 200);
    assert.equal(copy.status, 200);

    const listedBook = (list.data.routebooks ?? []).find((item) => item.publicId === routeId);
    assert.ok(listedBook, 'published routebook must appear in public list');

    const endpoints = [
      ['detail', detail.data.routebook, detail.data],
      ['share', share.data.routebook, share.data],
      ['list', listedBook, listedBook],
      ['copy', copy.data.routebook, copy.data]
    ];

    let checkedRows = 0;
    for (const [name, book, rawPayload] of endpoints) {
      const serialized = JSON.stringify(rawPayload);
      for (const pattern of FORBIDDEN_PATTERNS) {
        assert.equal(pattern.test(serialized), false, `${name} leaked private pattern ${pattern}: ${serialized}`);
      }
      assert.equal(Object.hasOwn(book, 'constraints'), false, `${name} must not expose constraints`);
      assert.equal(Object.hasOwn(book, 'aiNotes'), false, `${name} must not expose aiNotes`);
      assert.equal(book.summary, '第一天走西湖南线，第二天去寺院和茶山。', `${name} must keep public scenic summary sentence while stripping private clauses`);
      assert.equal(book.stops[0]?.verify, '出发前确认入口。', `${name} must strip private must-go clause from stop.verify`);
      assert.equal(book.stops[0]?.risk, '周末可能人多。', `${name} must strip private avoid clause from stop.risk`);
      assert.ok(Array.isArray(book.validations) && book.validations.length > 0, `${name} must expose whitelisted validations`);

      for (const row of book.validations) {
        checkedRows += 1;
        assert.deepEqual(Object.keys(row).sort(), ['id', 'label', 'state'], `${name} validation row must only have id/label/state: ${JSON.stringify(row)}`);
        assert.equal(Object.hasOwn(PUBLIC_VALIDATION_STATES, row.id), true, `${name} exposed non-whitelisted validation id ${row.id}`);
        assert.equal(
          PUBLIC_VALIDATION_STATES[row.id].includes(row.state),
          true,
          `${name} validation ${row.id} degenerated or exposed unmapped state "${row.state}"`
        );
      }
    }
    assert.equal(checkedRows, 20, `expected 20 validation rows across 4 public endpoints (5 per endpoint), got ${checkedRows}`);
    console.log(JSON.stringify({ ok: true, endpoints: endpoints.length, checkedRows }));
  } finally {
    await server.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

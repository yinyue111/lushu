#!/usr/bin/env node
// Local stand-in for POST /v1/systemone (https://docs.typesafe.ai/api.md) so the shadow
// pipeline can be exercised without a key. Answers are deterministic placeholders, NOT
// model judgments:
//   noul   → 0.5 unless the question id is in JEV_MOCK_NOUL (id=value,...)
//   choice → always the FIRST listed option (deliberately order-biased, so the shuffled
//            retest shows up as an order inconsistency)
//   score  → the middle level
// Usage: JEV_MOCK_PORT=5499 node scripts/jev/mock-server.mjs
//        JEV_SHADOW_ENABLED=true TYPESAFE_API_KEY=mock JEV_API_URL=http://127.0.0.1:5499/v1/systemone npm start
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

function parseNoulOverrides(raw) {
  return Object.fromEntries(
    String(raw ?? '')
      .split(',')
      .map((pair) => pair.split('='))
      .filter(([key, value]) => key && Number.isFinite(Number(value)))
      .map(([key, value]) => [key.trim(), Number(value)])
  );
}

export function mockAnswer(id, question, noulOverrides = {}) {
  if (question?.type === 'noul') return { type: 'noul', noul: noulOverrides[id] ?? 0.5 };
  if (question?.type === 'choice') {
    const options = Object.keys(question.criteria ?? {});
    const probabilities = Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0]));
    return { type: 'choice', choice: options[0] ?? null, probabilities, confidence: 1 };
  }
  if (question?.type === 'score') {
    const levels = Array.isArray(question.criteria) ? question.criteria : [];
    const middle = Math.floor((levels.length - 1) / 2);
    return {
      type: 'score',
      score: middle,
      legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
      probabilities: Object.fromEntries(levels.map((_, index) => [String(index), index === middle ? 1 : 0])),
      confidence: 1
    };
  }
  return null;
}

/** @param {{ apiKey?: string, noulOverrides?: Record<string, number>, delayMs?: number, status?: number }} [options] */
export function createJevMockServer(options = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(404, { error: 'not found' });
    if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) return send(401, { error: 'invalid api key' });
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(422, { error: 'invalid json' });
      }
      if (body?.state == null || !body?.model || typeof body?.questions !== 'object') return send(422, { error: 'state, model and questions are required' });
      requests.push(body);
      const respond = () => {
        if (options.status) return send(options.status, { error: 'mock error' });
        const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, mockAnswer(id, question, options.noulOverrides)]));
        send(200, { model: 'jev-mock', answers, usage: { input_tokens: 0, output_tokens: 0 } });
      };
      if (options.delayMs) setTimeout(respond, options.delayMs);
      else respond();
    });
  });
  return { server, requests };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.JEV_MOCK_PORT ?? 5499);
  const { server } = createJevMockServer({ apiKey: process.env.JEV_MOCK_API_KEY || undefined, noulOverrides: parseNoulOverrides(process.env.JEV_MOCK_NOUL) });
  server.listen(port, '127.0.0.1', () => console.log(`Jev mock listening on http://127.0.0.1:${port}/v1/systemone`));
}

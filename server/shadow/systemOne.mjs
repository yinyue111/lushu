// Minimal TypeSafe System One client (https://docs.typesafe.ai/api.md):
//   POST {state, model, questions} → {model, answers: {id: {type, noul|choice|score, ...}}, usage}
// Returns null on any failure (timeout, HTTP error, malformed body); callers are shadow
// hooks that must never block or alter the product flow.
import { JEV_API_URL, JEV_MODEL, JEV_SHADOW_TIMEOUT_MS, TYPESAFE_API_KEY } from '../config/index.mjs';

/**
 * @param {{ state: any, questions: Record<string, any> }} request
 * @param {{ apiKey?: string, url?: string, model?: string, timeoutMs?: number, fetchImpl?: any }} [options]
 */
export async function callSystemOne(request, options = {}) {
  const apiKey = options.apiKey ?? TYPESAFE_API_KEY;
  if (!apiKey) return { ok: false, error: 'no-api-key' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? JEV_SHADOW_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(options.url ?? JEV_API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state: request.state, model: options.model ?? JEV_MODEL, questions: request.questions }),
      signal: controller.signal
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, error: `http-${response.status}`, latencyMs };
    const data = await response.json();
    if (!data || typeof data.answers !== 'object' || data.answers === null) return { ok: false, error: 'malformed-response', latencyMs };
    return { ok: true, model: String(data.model ?? ''), answers: data.answers, usage: data.usage ?? null, latencyMs };
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? 'timeout' : 'network', latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

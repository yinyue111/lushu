// Shadow-mode runner. scheduleShadowJudgment() returns immediately; the Jev calls run in
// the background, results go to the shadow-judgments stream, and nothing the product does
// depends on them. Disabled unless JEV_SHADOW_ENABLED=true and TYPESAFE_API_KEY is set.
import { createHash } from 'node:crypto';
import { JEV_SHADOW_ENABLED, JEV_SHADOW_MAX_IN_FLIGHT, JEV_SHADOW_SAMPLE_RATE, SHADOW_JUDGMENT_LOG_PATH, TYPESAFE_API_KEY } from '../config/index.mjs';
import { appendJsonLine, readJsonLines } from '../storage/jsonl.mjs';
import { cryptoRandomId } from '../auth/tokens.mjs';
import { callSystemOne } from './systemOne.mjs';
import { assertNoPersonalData } from './privacy.mjs';
import { SHADOW_TASKS, summarizeShadowJudgments } from './tasks.mjs';

let inFlight = 0;
const pending = new Set();
let overrides = null;

/** Test hook: { enabled, client, sampleRate, random } */
export function setShadowOverridesForTests(next) {
  overrides = next;
}

export function shadowModeEnabled() {
  return overrides?.enabled ?? (JEV_SHADOW_ENABLED && Boolean(TYPESAFE_API_KEY));
}

/** Resolves when all background judgments started so far have been written (tests, shutdown). */
export async function drainShadowJudgments() {
  await Promise.allSettled([...pending]);
}

async function runJudgment(taskName, input) {
  const task = SHADOW_TASKS[taskName];
  const request = task.build(input);
  const createdAt = new Date().toISOString();
  const base = {
    id: cryptoRandomId(),
    type: 'shadow-judgment',
    task: taskName,
    createdAt,
    stateDigest: createHash('sha256').update(JSON.stringify(request.state)).digest('hex').slice(0, 24),
    ruleDecision: request.ruleDecision ?? null
  };
  try {
    assertNoPersonalData(request.state);
    if (request.shuffledState) assertNoPersonalData(request.shuffledState);
  } catch (error) {
    await appendJsonLine(SHADOW_JUDGMENT_LOG_PATH, { ...base, ok: false, error: 'blocked-personal-data', detail: String(error.message).slice(0, 120) });
    return;
  }
  const client = overrides?.client ?? callSystemOne;
  const primary = await client({ state: request.state, questions: request.questions });
  const needsShuffle = request.shuffledQuestions || request.shuffledState;
  const shuffled =
    primary.ok && needsShuffle
      ? await client({ state: request.shuffledState ?? request.state, questions: { ...request.questions, ...(request.shuffledQuestions ?? {}) } })
      : null;
  if (!primary.ok) {
    await appendJsonLine(SHADOW_JUDGMENT_LOG_PATH, { ...base, ok: false, error: primary.error, latencyMs: primary.latencyMs ?? null });
    return;
  }
  const jevDecision = task.decide(primary.answers);
  const orderA = task.orderKey.call(task, primary.answers);
  const orderB = shuffled?.ok ? task.orderKey.call(task, shuffled.answers) : null;
  await appendJsonLine(SHADOW_JUDGMENT_LOG_PATH, {
    ...base,
    ok: true,
    model: primary.model,
    // State is public, non-personal data (checked above); kept so judgments can be labelled.
    state: request.state,
    answers: primary.answers,
    shuffledAnswers: shuffled?.ok ? shuffled.answers : null,
    jevDecision,
    agreement: base.ruleDecision == null || jevDecision == null ? null : base.ruleDecision === jevDecision,
    orderConsistent: orderA == null || orderB == null ? null : orderA === orderB,
    latencyMs: primary.latencyMs ?? null,
    usage: primary.usage ?? null
  });
}

/**
 * Fire-and-forget. Never throws, never awaits the model on the caller's path.
 * @returns {'disabled' | 'sampled-out' | 'busy' | 'scheduled'}
 */
export function scheduleShadowJudgment(taskName, input) {
  try {
    if (!shadowModeEnabled() || !SHADOW_TASKS[taskName]) return 'disabled';
    const sampleRate = overrides?.sampleRate ?? JEV_SHADOW_SAMPLE_RATE;
    if ((overrides?.random ?? Math.random)() >= sampleRate) return 'sampled-out';
    if (inFlight >= JEV_SHADOW_MAX_IN_FLIGHT) return 'busy';
    inFlight += 1;
    const job = new Promise((resolve) => setImmediate(resolve))
      .then(() => runJudgment(taskName, input))
      .catch(() => {})
      .finally(() => {
        inFlight -= 1;
        pending.delete(job);
      });
    pending.add(job);
    return 'scheduled';
  } catch {
    return 'disabled';
  }
}

export async function shadowAgreementSummary() {
  const rows = await readJsonLines(SHADOW_JUDGMENT_LOG_PATH, Number.POSITIVE_INFINITY);
  return { enabled: shadowModeEnabled(), tasks: summarizeShadowJudgments(rows), rowCount: rows.length };
}

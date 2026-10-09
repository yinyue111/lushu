#!/usr/bin/env node
// Scores Jev answers against human labels from the labeling kit.
//   node scripts/jev/eval-labels.mjs --labels eval/jev-labeling/samples.jsonl --answers answers.jsonl
//   node scripts/jev/eval-labels.mjs --labels ... --run --url http://127.0.0.1:5499/v1/systemone
// --answers: JSONL of {id, answers, shuffledAnswers?} (e.g. exported from a pilot run).
// --run:     asks the endpoint for every labeled item. Requires an explicit --url; the key
//            comes from TYPESAFE_API_KEY (use any value for the local mock). Only the item
//            `state` (public, PII-checked) is sent. Items with label=null are never sent.
// Unlabeled items are counted, never scored.
import { readFileSync, writeFileSync } from 'node:fs';
import { SHADOW_TASKS } from '../../server/shadow/tasks.mjs';
import { assertNoPersonalData } from '../../server/shadow/privacy.mjs';
import { callSystemOne } from '../../server/shadow/systemOne.mjs';

const LINK_STATE_DECISION = ['different', 'unsure', 'same'];

/** Maps a human label to the decision vocabulary used by SHADOW_TASKS[task].decide. */
export function labelDecision(task, label) {
  if (!label) return null;
  if (task === 'import-gate') return typeof label.usable === 'boolean' ? (label.usable ? 'usable' : 'not-usable') : null;
  if (task === 'poi-duplicate') return LINK_STATE_DECISION[label.link_state] ?? null;
  if (task === 'geocode-choice') return typeof label.pick === 'string' ? label.pick : null;
  return null;
}

export function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** @param {any[]} items @param {Map<string, any>} answersById */
export function scoreLabels(items, answersById) {
  const report = {};
  for (const item of items) {
    const task = SHADOW_TASKS[item.task];
    if (!task) continue;
    const entry = (report[item.task] ??= {
      items: 0,
      unlabeled: 0,
      labeled: 0,
      answered: 0,
      correct: 0,
      accuracy: null,
      orderChecked: 0,
      orderConsistent: 0,
      orderConsistency: null,
      confusion: {}
    });
    entry.items += 1;
    const expected = labelDecision(item.task, item.label);
    if (expected == null) {
      entry.unlabeled += 1;
      continue;
    }
    entry.labeled += 1;
    const answer = answersById.get(item.id);
    const actual = answer?.answers ? task.decide(answer.answers) : null;
    if (actual == null) continue;
    entry.answered += 1;
    if (actual === expected) entry.correct += 1;
    const key = `${expected}→${actual}`;
    entry.confusion[key] = (entry.confusion[key] ?? 0) + 1;
    if (answer.shuffledAnswers) {
      entry.orderChecked += 1;
      if (task.orderKey.call(task, answer.answers) === task.orderKey.call(task, answer.shuffledAnswers)) entry.orderConsistent += 1;
    }
  }
  for (const entry of Object.values(report)) {
    entry.accuracy = entry.answered ? Math.round((entry.correct / entry.answered) * 1000) / 10 : null;
    entry.orderConsistency = entry.orderChecked ? Math.round((entry.orderConsistent / entry.orderChecked) * 1000) / 10 : null;
  }
  return report;
}

async function runItems(items, url) {
  const answers = new Map();
  for (const item of items) {
    if (labelDecision(item.task, item.label) == null || !item.request) continue;
    assertNoPersonalData(item.state);
    const primary = await callSystemOne({ state: item.state, questions: item.request.questions }, { url, timeoutMs: 10000 });
    if (!primary.ok) {
      answers.set(item.id, { id: item.id, error: primary.error });
      continue;
    }
    let shuffledAnswers = null;
    if (item.request.shuffledQuestions || item.request.shuffledState) {
      const shuffled = await callSystemOne(
        { state: item.request.shuffledState ?? item.state, questions: { ...item.request.questions, ...(item.request.shuffledQuestions ?? {}) } },
        { url, timeoutMs: 10000 }
      );
      shuffledAnswers = shuffled.ok ? shuffled.answers : null;
    }
    answers.set(item.id, { id: item.id, answers: primary.answers, shuffledAnswers });
  }
  return answers;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const labelsFile = option('--labels') ?? 'eval/jev-labeling/samples.jsonl';
  const items = readJsonl(labelsFile);
  let answersById = new Map();
  if (args.includes('--run')) {
    const url = option('--url');
    if (!url) {
      console.error('--run needs an explicit --url (use the mock: scripts/jev/mock-server.mjs)');
      process.exit(2);
    }
    answersById = await runItems(items, url);
    const out = option('--save-answers');
    if (out) writeFileSync(out, [...answersById.values()].map((row) => JSON.stringify(row)).join('\n') + '\n');
  } else if (option('--answers')) {
    answersById = new Map(readJsonl(option('--answers')).map((row) => [row.id, row]));
  }
  console.log(JSON.stringify(scoreLabels(items, answersById), null, 2));
}

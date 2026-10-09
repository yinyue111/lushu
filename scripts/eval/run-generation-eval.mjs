#!/usr/bin/env node
// Generation quality regression skeleton. Run after every prompt or model change.
//   node scripts/eval/run-generation-eval.mjs                       # mock runner (default, offline)
//   node scripts/eval/run-generation-eval.mjs --runner http --url http://127.0.0.1:5401
//     (http runner calls POST /api/generate-routebook on a running server; it uses
//      ROUTEBOOK_API_TOKEN from the environment and costs real model tokens)
// Cases: eval/generation/cases.jsonl — city, constraints, expectations. Cases name only
// POIs that exist in the seed catalog; they state no hours or prices.
// Checks are deterministic and reuse product validators:
//   must-go / avoid (buildConstraintValidation), day count vs. expectation, stop count bounds,
//   every stop has an in-city coordinate (coordinateDistanceWarning).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildConstraintValidation } from '../../server/routebooks/normalize.mjs';
import { coordinateDistanceWarning } from '../../server/geo/coordinates.mjs';
import { seedPoiCatalog } from '../../server/poi/catalog.mjs';

export function readCases(file = 'eval/generation/cases.jsonl') {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * Deterministic stand-in for the model: seed POIs of the city, must-go first, avoid removed,
 * split over the expected days. It exercises the scoring path, not model quality.
 */
export function mockRunner(evalCase) {
  const terms = (value) =>
    String(value ?? '')
      .split(/[、，,;；\s]+/)
      .filter(Boolean);
  const mustGo = terms(evalCase.constraints?.mustGo);
  const avoid = terms(evalCase.constraints?.avoid);
  const pois = seedPoiCatalog().filter((poi) => poi.city === evalCase.city);
  const matches = (poi, term) => poi.name === term || poi.aliases.includes(term);
  const ordered = [...pois.filter((poi) => mustGo.some((term) => matches(poi, term))), ...pois.filter((poi) => !mustGo.some((term) => matches(poi, term)))]
    .filter((poi) => !avoid.some((term) => matches(poi, term)))
    .slice(0, Math.max(evalCase.expect?.minStops ?? 2, Math.min(4 * (evalCase.expect?.days ?? 1), pois.length)));
  const days = evalCase.expect?.days ?? 1;
  const stops = ordered.map((poi, index) => ({
    id: `s${index + 1}`,
    day: `Day ${Math.min(days, Math.floor((index * days) / ordered.length) + 1)}`,
    name: poi.name,
    aliases: poi.aliases,
    lat: poi.lat,
    lng: poi.lng
  }));
  return { city: evalCase.city, stops };
}

/** @param {{ url: string, token?: string }} options */
export function httpRunner({ url, token = process.env.ROUTEBOOK_API_TOKEN ?? '' }) {
  return async (evalCase) => {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/generate-routebook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-routebook-token': token } : {}) },
      body: JSON.stringify({ city: evalCase.city, constraints: evalCase.constraints, guide: evalCase.guide ?? '' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data?.code ?? data?.error ?? ''}`);
    return data.routebook;
  };
}

export function scoreRoutebook(evalCase, routebook) {
  const stops = Array.isArray(routebook?.stops) ? routebook.stops : [];
  const checks = [];
  const constraint = buildConstraintValidation(stops, evalCase.constraints ?? {}, evalCase.city);
  if (constraint.state !== '未设置') checks.push({ id: 'must-go-avoid', pass: constraint.state === '已纳入', detail: constraint.detail });
  const dayCount = new Set(stops.map((stop) => String(stop.day ?? ''))).size;
  if (evalCase.expect?.days) checks.push({ id: 'day-count', pass: dayCount === evalCase.expect.days, detail: `${dayCount}/${evalCase.expect.days}` });
  const { minStops = 1, maxStops = 30 } = evalCase.expect ?? {};
  checks.push({ id: 'stop-count', pass: stops.length >= minStops && stops.length <= maxStops, detail: String(stops.length) });
  const offCity = stops.filter((stop) => !Number.isFinite(Number(stop.lat)) || coordinateDistanceWarning(Number(stop.lat), Number(stop.lng), evalCase.city));
  checks.push({ id: 'in-city-coordinates', pass: stops.length > 0 && offCity.length === 0, detail: offCity.map((stop) => stop.name).join('、') });
  return { id: evalCase.id, pass: checks.every((check) => check.pass), checks };
}

export async function runGenerationEval(cases, runner) {
  const results = [];
  for (const evalCase of cases) {
    try {
      results.push(scoreRoutebook(evalCase, await runner(evalCase)));
    } catch (error) {
      results.push({ id: evalCase.id, pass: false, error: String(error?.message ?? error).slice(0, 200), checks: [] });
    }
  }
  const passed = results.filter((result) => result.pass).length;
  return { total: results.length, passed, passRate: results.length ? Math.round((passed / results.length) * 1000) / 10 : null, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const runnerName = option('--runner') ?? 'mock';
  /** @type {(evalCase: any) => any} */
  let runner = mockRunner;
  if (runnerName === 'http') {
    const url = option('--url');
    if (!url) {
      console.error('--runner http needs --url');
      process.exit(2);
    }
    runner = httpRunner({ url });
  }
  const report = await runGenerationEval(readCases(option('--cases')), runner);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed === report.total ? 0 : 1);
}

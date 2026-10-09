#!/usr/bin/env node
// Builds the Jev pilot labeling kit (docs/jev-pilot.md) as JSONL, one item per line.
// Sources, and nothing else:
//   - seed-catalog: POI names/aliases/cities that already exist in server/poi/catalog.mjs
//   - synthetic:    template text with NO facts (no hours, prices, addresses, ratings).
//                   Useful for exercising the pipeline and for shell-page / city checks;
//                   never cite accuracy on synthetic items as real-world accuracy.
// Every `label` is null: labels are filled in by human annotators, never by this script.
// Usage: node scripts/jev/build-labeling-kit.mjs [out.jsonl]   (default: eval/jev-labeling/samples.jsonl)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { seedPoiCatalog } from '../../server/poi/catalog.mjs';
import { distanceMeters } from '../../server/lib/util.mjs';
import { SHADOW_TASKS } from '../../server/shadow/tasks.mjs';

export function buildLabelingKit() {
  const pois = seedPoiCatalog();
  const items = [];
  const add = (task, source, input, extra = {}) => {
    const built = SHADOW_TASKS[task].build(input);
    items.push({
      id: `${task}-${String(items.filter((item) => item.task === task).length + 1).padStart(3, '0')}`,
      task,
      source,
      synthetic: source === 'synthetic',
      state: built.state,
      request: {
        questions: built.questions,
        ...(built.shuffledQuestions ? { shuffledQuestions: built.shuffledQuestions } : {}),
        ...(built.shuffledState ? { shuffledState: built.shuffledState } : {})
      },
      ...extra,
      label: null
    });
  };

  // 1) POI duplicate: every same-city seed pair, plus each seed name vs. its own alias
  //    presented as a separate entity. `repoRelation` records what the repo says; it is a
  //    hint for reviewers, not a label.
  const byCity = new Map();
  for (const poi of pois) byCity.set(poi.city, [...(byCity.get(poi.city) ?? []), poi]);
  for (const cityPois of byCity.values()) {
    for (let i = 0; i < cityPois.length; i += 1) {
      for (let j = i + 1; j < cityPois.length; j += 1) {
        const [a, b] = [cityPois[i], cityPois[j]];
        add('poi-duplicate', 'seed-catalog', { a, b, distanceMeters: Math.round(distanceMeters(a, b)) }, { repoRelation: 'distinct-seed-entries' });
      }
    }
  }
  for (const poi of pois) {
    for (const alias of poi.aliases) {
      add(
        'poi-duplicate',
        'seed-catalog',
        { a: { ...poi, aliases: [] }, b: { name: alias, city: poi.city, aliases: [] }, distanceMeters: null },
        { repoRelation: 'listed-as-alias' }
      );
      // Same pair in the opposite order (order-bias check on annotated data).
      add(
        'poi-duplicate',
        'seed-catalog',
        { a: { name: alias, city: poi.city, aliases: [] }, b: { ...poi, aliases: [] }, distanceMeters: null },
        { repoRelation: 'listed-as-alias' }
      );
    }
  }

  // 2) Geocode choice: stop names from the seed catalog. Candidates must be collected from
  //    AMap (or the shadow log) before annotation — we do not invent candidate lists.
  for (const poi of pois) {
    for (const stopName of [poi.name, ...poi.aliases]) {
      items.push({
        id: `geocode-choice-${String(items.filter((item) => item.task === 'geocode-choice').length + 1).padStart(3, '0')}`,
        task: 'geocode-choice',
        source: 'seed-catalog',
        synthetic: false,
        state: { stop_name: stopName, city: poi.city },
        candidates: null,
        request: null,
        needsData: 'AMap /v3/place/text 候选（运行试点时从 shadow-judgments 日志或采集脚本补齐）',
        label: null
      });
    }
  }

  // 3) Import gate: synthetic, fact-free texts.
  const shellTexts = [
    '打开App查看完整内容',
    '登录后查看更多精彩内容',
    '请完成安全验证后继续访问',
    '你访问的页面不存在或已被删除',
    '内容加载失败，请稍后重试',
    '该内容仅对关注者可见',
    '扫码下载客户端，查看高清原图',
    '当前网络不可用，请检查网络设置',
    '笔记已被作者设为私密',
    '视频正在审核中',
    '请在微信客户端打开链接',
    '账号异常，请重新登录'
  ];
  const commercialTails = ['本文为合作推广。', '下单链接见评论区。', '团购入口在主页。'];
  const cities = [...byCity.keys()];
  for (const text of shellTexts) {
    for (const city of cities) {
      add('import-gate', 'synthetic', { source: { platform: '网页', title: '', description: '', excerpt: text }, city });
    }
  }
  for (const [city, cityPois] of byCity) {
    for (let i = 0; i < cityPois.length; i += 1) {
      const a = cityPois[i];
      const b = cityPois[(i + 1) % cityPois.length];
      const c = cityPois[(i + 2) % cityPois.length];
      const route = `第一站${a.name}，然后去${b.name}，最后到${c.name}。`;
      add('import-gate', 'synthetic', { source: { platform: '网页', title: `${city}一日路线`, excerpt: route }, city });
      add('import-gate', 'synthetic', { source: { platform: '网页', title: `${a.name}`, excerpt: `${a.name}` }, city });
      add('import-gate', 'synthetic', {
        source: { platform: '网页', title: `${city}路线`, excerpt: `${route}${commercialTails[i % commercialTails.length]}` },
        city
      });
      add('import-gate', 'synthetic', { source: { platform: '网页', title: '周末去哪', excerpt: `想去${a.name}和${b.name}，有没有人一起？` }, city });
      for (const other of cities.filter((name) => name !== city)) {
        add('import-gate', 'synthetic', { source: { platform: '网页', title: `${city}路线`, excerpt: route }, city: other });
      }
      add('import-gate', 'synthetic', { source: { platform: '网页', title: '路线', excerpt: route }, city: '' });
      add('import-gate', 'synthetic', { source: { platform: '网页', title: `${city}打卡清单`, excerpt: `${a.name}、${b.name}、${c.name}` }, city });
      add('import-gate', 'synthetic', { source: { platform: '网页', title: '求推荐', excerpt: `${a.name}附近还有什么值得去的？` }, city });
      add('import-gate', 'synthetic', {
        source: { platform: '网页', title: '两日路线', excerpt: `Day 1：${a.name}、${b.name}。Day 2：${c.name}。` },
        city
      });
    }
  }
  // Multi-city: one stop from each city.
  for (let i = 0; i < 10; i += 1) {
    const picks = cities.map((city) => byCity.get(city)[i % byCity.get(city).length].name);
    add('import-gate', 'synthetic', {
      source: { platform: '网页', title: '三城路线', excerpt: `先去${picks.join('，再去')}。` },
      city: cities[i % cities.length]
    });
  }
  return items;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = resolve(process.argv[2] || 'eval/jev-labeling/samples.jsonl');
  const items = buildLabelingKit();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, items.map((item) => JSON.stringify(item)).join('\n') + '\n');
  const counts = items.reduce((acc, item) => ({ ...acc, [item.task]: (acc[item.task] ?? 0) + 1 }), {});
  console.log(`wrote ${items.length} items to ${out}`, counts);
}

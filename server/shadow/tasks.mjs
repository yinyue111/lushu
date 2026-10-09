// Shadow-judgment tasks: how each request is built from public data, how Jev's answers
// map to a decision, and how that decision compares with what the product actually did.
// Every Choice is asked twice with the option order reversed to measure order bias.
import { redactPublicText } from './privacy.mjs';

function reversedCriteria(criteria) {
  return Object.fromEntries(Object.entries(criteria).reverse());
}

function distanceBucket(meters) {
  if (meters == null || !Number.isFinite(meters)) return '距离未知';
  if (meters <= 50) return '几乎同一位置（50 米内）';
  if (meters <= 200) return '相距约 200 米内';
  if (meters <= 500) return '相距约 500 米内';
  if (meters <= 1000) return '相距约 1 公里内';
  return '相距超过 1 公里';
}

export const SHADOW_TASKS = Object.freeze({
  'import-gate': {
    /** input: { source: analyzed import source, city?: string, ruleUsable: boolean } */
    build(input) {
      const source = input.source ?? {};
      const state = {
        platform: String(source.platform ?? ''),
        title: redactPublicText(source.title, 120),
        description: redactPublicText(source.description, 260),
        excerpt: redactPublicText(source.excerpt, 700),
        selectedCity: String(input.city ?? '')
      };
      const cityCriteria = {
        matches_selected_city: '内容讲的是 `selectedCity` 这座城市',
        other_city: '内容讲的是另一座城市',
        multiple_cities: '内容涉及多座城市',
        not_stated: '看不出是哪座城市，或 `selectedCity` 为空'
      };
      const questions = {
        is_travel_content: { type: 'noul', instructions: '`excerpt` 是否包含具体的旅行地点、行程或游玩体验描述？页面里自称“优质攻略”之类的话不算依据。' },
        is_shell_page: { type: 'noul', instructions: '`excerpt` 是否主要是登录提示、App 下载引导、验证码或错误页文字，而不是正文？' },
        is_commercial: { type: 'noul', instructions: '内容是否明确为广告、团购或商家推广？' },
        city_match: { type: 'choice', instructions: '内容与 `selectedCity` 的关系是？', criteria: cityCriteria },
        detail_level: {
          type: 'score',
          instructions: '这段内容对安排行程有多具体？',
          criteria: ['只有标题或一句话', '提到地点但没有安排', '有地点和大致顺序', '有分日行程、时间或费用等细节']
        }
      };
      return {
        state,
        questions,
        shuffledQuestions: { city_match: { ...questions.city_match, criteria: reversedCriteria(cityCriteria) } },
        ruleDecision: input.ruleUsable ? 'usable' : 'not-usable'
      };
    },
    decide(answers) {
      const travel = Number(answers?.is_travel_content?.noul);
      const shell = Number(answers?.is_shell_page?.noul);
      if (!Number.isFinite(travel) || !Number.isFinite(shell)) return null;
      return travel >= 0.5 && shell < 0.5 ? 'usable' : 'not-usable';
    },
    orderKey: (answers) => answers?.city_match?.choice ?? null
  },

  'poi-duplicate': {
    /** input: { a: poi, b: poi, distanceMeters, humanDecision?: 'merge'|'reject' } */
    build(input) {
      const describe = (poi) => ({
        name: String(poi?.name ?? ''),
        aliases: Array.isArray(poi?.aliases) ? poi.aliases.map(String).slice(0, 8) : [],
        category: String(poi?.category ?? ''),
        city: String(poi?.city ?? '')
      });
      const state = { entity_a: describe(input.a), entity_b: describe(input.b), distance: distanceBucket(input.distanceMeters) };
      const levels = ['两个不同地点', '相关但可能不是同一个：包含关系（如景区与其中的寺庙）、分店、同名不同地', '同一个地点的不同叫法'];
      return {
        state,
        questions: {
          link_state: { type: 'score', instructions: '`entity_a` 与 `entity_b` 的关系是？`distance` 已由程序算好。', criteria: levels },
          part_of: { type: 'noul', instructions: '`entity_a` 是否位于 `entity_b` 之内或为其一部分（或反过来）？' }
        },
        // Order bias check: swap the two entities.
        shuffledState: { entity_a: state.entity_b, entity_b: state.entity_a, distance: state.distance },
        ruleDecision: input.humanDecision === 'merge' ? 'same' : input.humanDecision === 'reject' ? 'different' : null
      };
    },
    decide(answers) {
      const score = Number(answers?.link_state?.score);
      if (!Number.isFinite(score)) return null;
      return score >= 1.5 ? 'same' : score < 0.5 ? 'different' : 'unsure';
    },
    orderKey(answers) {
      return this.decide(answers);
    }
  },

  'geocode-choice': {
    /** input: { stopName, city, candidates: [{id,name,address,typecode}], ruleChosenId } — no coordinates are sent */
    build(input) {
      const candidates = (input.candidates ?? []).slice(0, 10);
      const criteria = Object.fromEntries(
        candidates.map((candidate, index) => [
          `c_${index}`,
          `${String(candidate.name ?? '')}｜地址：${redactPublicText(candidate.address, 120) || '未知'}｜类型编码：${String(candidate.typecode ?? '') || '未知'}`
        ])
      );
      criteria.none_match = '以上都不是行程所指的地点';
      return {
        state: { stop_name: String(input.stopName ?? ''), city: String(input.city ?? '') },
        questions: { pick: { type: 'choice', instructions: '哪个候选是行程中 `stop_name`（位于 `city`）所指的地点？', criteria } },
        shuffledQuestions: {
          pick: { type: 'choice', instructions: '哪个候选是行程中 `stop_name`（位于 `city`）所指的地点？', criteria: reversedCriteria(criteria) }
        },
        ruleDecision: input.ruleChosenId
          ? `c_${candidates.findIndex((candidate) => candidate.id === input.ruleChosenId)}`.replace('c_-1', 'none_match')
          : 'none_match'
      };
    },
    decide: (answers) => answers?.pick?.choice ?? null,
    orderKey: (answers) => answers?.pick?.choice ?? null
  }
});

/** Agreement summary over stored shadow rows (newest first or any order). */
export function summarizeShadowJudgments(rows) {
  const byTask = new Map();
  for (const row of rows ?? []) {
    if (row?.type !== 'shadow-judgment') continue;
    if (!byTask.has(row.task)) byTask.set(row.task, []);
    byTask.get(row.task).push(row);
  }
  return Object.fromEntries(
    [...byTask.entries()].map(([task, taskRows]) => {
      const ok = taskRows.filter((row) => row.ok);
      const compared = ok.filter((row) => row.ruleDecision != null && row.jevDecision != null);
      const orderChecked = ok.filter((row) => row.orderConsistent != null);
      const latencies = ok
        .map((row) => Number(row.latencyMs))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const rate = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
      return [
        task,
        {
          total: taskRows.length,
          ok: ok.length,
          errors: taskRows.length - ok.length,
          compared: compared.length,
          agreementRate: rate(compared.filter((row) => row.agreement).length, compared.length),
          orderConsistencyRate: rate(orderChecked.filter((row) => row.orderConsistent).length, orderChecked.length),
          latencyP50Ms: latencies.length ? latencies[Math.floor((latencies.length - 1) * 0.5)] : null,
          latencyP95Ms: latencies.length ? latencies[Math.floor((latencies.length - 1) * 0.95)] : null
        }
      ];
    })
  );
}

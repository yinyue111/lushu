// Shipped official per-token unit prices for the models this app actually uses (细品 = Grok, 轻快 = Gemini Flash).
// Units: USD per 1M tokens — matches model.pricing / docs/admin.md. Never invent a missing price as 0.
// Relayed via t.aiwuq.cn; relay billing may differ from these first-party list prices.
// Retrieved 2026-10-16 from the first-party pages linked in each entry's `source`.
//
// Field mapping for ops reconciliation (see docs/admin.md 「模型单价」):
//   input  ← official Input / 1M (standard, short-context / non-cached rate)
//   output ← official Output / 1M (reasoning / thinking tokens bill as output — see docs)
// Cached-input and long-context (>200k) tiers are NOT separate fields here; estimates therefore
// overstate cost when the provider serves cached input, and understate if a prompt ever exceeds the
// long-context threshold (routebook prompts are well below 200k).

/** @type {Record<string, { input: number, output: number, source: string, asOf: string }>} */
export const DEFAULT_MODEL_PRICING = {
  // Official id `grok-4.7`, <200k prompt tier. Source: https://docs.x.ai/developers/pricing
  // Quoted 2026-10-16: "grok-4.7 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00"
  // Reasoning: docs.x.ai reasoning page — "the reasoning tokens are billed as part of your total
  // consumption"; usage exposes them under output_tokens_details.reasoning_tokens → bill as output.
  'grok-4.7': {
    input: 2,
    output: 6,
    source: 'https://docs.x.ai/developers/pricing',
    asOf: '2026-10-16'
  },
  // App / relay id `gemini-3.8-flash-high` (-high = thinking tier suffix on the relay). Official
  // Gemini API id is `gemini-3.8-flash` Standard paid tier through 2026-12-31.
  // Source: https://ai.google.dev/pricing — Quoted 2026-10-16:
  //   "Input price … $0.75 through December 31, 2026"
  //   "Output price (including thinking tokens) … $3.75 through December 31, 2026"
  //   "Context caching price … $0.075 through December 31, 2026" (not modeled in input/output fields)
  'gemini-3.8-flash-high': {
    input: 0.75,
    output: 3.75,
    source: 'https://ai.google.dev/pricing',
    asOf: '2026-10-16'
  }
};

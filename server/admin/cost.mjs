// Per-model pricing from the runtime config (admin enters prices from the provider's bill; nothing is
// assumed). Returns the env-shaped pricing object estimateModelCost() understands, or the env pricing
// (AI_INPUT/OUTPUT_COST_PER_MILLION_TOKENS) when the model has no admin price. No price → cost "unavailable".
import { getConfig } from '../config/runtime.mjs';

export function modelPricingFor(model) {
  const price = getConfig('model.pricing')?.[String(model ?? '')];
  if (!price) return process.env;
  return { AI_COST_CURRENCY: 'USD', AI_INPUT_COST_PER_MILLION_TOKENS: String(price.input), AI_OUTPUT_COST_PER_MILLION_TOKENS: String(price.output) };
}

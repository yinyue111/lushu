// Per-model pricing from the runtime config (admin enters prices from the provider's bill; nothing is
// assumed). Returns the env-shaped pricing object estimateModelCost() understands, or the env pricing
// (AI_INPUT/OUTPUT_COST_PER_MILLION_TOKENS) when the model has no admin price. No price → cost "unavailable".
import { getConfig } from '../config/runtime.mjs';

export function modelPricingFor(model) {
  const price = getConfig('model.pricing')?.[String(model ?? '')];
  if (!price) return process.env;
  return { AI_COST_CURRENCY: 'USD', AI_INPUT_COST_PER_MILLION_TOKENS: String(price.input), AI_OUTPUT_COST_PER_MILLION_TOKENS: String(price.output) };
}

const envPriced = () =>
  Boolean(process.env.AI_COST_CURRENCY) &&
  [process.env.AI_INPUT_COST_PER_MILLION_TOKENS, process.env.AI_OUTPUT_COST_PER_MILLION_TOKENS].every(
    (v) => v != null && v !== '' && Number.isFinite(Number(v))
  );

/** True when calls to this model get a cost estimate (admin price or complete env price). */
export function modelHasPrice(model) {
  return Boolean(getConfig('model.pricing')?.[String(model ?? '')]) || envPriced();
}

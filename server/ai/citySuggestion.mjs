// V-U27: the routebook city is the one the user picked (often the home page default 「杭州」).
// When the model clearly placed the guide in another city, we keep the user's city and only
// carry a suggestion; the UI asks before changing anything.
const CITY_PATTERN = /^[\p{Script=Han}A-Za-z0-9·.\-\s]+$/u;

function clean(value) {
  return String(value ?? '')
    .trim()
    .slice(0, 40)
    .replace(/市$/u, '');
}

/** Returns the model's city when it differs from the chosen one, else null. Never throws. */
export function suggestedCityFor(chosenCity, modelCity) {
  const chosen = clean(chosenCity);
  const model = clean(modelCity);
  if (!model || !CITY_PATTERN.test(model)) return null;
  if (!chosen) return null;
  if (model === chosen || model.includes(chosen) || chosen.includes(model)) return null;
  return model;
}

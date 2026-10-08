export function averageSourcePrediction(sources) {
  if (!sources.length) return 0;
  const scores = sources.map(sourcePredictionValue).filter((score) => score != null);
  return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
}

export function sourcePredictionValue(source) {
  const value = source?.predictionScore ?? source?.trustScore;
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}

/** Visual tone for a source prediction score: sky (>=70 or unknown), warn (45-69), bad (<45). */
export function sourcePredictionTone(score) {
  if (score == null || score >= 70) return 'sky';
  return score >= 45 ? 'warn' : 'bad';
}

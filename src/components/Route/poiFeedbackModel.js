// Real check-in aggregates shown on the POI detail ("真实人群与排队").
// Missing aggregates arrive as null; Number(null) is 0, which used to render
// "实测排队约 0 分钟 / 人均约 0 元" for places nobody had checked in at.
function measuredNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

export function buildPoiRealFeedback(stop) {
  const trust = stop?.poiTrust && typeof stop.poiTrust === 'object' ? stop.poiTrust : {};

  const rawAudience = Array.isArray(trust.audienceBreakdown) ? trust.audienceBreakdown : [];
  const audience = rawAudience
    .map((item) => ({
      label: typeof item?.label === 'string' ? item.label.trim() : '',
      count: Number.isFinite(Number(item?.count)) && Number(item.count) > 0 ? Math.round(Number(item.count)) : 0,
      share: Number(item?.share)
    }))
    .filter((item) => item.label)
    .slice(0, 4);
  const countTotal = audience.reduce((sum, item) => sum + item.count, 0);
  const audienceText = audience
    .map((item) => {
      let percent = null;
      if (Number.isFinite(item.share)) {
        percent = item.share;
      } else if (countTotal > 0) {
        percent = (item.count / countTotal) * 100;
      }
      if (!Number.isFinite(percent)) return item.label;
      return `${item.label} ${Math.max(0, Math.min(100, Math.round(percent)))}%`;
    })
    .join(' · ');
  const sampleCount = Number.isInteger(trust.sampleCount) && trust.sampleCount > 0 ? trust.sampleCount : 0;
  const feedbackCount = countTotal > 0 ? countTotal : sampleCount;

  const queueMinutes = measuredNumber(trust.queueMinutesMedian);
  const costMedian = measuredNumber(trust.costMedian);

  const crowdLabelMap = { low: '较宽松', medium: '一般', moderate: '一般', high: '拥挤', 'very-high': '非常拥挤' };
  const crowdRaw = typeof trust.crowdLevel === 'string' ? trust.crowdLevel.trim() : '';
  const crowdLabel = crowdRaw ? (crowdLabelMap[crowdRaw.toLowerCase()] ?? crowdRaw.slice(0, 12)) : '';

  const latestTimestamp = Date.parse(trust.latestFeedbackAt ?? '');
  const latestDaysAgo = Number.isFinite(latestTimestamp) ? Math.max(0, Math.floor((Date.now() - latestTimestamp) / 86400000)) : null;

  const correctionRaw = Number(trust.recentCorrectionCount);
  const correctionCount = Number.isInteger(correctionRaw) && correctionRaw > 0 ? correctionRaw : 0;

  return {
    hasData: Boolean(audienceText) || queueMinutes != null || costMedian != null || Boolean(crowdLabel) || latestDaysAgo != null,
    audienceText,
    feedbackCount,
    queueMinutes,
    costMedian,
    crowdLabel,
    latestDaysAgo,
    correctionCount
  };
}

import { TRUST_SCORE_EXPLANATION, routeEvidenceScore } from '../../lib/trustSignals';

/**
 * "可信分怎么算" with the actual numbers behind this route's evidence score.
 * Native <details> keeps it keyboard/screen-reader accessible without JS state.
 * @param {{ routebook: any }} props
 */
export default function TrustExplanation({ routebook }) {
  const computed = routeEvidenceScore(routebook?.stops ?? []);
  const breakdown = routebook?.trustMeta?.evidenceBreakdown ?? computed.breakdown;
  // Public views hide sub-threshold scores (server omits evidenceScore); only show a number the server sent.
  const score = routebook?.trustMeta?.evidenceScore ?? null;
  const origins = breakdown?.origins ?? {};
  const parts = [
    ['来自你的攻略', origins['user-guide']],
    ['来自导入来源', origins['imported-source']],
    ['手动添加', origins['user-added']],
    ['AI 补充', origins.model],
    ['来源未记录', origins.unknown]
  ].filter(([, count]) => Number(count) > 0);
  return (
    <details className="mt-8 rounded-tile bg-canvas p-4 text-meta leading-relaxed text-muted">
      <summary className="cursor-pointer font-bold text-ink-2">可信分怎么算{score != null ? `（这条路线目前 ${score} 分）` : ''}</summary>
      <p className="mt-2">{routebook?.trustMeta?.explanation || TRUST_SCORE_EXPLANATION}</p>
      {breakdown?.stopCount > 0 && (
        <ul className="mt-2 grid gap-1 pl-4">
          <li>站点来源：{parts.map(([label, count]) => `${label} ${count} 站`).join('，') || '—'}</li>
          <li>
            命中已审核 POI {breakdown.reviewedPoiCount}/{breakdown.stopCount} 站；精确定位 {breakdown.verifiedCoordinateCount}/{breakdown.stopCount} 站
          </li>
          <li>有证据且在有效期内的已审核事实：{breakdown.verifiedFactStopCount} 站</li>
        </ul>
      )}
      <p className="mt-2">模型对自己的打分不计入；AI 写的提示单独标为“AI 提示（未确认）”。</p>
    </details>
  );
}

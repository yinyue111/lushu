import { CircleCheckBig, PenLine, ShieldCheck, ThumbsUp } from 'lucide-react';
import { PUBLIC_TRUST_SAMPLE_THRESHOLD, formatVerifiedDate } from '../../lib/trust';
import { cn } from '../ui/cn';

/** Four colour tiles summarising how trustworthy the route is (direction B). */
export default function RouteStats({ routebook, trust, trustState }) {
  const feedback = routebook.feedbackSummary ?? {};
  const trial = trustState.tone === 'trial';
  const samples = trust.sampleCount;
  const aiWeight = Math.round((routebook.trustMeta?.aiWeight ?? 1) * 100);
  const feedbackWeight = Math.round((routebook.trustMeta?.feedbackWeight ?? 0) * 100);
  const corrections = Number(feedback.correctionCount) || 0;
  const version = Number(routebook.version);
  const latest = formatVerifiedDate(trust.latestVerifiedAt);

  return (
    <div
      tabIndex={0}
      className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-[1.25fr_1fr_1fr_1fr] sm:gap-3 sm:overflow-visible sm:px-0"
      aria-label="路线可信度"
      role="region"
    >
      <Tile className="min-w-[176px] bg-primary-soft text-primary-strong" icon={ShieldCheck}>
        {trustState.tone === 'verified' ? (
          <span className="num block text-display-sm leading-tight sm:text-display">
            {trust.score}
            <small className="ml-0.5 text-copy">/100</small>
          </span>
        ) : (
          <span className="block text-title-sm leading-tight font-extrabold sm:text-2xl">{trial ? '待复核' : '待验证'}</span>
        )}
        <span className="text-sm font-semibold">可信分</span>
        {trustState.tone === 'verified' ? (
          <>
            <div className="mt-2.5 flex h-2 overflow-hidden rounded-full bg-white" aria-hidden="true">
              <i className="block h-full bg-[#f6b2a6]" style={{ width: `${aiWeight}%` }} />
              <i className="block h-full bg-primary" style={{ width: `${feedbackWeight}%` }} />
            </div>
            <small className="mt-1 block text-meta text-muted">
              AI 预测 {aiWeight}% + 真实打卡 {feedbackWeight}%
            </small>
          </>
        ) : trial ? (
          <small className="mt-1 block text-meta text-muted">试运行城市，出发前请再核对</small>
        ) : (
          <>
            <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-white" aria-hidden="true">
              <i
                className="block h-full bg-primary"
                style={{ width: `${(Math.min(samples, PUBLIC_TRUST_SAMPLE_THRESHOLD) / PUBLIC_TRUST_SAMPLE_THRESHOLD) * 100}%` }}
              />
            </div>
            <small className="mt-1 block text-meta text-muted">{trust.sampleProgressText}</small>
          </>
        )}
      </Tile>
      <Tile className="bg-success-soft text-success-ink" icon={CircleCheckBig}>
        <span className="num block text-display-sm leading-tight sm:text-display">{trial ? '—' : samples}</span>
        <span className="text-sm font-semibold">人到达验证</span>
        <small className="mt-0.5 block text-meta text-muted">{samples && !trial ? `最近 ${latest}` : '还没有人打卡'}</small>
      </Tile>
      <Tile className="bg-sky-soft text-sky-ink" icon={ThumbsUp}>
        <span className="num block text-display-sm leading-tight sm:text-display">
          {samples && !trial ? `${Math.round(Number(feedback.pitfallRate) || 0)}%` : '—'}
        </span>
        <span className="text-sm font-semibold">踩坑率</span>
        <small className="mt-0.5 block text-meta text-muted">{samples && !trial ? `${Number(feedback.pitfallCount) || 0} 次踩坑反馈` : '有人走过后显示'}</small>
      </Tile>
      <Tile className="bg-lemon-soft text-lemon-ink" icon={PenLine}>
        <span className="num block text-display-sm leading-tight sm:text-display">{corrections}</span>
        <span className="text-sm font-semibold">条纠错</span>
        <small className="mt-0.5 block text-meta text-muted">{corrections && Number.isInteger(version) ? `已合并进 v${version}` : '发现不对可以纠错'}</small>
      </Tile>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Tile({ className, icon: Icon, children }) {
  return (
    <div className={cn('relative min-w-[128px] shrink-0 snap-start overflow-hidden rounded-card px-3.5 py-3 sm:px-4 sm:py-3.5', className)}>
      <Icon className="absolute top-3 right-3 size-[22px] opacity-80" aria-hidden="true" />
      {children}
    </div>
  );
}

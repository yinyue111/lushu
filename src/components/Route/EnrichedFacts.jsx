import { useState } from 'react';
import { BadgeCheck, ExternalLink } from 'lucide-react';

/**
 * 门票 / 开放时间 checked in the background against two independent sources.
 * Each line says where it came from and when; the sources can be expanded; the user can report it wrong.
 * @param {{ claims: any[], onReport?: (claim: any) => Promise<void> }} props
 */
export default function EnrichedFacts({ claims, onReport }) {
  if (!claims?.length) return null;
  return (
    <ul className="mt-1.5 flex list-none flex-col gap-1 p-0" onClick={(event) => event.stopPropagation()}>
      {claims.map((claim) => (
        <EnrichedFact key={`${claim.stopKey}-${claim.field}`} claim={claim} onReport={onReport} />
      ))}
    </ul>
  );
}

function EnrichedFact({ claim, onReport }) {
  const [state, setState] = useState('idle');
  return (
    <li className={claim.field === 'price' ? 'text-sm font-bold text-ink sm:text-copy' : 'text-meta text-ink-2 sm:text-sm'}>
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-start gap-1.5 [&::-webkit-details-marker]:hidden">
          <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-success-ink" aria-hidden="true" />
          <span>
            {claim.field === 'price' ? (
              <>
                <span className="text-success-ink">已核对门票</span>
                <span className="mx-1 text-muted">·</span>
                <span>{claim.display.replace(/^门票[：:]?/, '')}</span>
              </>
            ) : (
              claim.display
            )}
            <span className="ml-1 font-semibold text-sky-ink underline underline-offset-2">来源</span>
          </span>
        </summary>
        <div className="mt-1 ml-5 rounded-card bg-canvas p-2.5">
          <ul className="flex list-none flex-col gap-1 p-0">
            {claim.sources.map((source) => (
              <li key={source.url}>
                <a
                  className="inline-flex items-center gap-1 text-sky-ink underline underline-offset-2 [overflow-wrap:anywhere]"
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {source.kind === 'amap' ? '高德地图' : source.title || source.domain}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
                <span className="ml-1 text-muted">{source.domain}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-muted">两个来源一致才会显示；以现场和官方公告为准。</p>
          {onReport && (
            <button
              type="button"
              className="mt-1.5 text-danger underline underline-offset-2 disabled:opacity-60"
              disabled={state !== 'idle'}
              onClick={async () => {
                setState('sending');
                try {
                  await onReport(claim);
                } catch {
                  setState('idle');
                }
              }}
            >
              {state === 'sending' ? '正在提交…' : '这条不对，报告有误'}
            </button>
          )}
        </div>
      </details>
    </li>
  );
}

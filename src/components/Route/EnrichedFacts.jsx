import { trackEvent } from '../../lib/betaTelemetry.js';
import { useState } from 'react';
import { BadgeCheck, ExternalLink } from 'lucide-react';

/** Truthful basis line: operator-verified values have a single source; automatic ones say how many agreed. */
export function claimBasisText(claim) {
  const n = claim?.sources?.length ?? 0;
  if (claim?.method === 'ops-verified') return `人工核实：运营人员按${n > 1 ? ` ${n} 个` : ''}来源核对过。以现场和官方公告为准。`;
  if (n >= 2) return `${n} 个来源说法一致才会显示。以现场和官方公告为准。`;
  return '只找到 1 个来源，出发前最好再看一眼。以现场和官方公告为准。';
}

/**
 * 门票 / 开放时间 checked in the background (automatic sources or 人工核实).
 * Each line says where it came from and when; the sources can be expanded; the user can report it wrong.
 * @param {{ claims: any[], onReport?: (claim: any, note?: string) => Promise<any> }} props
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
  // idle → writing (note box open) → sending → sent (receipt shown)
  const [state, setState] = useState('idle');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState('');
  const [error, setError] = useState('');
  const verifiedLabel = claim.method === 'ops-verified' ? '人工核实' : '已核对';
  return (
    <li className={claim.field === 'price' ? 'text-sm font-bold text-ink sm:text-copy' : 'text-meta text-ink-2 sm:text-sm'}>
      <details className="group" onToggle={(event) => event.currentTarget.open && trackEvent('source_open', claim.field)}>
        <summary className="inline-flex cursor-pointer list-none items-start gap-1.5 [&::-webkit-details-marker]:hidden">
          <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-success-ink" aria-hidden="true" />
          <span>
            {claim.field === 'price' ? (
              <>
                <span className="text-success-ink">{verifiedLabel}门票</span>
                <span className="mx-1 text-muted">·</span>
                <span>{claim.display.replace(/^门票[：:]?/, '')}</span>
              </>
            ) : (
              claim.display
            )}
            {claim.reported && <span className="ml-1.5 rounded bg-warn-soft px-1 text-meta font-semibold text-warn-ink">已反馈待复核</span>}
            <span className="ml-1 font-semibold text-sky-ink underline underline-offset-2">来源</span>
          </span>
        </summary>
        <div className="mt-1 ml-5 rounded-card bg-canvas p-2.5">
          <ConditionQuotes conditions={claim.conditions} />
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
          <p className="mt-1.5 text-muted">{claimBasisText(claim)}</p>
          {claim.reported && state !== 'sent' && <p className="mt-1.5 font-semibold text-warn-ink">已有人反馈这条可能不对，正在等运营复核。复核前先保留原值供参考。</p>}
          {state === 'sent' && (
            <p role="status" className="mt-1.5 font-semibold text-success-ink">
              已收到你的反馈{receipt ? `（回执号 ${receipt.slice(0, 8)}）` : ''}。复核前这条会标着「已反馈待复核」继续显示。
            </p>
          )}
          {onReport && !claim.reported && (state === 'idle' ? (
            <button type="button" className="mt-1.5 text-danger underline underline-offset-2" onClick={() => setState('writing')}>
              这条不对，报告有误
            </button>
          ) : state !== 'sent' ? (
            <form
              className="mt-1.5 flex flex-col gap-1.5"
              onSubmit={async (event) => {
                event.preventDefault();
                setState('sending');
                setError('');
                try {
                  const response = await onReport(claim, note.trim());
                  setReceipt(String(response?.receiptId ?? ''));
                  setState('sent');
                  trackEvent('fact_report', claim.field);
                } catch {
                  setError('没提交成功，请稍后再试。');
                  setState('writing');
                }
              }}
            >
              <label className="text-ink-2" htmlFor={`report-${claim.stopKey}-${claim.field}`}>
                哪里不对？（选填，比如你看到的实际票价、来源）
              </label>
              <textarea
                id={`report-${claim.stopKey}-${claim.field}`}
                className="min-h-16 rounded-card border border-line bg-paper p-2 text-sm text-ink"
                maxLength={300}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              {error && <p role="alert" className="text-danger">{error}</p>}
              <div className="flex gap-3">
                <button type="submit" className="font-semibold text-danger underline underline-offset-2 disabled:opacity-60" disabled={state === 'sending'}>
                  {state === 'sending' ? '正在提交…' : '提交反馈'}
                </button>
                <button type="button" className="text-muted underline underline-offset-2" onClick={() => setState('idle')}>
                  取消
                </button>
              </div>
            </form>
          ) : null)}
        </div>
      </details>
      <ConditionNotes conditions={claim.conditions} />
    </li>
  );
}

/** 值下面一行短提示：只列来源原文里写明的条件；只有一个来源的单独标出。 */
export function ConditionNotes({ conditions, className = '' }) {
  if (!conditions?.length) return null;
  return (
    <p className={`ml-5 mt-0.5 text-meta font-semibold text-ink-2 ${className}`} data-testid="enrich-conditions">
      {conditions.map((c) => `${c.label}${c.singleSource ? '（仅 1 个来源提到）' : ''}`).join(' · ')}
    </p>
  );
}

function ConditionQuotes({ conditions }) {
  if (!conditions?.length) return null;
  return (
    <ul className="mb-1.5 flex list-none flex-col gap-1 p-0 text-ink-2">
      {conditions.map((c) => (
        <li key={c.kind}>
          <b>{c.label}</b>：原文「{c.quote}」<span className="text-muted">（{c.sources.map((x) => x.domain).join('、')}）</span>
        </li>
      ))}
    </ul>
  );
}

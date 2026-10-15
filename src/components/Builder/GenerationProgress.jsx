import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Ban, Check, Clock, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { GENERATION_STAGE_LABELS, formatDuration, generationEtaText, lastAttemptText, retryHintText } from '../../lib/generationJob';
import { generationModeLabel } from '../../lib/generationModes';

const STAGE_ORDER = Object.keys(GENERATION_STAGE_LABELS);
const STATUS_TEXT = { completed: '已完成', running: '进行中', pending: '等待中', failed: '失败', cancelled: '已取消' };

/**
 * Generation progress driven by server job snapshots (see src/lib/generationJob.js).
 * Stages only change when the backend reports them; the only client-side clock is
 * the elapsed-time counter.
 * @param {Record<string, any>} props
 */
export function GenerationProgress({
  job,
  outcome,
  failure,
  city,
  duration,
  mode = '',
  cancelling,
  cancelError,
  onCancel,
  onRetry,
  onRetryDeep = () => {},
  onRetryFast = () => {},
  onBackToPrefs
}) {
  const modeLabel = generationModeLabel(mode);
  const running = outcome === 'running' || outcome === 'starting';
  const now = useTicker(running);
  const elapsedMs = job ? job.elapsedMs + (running ? Math.max(0, now - (job.receivedAt ?? now)) : 0) : 0;
  const stages = STAGE_ORDER.map((key) => {
    const stage = job?.stages?.find((item) => item.key === key) ?? { key, status: 'pending' };
    return { ...stage, label: GENERATION_STAGE_LABELS[key] };
  });
  const eta = generationEtaText(job, elapsedMs);
  const completedCount = stages.filter((stage) => stage.status === 'completed').length;
  const headingRef = useRef(null);

  useEffect(() => {
    // Move focus to the result heading when the job ends, so screen-reader and
    // keyboard users land on the outcome instead of a vanished cancel button.
    if (outcome === 'failed' || outcome === 'cancelled' || outcome === 'succeeded') headingRef.current?.focus({ preventScroll: true });
  }, [outcome]);

  const title =
    outcome === 'succeeded' ? '路书生成完成' : outcome === 'cancelled' ? '已取消生成' : outcome === 'failed' ? failure?.title || '这次没排出来' : '正在排路线';
  const announcement =
    outcome === 'succeeded'
      ? '路书生成完成，正在打开'
      : outcome === 'cancelled'
        ? '已取消生成'
        : outcome === 'failed'
          ? '' // the role=alert box below already announces the failure; avoid reading the title twice
          : '正在排路线';

  return (
    <section className="mx-auto max-w-lg pt-4" aria-labelledby="generation-title">
      <div className="text-center">
        <div
          className={cn(
            'mx-auto grid size-16 place-items-center rounded-full',
            outcome === 'failed'
              ? 'bg-primary-soft text-primary-strong'
              : outcome === 'cancelled'
                ? 'bg-canvas text-ink-2'
                : outcome === 'succeeded'
                  ? 'bg-success-soft text-success-ink'
                  : 'bg-[linear-gradient(135deg,#e8553d,#ffc93c)] text-white shadow-cta motion-safe:animate-pulse'
          )}
          aria-hidden="true"
        >
          {outcome === 'failed' ? (
            <AlertCircle className="size-8" />
          ) : outcome === 'cancelled' ? (
            <Ban className="size-8" />
          ) : outcome === 'succeeded' ? (
            <Check className="size-8" strokeWidth={3} />
          ) : (
            <Sparkles className="size-8" />
          )}
        </div>
        <h1 id="generation-title" ref={headingRef} tabIndex={-1} className="mt-4 text-2xl font-black tracking-tight outline-none">
          {title}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {city} · {duration}
          {modeLabel ? ` · ${modeLabel}` : ''}
        </p>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {(running || outcome === 'succeeded') && (
        <div className="mt-5 rounded-card border border-line bg-white p-4 shadow-card">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="flex items-center gap-1.5 text-sm font-bold text-ink">
              <Clock className="size-4 text-muted" aria-hidden="true" />
              已用时 <span className="num tabular-nums">{formatDuration(elapsedMs)}</span>
            </p>
            <p className="text-sm text-muted">{eta.typical}</p>
          </div>
          {running && <p className="mt-1 text-sm font-semibold text-ink-2">{eta.remaining}</p>}
          <div className="mt-3 grid grid-cols-6 gap-1" aria-hidden="true">
            {stages.map((stage) => (
              <span
                key={stage.key}
                className={cn(
                  'h-1.5 rounded-full',
                  stage.status === 'completed' ? 'bg-success' : stage.status === 'running' ? 'bg-primary motion-safe:animate-pulse' : 'bg-line'
                )}
              />
            ))}
          </div>
          <p className="sr-only">
            共 {stages.length} 步，已完成 {completedCount} 步
          </p>
        </div>
      )}

      <ol className="mt-4 grid gap-1.5" aria-label="路书生成步骤">
        {stages.map((stage) => {
          const stageMs = stageDurationMs(stage, job, elapsedMs);
          return (
            <li
              key={stage.key}
              className={cn(
                'flex items-start gap-3 rounded-tile px-3 py-2.5',
                stage.status === 'running' ? 'bg-primary-soft/60' : stage.status === 'failed' ? 'bg-primary-soft' : ''
              )}
              aria-current={stage.status === 'running' ? 'step' : undefined}
            >
              <StageIcon status={stage.status} />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-copy font-bold', stage.status === 'pending' ? 'text-muted' : 'text-ink')}>
                  {stage.label}
                  <span className="sr-only">，{STATUS_TEXT[stage.status] ?? stage.status}</span>
                </span>
                {stageDetail(stage) && <span className="block text-sm text-ink-2">{stageDetail(stage)}</span>}
              </span>
              {stageMs != null && <span className="num shrink-0 pt-0.5 text-xs font-semibold text-muted tabular-nums">{formatDuration(stageMs)}</span>}
            </li>
          );
        })}
      </ol>

      {running && (
        <div className="mt-5 grid gap-2">
          <Button variant="danger" className="w-full" onClick={onCancel} disabled={cancelling || !job} aria-describedby="generation-cancel-hint">
            {cancelling ? <Loader2 className="motion-safe:animate-spin" /> : <X />} {cancelling ? '正在取消…' : '取消生成'}
          </Button>
          <p id="generation-cancel-hint" className="text-center text-xs text-muted">
            取消会马上停止，不算一次生成。也可以先离开，生成会在后台继续，回到「创建路书」就能看到。
          </p>
          {cancelError && (
            <p role="alert" className="text-center text-sm font-semibold text-primary-strong">
              {cancelError}
            </p>
          )}
        </div>
      )}

      {outcome === 'failed' && (
        <div role="alert" className="mt-5 rounded-card border border-primary/30 bg-primary-soft p-4">
          <p className="flex items-start gap-2 text-sm font-semibold text-primary-strong">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {failure?.detail}
          </p>
          {!failure?.suggestFast && <p className="mt-2 text-sm text-ink">{retryHintText(failure, mode)}</p>}
          {failure?.failedAt && lastAttemptText(failure.failedAt) && (
            <p className="mt-1 text-xs text-ink-2">
              <time dateTime={failure.failedAt}>{lastAttemptText(failure.failedAt)}</time>
            </p>
          )}
          {failure?.suggestFast && mode === 'deep' && failure?.fallbackTriedFast ? (
            // 轻快 was already tried automatically and failed too: waiting is the honest first suggestion.
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={onBackToPrefs}>
                <Clock /> 稍后再试
              </Button>
              <Button variant="outline" size="sm" onClick={onRetryFast}>
                <Sparkles /> 用轻快重试
              </Button>
              <Button variant="outline" size="sm" onClick={onRetry}>
                再试一次「细品」
              </Button>
            </div>
          ) : failure?.suggestFast && mode === 'deep' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={onRetryFast}>
                <Sparkles /> 用轻快重试
              </Button>
              <Button variant="outline" size="sm" onClick={onRetry}>
                再试一次「细品」
              </Button>
              <Button variant="outline" size="sm" onClick={onBackToPrefs}>
                <ArrowLeft /> 改改偏好
              </Button>
            </div>
          ) : (
            <ResultActions onRetry={onRetry} onBackToPrefs={onBackToPrefs} onRetryDeep={failure?.suggestDeep && mode === 'fast' ? onRetryDeep : null} />
          )}
        </div>
      )}

      {outcome === 'cancelled' && (
        <div className="mt-5 rounded-card border border-line bg-canvas p-4">
          <p className="text-sm font-semibold text-ink-2">已停止模型请求，这次不计入生成次数。攻略和偏好都还在，可以调整后重新生成。</p>
          <ResultActions onRetry={onRetry} onBackToPrefs={onBackToPrefs} retryLabel="重新生成" />
        </div>
      )}
    </section>
  );
}

function ResultActions({ onRetry, onBackToPrefs, retryLabel = '再试一次', onRetryDeep = null }) {
  // V-U5: no automatic fallback happened, so trying again right away is the honest first step.
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button variant="primary" size="sm" onClick={onRetry}>
        <Sparkles /> {retryLabel}
      </Button>
      {onRetryDeep && (
        <Button variant="outline" size="sm" onClick={onRetryDeep}>
          换「细品」再试
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={onBackToPrefs}>
        <ArrowLeft /> 改改偏好
      </Button>
    </div>
  );
}

function StageIcon({ status }) {
  if (status === 'completed') {
    return (
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-success text-white" aria-hidden="true">
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    );
  }
  if (status === 'running') return <Loader2 className="mt-0.5 size-5 shrink-0 text-primary-strong motion-safe:animate-spin" aria-hidden="true" />;
  if (status === 'failed' || status === 'cancelled') {
    return (
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary-strong text-white" aria-hidden="true">
        <X className="size-3.5" strokeWidth={3} />
      </span>
    );
  }
  return <span className="mt-0.5 size-5 shrink-0 rounded-full border-2 border-line-strong" aria-hidden="true" />;
}

function stageDetail(stage) {
  // Never surface provider/model IDs from stage.detail on the progress page (U2).
  if (stage.status === 'running' && stage.key === 'model') return 'AI 正在排路线，这一步最久';
  if (stage.status === 'running' && stage.progress?.total) return `${stage.progress.done}/${stage.progress.total} 个站点`;
  if (stage.status === 'cancelled') return '已停止';
  if (stage.status === 'completed' && stage.key === 'model') {
    const detail = String(stage.detail || '');
    return /返回\s*\d+\s*个站点/.test(detail) ? detail : '';
  }
  return stage.status === 'completed' ? stage.detail : '';
}

function stageDurationMs(stage, job, elapsedMs) {
  if (!job || !stage.startedAt) return null;
  const createdAtMs = Date.parse(job.createdAt);
  if (stage.status === 'completed' && stage.completedAt) {
    const ms = stage.completedAt - stage.startedAt;
    return ms >= 1000 ? ms : null;
  }
  if (stage.status === 'running' && Number.isFinite(createdAtMs)) return Math.max(0, elapsedMs - (stage.startedAt - createdAtMs));
  return null;
}

function useTicker(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

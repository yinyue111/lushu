import { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Camera, Check, Flag, MapPin, ShieldCheck, X } from 'lucide-react';
import { checkinPhotoUrl, getReviewShare } from '../../lib/api';
import { decodeTripExecution, normalizeTripStops } from '../../lib/tripSession';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { StopThumb } from '../visual/StopThumb';

/** @param {Record<string, any>} props */
export default function PublicReviewPage({ publicId, onBack }) {
  const [state, setState] = useState({ loading: true, error: '', review: null });

  useEffect(() => {
    const ctrl = new AbortController();
    getReviewShare(publicId, ctrl.signal)
      .then((data) => setState({ loading: false, error: '', review: data.review }))
      .catch((error) => setState({ loading: false, error: error.message, review: null }));
    return () => ctrl.abort();
  }, [publicId]);

  if (state.loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4" role="status">
        <div className="flex flex-col items-center gap-3 text-muted">
          <Camera className="size-7 animate-pulse text-success" aria-hidden="true" />
          <p className="text-sm font-semibold">正在读取旅程回顾...</p>
        </div>
      </div>
    );
  }
  if (state.error || !state.review) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4">
        <div className="max-w-sm rounded-panel border border-line bg-white p-6 text-center shadow-card">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-primary-soft text-primary-strong">
            <AlertCircle className="size-6" aria-hidden="true" />
          </span>
          <h1 className="mt-3 text-xl font-extrabold">这份回顾暂时打不开</h1>
          <p className="mt-1 text-sm text-muted">{state.error || '链接不存在或已失效'}</p>
          <Button variant="outline" className="mt-4" onClick={onBack}>
            <ArrowLeft /> 返回首页
          </Button>
        </div>
      </div>
    );
  }

  const { routebook, checkins } = state.review;
  const legacyExecution = decodeTripExecution(new URLSearchParams(window.location.search).get('execution'), routebook);
  const stops = reviewExecutionStops(state.review, legacyExecution, routebook);
  const latestByStop = latestCheckinsByStop(checkins);
  const displayStats = computePublicStats(checkins, stops);
  // 服务端 publicCheckin 序列化透出 photoId 时展示照片墙；没有则不显示。
  // F20: reviews are only served while the original route is public, so linking back is safe.
  const originalRouteId = routebook?.publicId || state.review.routebookId || '';
  const photoCheckins = [...latestByStop.values()].filter((item) => String(item?.photoId ?? '').trim());

  return (
    <div className="page-enter mx-auto max-w-[760px] px-4 pt-5 pb-16 lg:pt-8">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
        <ArrowLeft /> 看看更多路线
      </Button>
      <section className="relative isolate mt-3 overflow-hidden rounded-panel p-5 text-white shadow-pop lg:p-7">
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(135deg,#157a51_0%,#1e9e6a_45%,#1666c1_100%)]" aria-hidden="true" />
        <Flag className="absolute -right-6 -bottom-8 -z-10 size-48 text-white/10" strokeWidth={1.2} aria-hidden="true" />
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-bold backdrop-blur">
          <ShieldCheck className="size-3.5" aria-hidden="true" /> 真实走过的路线 · 体验反馈
        </span>
        <h1 className="mt-3 text-2xl leading-tight font-black tracking-tight lg:text-3xl">{routebook.title}</h1>
        <p className="mt-1 text-sm text-white/85">
          {routebook.city} · {stops.length} 站
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <HeroStat label="有效 GPS 到达率" value={`${displayStats.completionRate}%`} />
          <HeroStat label="体验反馈" value={displayStats.feedbackCount} />
          <HeroStat label="踩坑" value={displayStats.pitfallCount} />
          <HeroStat label="定位存疑" value={displayStats.lowConfidenceArrivalCount} />
        </dl>
      </section>

      {originalRouteId && (
        <nav aria-label="原路线" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-card bg-white p-4 shadow-card">
          <p className="text-copy text-ink-2">这次旅程按公开路线《{routebook.title}》走的，可以查看原路线、作者和复制到自己的路书。</p>
          <a
            href={`/share/${encodeURIComponent(originalRouteId)}`}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <MapPin className="size-4" aria-hidden="true" /> 查看原路线
          </a>
        </nav>
      )}

      <section className="mt-8" aria-labelledby="public-review-timeline">
        <h2 id="public-review-timeline" className="text-xl font-extrabold">
          每一站的真实情况
        </h2>
        <ol className="relative mt-4 grid gap-3 pl-9 before:absolute before:top-2 before:bottom-2 before:left-[13px] before:w-0.5 before:rounded-full before:bg-line">
          {stops.map((stop, index) => {
            const checkin = latestByStop.get(stopKeyForStop(stop));
            const evidence = publicReviewEvidence(checkin, stop);
            const hasResult = evidence.kind !== 'missing';
            const tone = EVIDENCE_TONES[evidence.kind] ?? EVIDENCE_TONES.missing;
            const Marker = tone.icon;
            const showNumbers = ['valid', 'low', 'feedback'].includes(evidence.kind);
            return (
              <li key={stop.id ?? index} className="relative">
                <span
                  className={cn('absolute top-3 -left-9 grid size-7 place-items-center rounded-full border-2 border-white shadow-card', tone.marker)}
                  aria-hidden="true"
                >
                  <Marker className="size-3.5" strokeWidth={2.5} />
                </span>
                <article
                  className={cn(
                    'rounded-card border p-3.5',
                    evidence.kind === 'valid' || evidence.kind === 'feedback' || evidence.kind === 'low'
                      ? 'border-line bg-white shadow-card'
                      : 'border-dashed border-line-strong bg-[repeating-linear-gradient(135deg,#fff_0_10px,#f6f6f4_10px_20px)]'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <StopThumb stop={stop} compact className="size-12 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <strong className="truncate text-copy font-extrabold">{stop.name}</strong>
                        <span className="num shrink-0 text-xs font-bold text-muted">{stop.time}</span>
                      </div>
                      {hasResult ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                          <span className={cn('rounded-full px-2 py-0.5 font-bold', tone.chip)}>{evidence.label}</span>
                          {checkin?.worth && !['跳过', '替换'].includes(checkin.worth) && <span className="text-ink-2">体验：{checkin.worth}</span>}
                          {showNumbers && checkin?.queue && <span className="text-ink-2">排队 {checkin.queue}</span>}
                          {showNumbers && checkin?.cost && <span className="text-ink-2">花费 {checkin.cost}</span>}
                        </div>
                      ) : (
                        <p className="mt-1 text-sm font-semibold text-muted">这站还没有到达或体验反馈</p>
                      )}
                    </div>
                  </div>
                  {checkin?.comment && <p className="mt-2 text-sm text-ink-2">“{checkin.comment}”</p>}
                  {checkin?.pitfall && <p className="mt-1.5 text-sm font-semibold text-danger">踩坑：{checkin.pitfall}</p>}
                  {checkin?.photoId && (
                    <a href={checkinPhotoUrl(checkin.photoId)} target="_blank" rel="noreferrer" className="mt-2 inline-block">
                      <img src={checkinPhotoUrl(checkin.photoId)} alt={`${stop.name}打卡照片`} loading="lazy" className="size-20 rounded-tile object-cover" />
                    </a>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      </section>

      {photoCheckins.length > 0 && (
        <section className="mt-8" aria-labelledby="public-review-photos">
          <h2 id="public-review-photos" className="text-xl font-extrabold">
            打卡照片墙
          </h2>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photoCheckins.map((item) => (
              <a
                key={item.photoId}
                href={checkinPhotoUrl(item.photoId)}
                target="_blank"
                rel="noreferrer"
                title={item.stopName || '打卡照片'}
                className="overflow-hidden rounded-tile"
              >
                <img
                  src={checkinPhotoUrl(item.photoId)}
                  alt={`${item.stopName || '打卡'}照片`}
                  loading="lazy"
                  className="aspect-square w-full object-cover transition-transform hover:scale-105"
                />
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const EVIDENCE_TONES = {
  valid: { icon: Check, marker: 'bg-success text-white', chip: 'bg-success-soft text-success-ink' },
  low: { icon: AlertCircle, marker: 'bg-lemon text-ink', chip: 'bg-lemon-soft text-lemon-ink' },
  feedback: { icon: Camera, marker: 'bg-sky text-white', chip: 'bg-sky-soft text-sky-ink' },
  skipped: { icon: X, marker: 'bg-canvas text-muted', chip: 'bg-canvas text-ink-2' },
  replaced: { icon: X, marker: 'bg-canvas text-muted', chip: 'bg-canvas text-ink-2' },
  missing: { icon: MapPin, marker: 'bg-white text-muted-2', chip: 'bg-canvas text-ink-2' }
};

/** @param {Record<string, any>} props */
function HeroStat({ label, value }) {
  return (
    <div className="rounded-tile bg-white/15 p-3 backdrop-blur">
      <dt className="text-xs font-semibold text-white/85">{label}</dt>
      <dd className="num mt-0.5 text-xl font-black">{value}</dd>
    </div>
  );
}

function reviewExecutionStops(review, legacyExecution, routebook) {
  if (review?.executionStops?.length) return normalizeTripStops(routebook, review.executionStops);
  if (legacyExecution?.stops?.length) return legacyExecution.stops;
  return normalizeTripStops(routebook);
}

function latestCheckinsByStop(checkins) {
  const latest = new Map();
  for (const item of checkins ?? []) {
    const key = checkinKey(item);
    if (key) latest.set(key, item);
  }
  return latest;
}

function stopKeyForStop(stop) {
  return String(stop?.id ?? '').trim();
}

function checkinKey(item) {
  return String(item?.localStopKey ?? item?.stopId ?? '').trim();
}

function computePublicStats(checkins, stops) {
  const stopIds = new Set(stops.map(stopKeyForStop));
  const rows = [...latestCheckinsByStop(checkins).entries()].filter(([key]) => stopIds.has(key)).map(([, row]) => row);
  const feedbackRows = rows.filter(isVisitedFeedback);
  const validRows = feedbackRows.filter(isValidGpsArrival);
  return {
    completionRate: stops.length ? Math.min(100, Math.round((validRows.length / stops.length) * 100)) : 0,
    feedbackCount: feedbackRows.length,
    pitfallCount: feedbackRows.filter((item) => item.worth === '踩坑' || item.pitfall).length,
    lowConfidenceArrivalCount: feedbackRows.filter(
      (item) => !isValidGpsArrival(item) && ['weak', 'invalid'].includes(item.arrivalConfidence || item.arrival?.confidence)
    ).length
  };
}

function publicReviewEvidence(checkin, stop) {
  if (stop?.tripStatus === 'skipped' || checkin?.status === 'skipped' || checkin?.worth === '跳过') {
    return { kind: 'skipped', badgeClass: 'badge-blue', label: '已跳过（不计到达）' };
  }
  // 服务端 executionStops 只透出 pending/visited/skipped，stop.tripStatus 不会是 replaced；
  // 替换只能从打卡行的 status/worth 判断。
  if (checkin?.status === 'replaced' || checkin?.worth === '替换') {
    return { kind: 'replaced', badgeClass: 'badge-blue', label: '已替换（不计到达）' };
  }
  if (!checkin) return { kind: 'missing', badgeClass: 'badge-blue', label: '暂无反馈' };
  if (isVisitedFeedback(checkin)) {
    if (isValidGpsArrival(checkin)) {
      return { kind: 'valid', badgeClass: 'badge-green', label: '有效 GPS 到达' };
    }
    const confidence = checkin.arrivalConfidence || checkin.arrival?.confidence;
    if (confidence === 'weak') return { kind: 'low', badgeClass: 'badge-orange', label: 'GPS 到达置信度不足' };
    if (confidence === 'invalid') return { kind: 'low', badgeClass: 'badge-orange', label: 'GPS 位置疑似偏离' };
  }
  return { kind: 'feedback', badgeClass: 'badge-blue', label: '体验反馈（未核对到达）' };
}

function isVisitedFeedback(checkin) {
  return checkin?.status === 'visited';
}

function isValidGpsArrival(checkin) {
  if (typeof checkin?.arrival?.valid === 'boolean') return checkin.arrival.valid === true;
  return checkin?.arrivalConfidence === 'valid' || checkin?.arrival?.confidence === 'valid';
}

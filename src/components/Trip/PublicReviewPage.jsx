import { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Camera, CheckCircle, Clock, MapPin, Shield } from 'lucide-react';
import { checkinPhotoUrl, getReviewShare } from '../../lib/api';
import { decodeTripExecution, normalizeTripStops } from '../../lib/tripSession';

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
    return <div className="share-page-loading"><Camera size={28} /><p>正在读取路线回顾...</p></div>;
  }
  if (state.error || !state.review) {
    return (
      <div className="share-page-error">
        <AlertCircle size={28} />
        <h1>路线回顾暂不可用</h1>
        <p>{state.error || '链接不存在或已失效'}</p>
        <button className="btn btn-secondary" onClick={onBack}><ArrowLeft size={16} /> 返回首页</button>
      </div>
    );
  }

  const { routebook, checkins } = state.review;
  const legacyExecution = decodeTripExecution(new URLSearchParams(window.location.search).get('execution'), routebook);
  const stops = reviewExecutionStops(state.review, legacyExecution, routebook);
  const latestByStop = latestCheckinsByStop(checkins);
  const displayStats = computePublicStats(checkins, stops);
  // 服务端 publicCheckin 序列化透出 photoId 时展示照片墙；没有则不显示。
  const photoCheckins = [...latestByStop.values()].filter((item) => String(item?.photoId ?? '').trim());

  return (
    <div className="container page-enter" style={{ paddingTop: 40, paddingBottom: 60, maxWidth: 760, margin: '0 auto' }}>
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 24 }}>
        <ArrowLeft size={16} /> 返回平台
      </button>
      <div className="card review-hero">
        <span className="badge badge-blue"><Shield size={12} /> 路线执行与体验反馈</span>
        <h1 className="text-title" style={{ marginTop: 12 }}>{routebook.title}</h1>
        <p className="text-caption" style={{ marginTop: 6 }}>{routebook.city} · {stops.length} 站 · 有效 GPS 到达率 {displayStats.completionRate}%</p>
        <div className="review-stats-grid">
          <div className="review-stat"><CheckCircle size={18} style={{ color: 'var(--green)' }} /><strong>{displayStats.completionRate}%</strong><span>有效 GPS 到达率</span></div>
          <div className="review-stat"><Camera size={18} style={{ color: 'var(--blue)' }} /><strong>{displayStats.feedbackCount}</strong><span>体验反馈</span></div>
          <div className="review-stat"><Clock size={18} style={{ color: 'var(--orange)' }} /><strong>{displayStats.pitfallCount}</strong><span>踩坑</span></div>
          <div className="review-stat"><AlertCircle size={18} style={{ color: 'var(--orange)' }} /><strong>{displayStats.lowConfidenceArrivalCount}</strong><span>低置信</span></div>
        </div>
      </div>
      <div className="review-timeline" style={{ marginTop: 24 }}>
        {stops.map((stop, index) => {
          const checkin = latestByStop.get(stopKeyForStop(stop));
          const evidence = publicReviewEvidence(checkin, stop);
          const hasResult = evidence.kind !== 'missing';
          return (
            <div key={stop.id ?? index} className={`review-stop ${hasResult ? (['skipped', 'replaced'].includes(evidence.kind) ? 'skipped' : evidence.kind === 'valid' ? 'done' : 'feedback') : 'missed'}`}>
              <div className="review-stop-marker">{reviewMarker(evidence.kind)}</div>
              <div className="review-stop-content">
                <div className="review-stop-header"><strong>{stop.name}</strong><span className="text-micro">{stop.time}</span></div>
                {hasResult ? (
                  <div className="review-stop-feedback">
                    <span className={`badge ${evidence.badgeClass}`}>{evidence.label}</span>
                    {checkin?.worth && !['跳过', '替换'].includes(checkin.worth) && <span className="text-micro">体验：{checkin.worth}</span>}
                    {['valid', 'low', 'feedback'].includes(evidence.kind) && checkin?.queue && <span className="text-micro">排队 {checkin.queue}</span>}
                    {['valid', 'low', 'feedback'].includes(evidence.kind) && checkin?.cost && <span className="text-micro">花费 {checkin.cost}</span>}
                  </div>
                ) : <p className="text-caption">暂无到达或体验反馈</p>}
                {checkin?.comment && <p className="text-caption">{checkin.comment}</p>}
                {checkin?.pitfall && <p className="text-caption" style={{ color: 'var(--red)' }}>踩坑: {checkin.pitfall}</p>}
                {checkin?.photoId && (
                  <a href={checkinPhotoUrl(checkin.photoId)} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 6 }}>
                    <img
                      src={checkinPhotoUrl(checkin.photoId)}
                      alt={`${stop.name}打卡照片`}
                      loading="lazy"
                      style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8 }}
                    />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {photoCheckins.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 className="text-subtitle" style={{ marginBottom: 12 }}>打卡照片墙</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8 }}>
            {photoCheckins.map((item) => (
              <a
                key={item.photoId}
                href={checkinPhotoUrl(item.photoId)}
                target="_blank"
                rel="noreferrer"
                title={item.stopName || '打卡照片'}
              >
                <img
                  src={checkinPhotoUrl(item.photoId)}
                  alt={`${item.stopName || '打卡'}照片`}
                  loading="lazy"
                  style={{ width: '100%', height: 96, objectFit: 'cover', borderRadius: 8 }}
                />
              </a>
            ))}
          </div>
        </div>
      )}
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
  const rows = [...latestCheckinsByStop(checkins).entries()]
    .filter(([key]) => stopIds.has(key))
    .map(([, row]) => row);
  const feedbackRows = rows.filter(isVisitedFeedback);
  const validRows = feedbackRows.filter(isValidGpsArrival);
  return {
    completionRate: stops.length ? Math.min(100, Math.round((validRows.length / stops.length) * 100)) : 0,
    feedbackCount: feedbackRows.length,
    pitfallCount: feedbackRows.filter((item) => item.worth === '踩坑' || item.pitfall).length,
    lowConfidenceArrivalCount: feedbackRows.filter((item) => !isValidGpsArrival(item) && ['weak', 'invalid'].includes(item.arrivalConfidence || item.arrival?.confidence)).length
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
  return { kind: 'feedback', badgeClass: 'badge-blue', label: '体验反馈（未验证到达）' };
}

function isVisitedFeedback(checkin) {
  return checkin?.status === 'visited';
}

function isValidGpsArrival(checkin) {
  if (typeof checkin?.arrival?.valid === 'boolean') return checkin.arrival.valid === true;
  return checkin?.arrivalConfidence === 'valid' || checkin?.arrival?.confidence === 'valid';
}

function reviewMarker(kind) {
  if (kind === 'valid') return <CheckCircle size={16} style={{ color: 'var(--green)' }} />;
  if (kind === 'low') return <AlertCircle size={16} style={{ color: 'var(--orange)' }} />;
  if (kind === 'feedback') return <Camera size={16} style={{ color: 'var(--blue)' }} />;
  return <MapPin size={16} style={{ color: 'var(--muted-2)' }} />;
}

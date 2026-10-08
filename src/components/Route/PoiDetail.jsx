import { useEffect, useMemo, useRef, useState } from 'react';
import { X, MapPin, Clock, DollarSign, Users, AlertTriangle, Shield, ExternalLink, Ticket, Flag, FileSearch } from 'lucide-react';
import { createPoiCorrection, getPoiKnowledge, recordClick, recordExposure } from '../../lib/api';
import { getProfile } from '../../lib/profile';
import { productsForStop, useProductCards } from '../../lib/products';
import { clickStorageKey, safeWriteJsonStorage } from '../../lib/storage';
import { coordinateReviewLabel, isNavigableCoordinate } from '../../lib/coordinates';
import { trustedCities } from '../../lib/content';
import { PUBLIC_TRUST_SAMPLE_THRESHOLD, evaluatePoiTrustSample } from '../../lib/trust';
import { useDialogFocus } from '../../lib/useDialogFocus';

export default function PoiDetail({ stop, routebook, onClose }) {
  const profile = useMemo(() => getProfile(), []);
  const [showCorrection, setShowCorrection] = useState(false);
  const [correction, setCorrection] = useState({ field: '开放时间/价格', suggestedValue: '', reason: '' });
  const [message, setMessage] = useState('');
  const [knowledge, setKnowledge] = useState([]);
  const exposureRef = useRef(new Set());
  const productCards = useProductCards();
  const dialogRef = useDialogFocus(Boolean(stop), onClose);
  const stopName = stop?.name ?? '';
  const stopArea = stop?.area ?? '';
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);
  const canNavigate = isNavigableCoordinate(stop);
  const coordinateLabel = canNavigate ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : coordinateReviewLabel(stop);

  const routeId = routebook?.publicId || routebook?.id || routebook?.title;
  const routeTitle = routebook?.title;
  const routeCity = routebook?.city;
  const poiTrustState = buildPoiTrustState(stop, routeCity);
  const realFeedback = useMemo(() => buildPoiRealFeedback(stop), [stop]);
  const PoiTrustIcon = poiTrustState.tone === 'trial' ? AlertTriangle : Shield;
  const creatorId = routebook?.creator?.id;
  const relatedProducts = useMemo(() => {
    const cityScoped = productCards.filter((item) => !item.city || item.city === routeCity);
    const merged = [...productsForStop(cityScoped, stopName), ...productsForStop(cityScoped, stopArea)];
    return merged
      .filter((item, index) => merged.findIndex((next) => (next.id || `${next.provider}-${next.title}`) === (item.id || `${item.provider}-${item.title}`)) === index)
      .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0))
      .slice(0, 2);
  }, [productCards, routeCity, stopArea, stopName]);
  const evidence = useMemo(() => buildEvidence(stop, routebook), [stop, routebook]);
  const approvedKnowledge = [...(stop.approvedCorrections ?? []), ...knowledge]
    .filter((item, index, list) => list.findIndex((next) => (next.correctionId || next.id) === (item.correctionId || item.id)) === index)
    .slice(0, 5);

  useEffect(() => {
    if (!stopName) return undefined;
    const controller = new AbortController();
    getPoiKnowledge({ city: routebook?.city, stopName, limit: 10 }, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setKnowledge(data.knowledge ?? []);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [routebook?.city, stopName]);

  useEffect(() => {
    relatedProducts.forEach((item, index) => {
      const productId = item.id || `${item.provider}-${item.title}`;
      const key = `${routeId}:${stop?.id}:${productId}`;
      if (exposureRef.current.has(key)) return;
      exposureRef.current.add(key);
      recordExposure({
        profileId: profile.id,
        surface: 'poi-detail',
        itemType: 'product',
        itemId: productId,
        productId,
        productTitle: item.title,
        routeId,
        routeTitle,
        city: routeCity,
        stopId: stop?.id,
        stopName: stop?.name,
        creatorId,
        sourcePosition: `poi-product-${index + 1}`
      }).catch(() => {});
    });
  }, [creatorId, profile.id, relatedProducts, routeCity, routeId, routeTitle, stop?.id, stop?.name]);

  if (!stop) return null;

  function handleProductClick(item) {
    const payload = {
      ...item,
      productId: item.id || `${item.provider}-${item.title}`,
      profileId: profile.id,
      routeId: routebook?.publicId || routebook?.id,
      routeTitle: routebook?.title,
      city: routebook?.city,
      stopId: stop.id,
      stopName: stop.name,
      creatorId: routebook?.creator?.id,
      source: 'poi',
      sourcePosition: 'poi-detail',
      clickedAt: new Date().toISOString()
    };
    const existing = safeReadClicks();
    if (!safeWriteJsonStorage(clickStorageKey(profile.id), [payload, ...existing].slice(0, 100))) {
      setMessage('本地点击归因存储失败，已尝试同步服务端');
    }
    recordClick(payload).catch(() => {});
    if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer');
  }

  function openInMap() {
    if (!canNavigate) {
      setMessage('当前 POI 坐标待复核，暂不能直接打开地图标记');
      return;
    }
    window.open(`https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(stop.name)}&src=trusted-routebook&coordinate=wgs84&callnative=1`, '_blank', 'noopener,noreferrer');
  }

  async function submitCorrection(event) {
    event.preventDefault();
    setMessage('提交中...');
    try {
      await createPoiCorrection({
        routeTitle: routebook?.title,
        city: routebook?.city,
        stopId: stop.id,
        stopName: stop.name,
        currentValue: `${stop.verify}；${stop.risk}`,
        ...correction
      });
      setMessage('已提交纠错，运营台会进入待审核队列');
      setShowCorrection(false);
      setCorrection({ field: '开放时间/价格', suggestedValue: '', reason: '' });
    } catch (error) {
      setMessage(`提交失败：${error.message}`);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal-content poi-detail-modal" role="dialog" aria-modal="true" aria-labelledby="poi-detail-title" tabIndex={-1} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="poi-detail-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span className={`badge ${poiTrustState.badgeClass}`}><PoiTrustIcon size={11} /> {poiTrustState.label}</span>
              {!canNavigate && <span className="badge badge-orange">定位待复核</span>}
              <span className="text-micro">{stop.area}</span>
            </div>
            <h2 className="text-title" id="poi-detail-title">{stop.name}</h2>
          </div>
          <button className="btn btn-icon btn-sm" onClick={onClose} aria-label="关闭 POI 详情"><X size={18} /></button>
        </div>

        {/* Info grid */}
        <div className="poi-info-grid">
          <div className="poi-info-item">
            <Clock size={14} style={{ color: 'var(--blue)' }} />
            <div>
              <span className="text-micro">建议停留</span>
              <strong>{stop.stay}</strong>
            </div>
          </div>
          <div className="poi-info-item">
            <DollarSign size={14} style={{ color: 'var(--green)' }} />
            <div>
              <span className="text-micro">预计费用</span>
              <strong>{stop.cost}</strong>
            </div>
          </div>
          <div className="poi-info-item">
            <MapPin size={14} style={{ color: 'var(--orange)' }} />
            <div>
              <span className="text-micro">坐标</span>
              <strong>{coordinateLabel}</strong>
              {!canNavigate && <small className="text-micro">仅展示模糊范围，不建议直接导航</small>}
            </div>
          </div>
          <div className="poi-info-item">
            <Users size={14} style={{ color: 'var(--muted)' }} />
            <div>
              <span className="text-micro">适合人群</span>
              <strong>{realFeedback.audienceText || '待真实验证'}</strong>
            </div>
          </div>
        </div>

        {/* Real feedback（poiTrust 反哺；字段可能暂缺，防御渲染） */}
        <div className="poi-detail-section">
          <h3 className="text-caption" style={{ fontWeight: 700, marginBottom: 8 }}>真实人群与排队数据</h3>
          {realFeedback.hasData ? (
            <div className="card-flat" style={{ display: 'grid', gap: 8 }}>
              {realFeedback.audienceText && (
                <p className="text-caption">
                  <Users size={12} style={{ color: 'var(--blue)' }} /> 适合人群
                  {realFeedback.feedbackCount > 0 ? `（近 30 天 ${realFeedback.feedbackCount} 份真实反馈）` : ''}：{realFeedback.audienceText}
                </p>
              )}
              {(realFeedback.queueMinutes != null || realFeedback.costMedian != null) && (
                <p className="text-caption">
                  <Clock size={12} style={{ color: 'var(--green)' }} /> {[
                    realFeedback.queueMinutes != null ? `实测排队约 ${realFeedback.queueMinutes} 分钟` : '',
                    realFeedback.costMedian != null ? `人均约 ${realFeedback.costMedian} 元` : ''
                  ].filter(Boolean).join(' / ')}
                </p>
              )}
              {realFeedback.crowdLabel && (
                <p className="text-caption"><Users size={12} style={{ color: 'var(--orange)' }} /> 实测拥挤程度：{realFeedback.crowdLabel}</p>
              )}
              {realFeedback.latestDaysAgo != null && (
                <p className="text-caption">
                  <Clock size={12} style={{ color: 'var(--muted)' }} /> {realFeedback.latestDaysAgo === 0
                    ? '今天有人反馈了该点位的真实情况'
                    : `${realFeedback.latestDaysAgo} 天前有人反馈了该点位的真实情况`}
                </p>
              )}
            </div>
          ) : (
            <p className="text-caption">待真实打卡验证 · 打卡后这里会出现真实人群与排队数据</p>
          )}
          {realFeedback.correctionCount > 0 && (
            <p className="text-caption" style={{ color: 'var(--orange)', marginTop: 8 }}>
              <AlertTriangle size={12} /> 近期有 {realFeedback.correctionCount} 条营业信息纠错，出行前请复核
            </p>
          )}
        </div>

        {/* Verify + Risk */}
        <div className="poi-detail-section">
          <h3 className="text-caption" style={{ fontWeight: 700, marginBottom: 8 }}>出发前复核与风险</h3>
          <div className="card-flat" style={{ display: 'grid', gap: 8 }}>
            <p className="text-caption"><Shield size={12} style={{ color: 'var(--blue)' }} /> 复核建议：{stop.verify || '出发前核对开放时间与现场条件'}</p>
            <p className="text-caption"><AlertTriangle size={12} style={{ color: 'var(--orange)' }} /> {stop.risk}</p>
          </div>
        </div>

        {(evidence.length > 0 || approvedKnowledge.length > 0) && (
          <div className="poi-detail-section">
            <h3 className="text-caption" style={{ fontWeight: 700, marginBottom: 8 }}>
              <FileSearch size={12} /> 证据与已审纠错
            </h3>
            <div className="poi-evidence-list">
              {evidence.slice(0, 4).map((item) => (
                <a
                  key={item.id || item.url || item.label}
                  className="poi-evidence-card"
                  href={item.url || undefined}
                  target={item.url ? '_blank' : undefined}
                  rel="noreferrer"
                >
                  <span className="badge badge-blue">{item.platform || (item.type === 'matched-source' ? '来源命中' : '路线来源')}</span>
                  <strong>{item.label}</strong>
                  <small>{item.detail || '来源只作为规划线索，出发前仍需复核。'}</small>
                </a>
              ))}
              {approvedKnowledge.map((item) => (
                <div key={item.correctionId || item.id} className="poi-evidence-card approved">
                  <span className="badge badge-green">运营已审</span>
                  <strong>{item.field || '综合信息'}</strong>
                  <small>{item.value || item.suggestedValue}{item.reason ? `；依据：${item.reason}` : ''}</small>
                </div>
              ))}
            </div>
          </div>
        )}

        {stop.facts?.length > 0 && (
          <div className="poi-detail-section">
            <h3 className="text-caption" style={{ fontWeight: 700, marginBottom: 8 }}>
              <FileSearch size={12} /> 事实核验
            </h3>
            <div className="poi-fact-list">
              {stop.facts.slice(0, 6).map((fact) => (
                <a
                  key={fact.id || `${fact.field}-${fact.value}`}
                  className="poi-fact-row"
                  href={fact.sourceUrl || undefined}
                  target={fact.sourceUrl ? '_blank' : undefined}
                  rel="noreferrer"
                >
                  <span className="badge badge-blue">{fact.confidence ?? '-'}%</span>
                  <div>
                    <strong>{fact.field}</strong>
                    <small>{fact.value}</small>
                    <em>{fact.status} · {fact.sourceLabel || fact.sourceType || '来源待补充'}</em>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Confidence */}
        <div className="poi-detail-section">
          <h3 className="text-caption" style={{ fontWeight: 700, marginBottom: 8 }}>可信度指标</h3>
          <div className={`poi-evidence-card ${poiTrustState.verified ? 'approved' : ''}`} style={{ marginBottom: 10 }}>
            <span className={`badge ${poiTrustState.badgeClass}`}>{poiTrustState.verified ? '真实 POI 反馈' : poiTrustState.value}</span>
            <strong>{poiTrustState.detailLabel}</strong>
            <small>{poiTrustState.detail}</small>
          </div>
          <div className="poi-confidence-bar">
            <div
              className="poi-confidence-fill"
              style={{
                width: poiTrustState.verified ? `${poiTrustState.score}%` : '0%',
                background: poiTrustState.tone === 'trial' ? 'var(--orange)' : poiTrustState.verified ? 'var(--green)' : 'var(--blue)'
              }}
            />
          </div>
          <div className="poi-confidence-labels">
            <span className="text-micro">地理精度: {stop.geoConfidence ?? 72}%</span>
            <span className="text-micro">坐标系: {stop.coordinateSystem ?? 'WGS84'}</span>
          </div>
        </div>

        {/* Related products */}
        {relatedProducts.length > 0 && (
          <div className="poi-detail-section">
            <h3 className="text-caption" style={{ fontWeight: 700, marginBottom: 8 }}>
              <Ticket size={12} /> 相关商品
            </h3>
            {relatedProducts.map((item, index) => (
              <button key={item.id || item.url || `${item.provider}-${item.title}-${index}`} className="poi-product-card" onClick={() => handleProductClick(item)}>
                <div>
                  <strong>{item.title}</strong>
                  <span className="text-micro">{item.type} · {item.price}</span>
                </div>
                <span className="badge badge-blue">{item.deepLinkStatus === 'verified' ? '可归因深链' : '外部入口'}</span>
              </button>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="poi-detail-actions">
          <button className="btn btn-secondary" onClick={openInMap} disabled={!canNavigate}>
            <ExternalLink size={14} /> 在地图中查看
          </button>
          <button className="btn btn-secondary" onClick={() => setShowCorrection((value) => !value)}>
            <Flag size={14} /> POI 纠错
          </button>
        </div>
        {showCorrection && (
          <form className="poi-correction-form" onSubmit={submitCorrection}>
            <label>
              <span className="input-label">纠错字段</span>
              <select className="input-field" value={correction.field} onChange={(event) => setCorrection((prev) => ({ ...prev, field: event.target.value }))}>
                {['开放时间/价格', '位置坐标', '排队/拥挤', '闭店/暂停', '适合人群', '其他'].map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              <span className="input-label">建议修正</span>
              <textarea className="input-field" value={correction.suggestedValue} onChange={(event) => setCorrection((prev) => ({ ...prev, suggestedValue: event.target.value }))} placeholder="例如：门票已涨到 15 元，周一闭馆..." />
            </label>
            <label>
              <span className="input-label">依据</span>
              <input className="input-field" value={correction.reason} onChange={(event) => setCorrection((prev) => ({ ...prev, reason: event.target.value }))} placeholder="现场打卡、官方公告、地图信息..." />
            </label>
            <button className="btn btn-primary btn-sm" type="submit">提交纠错</button>
          </form>
        )}
        {message && <p className="text-caption" style={{ padding: '0 var(--space-lg) var(--space-lg)' }}>{message}</p>}
      </div>
    </div>
  );
}

function safeReadClicks() {
  try {
    const profile = getProfile();
    const rows = JSON.parse(localStorage.getItem(clickStorageKey(profile.id)) ?? '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function buildEvidence(stop, routebook) {
  const explicit = Array.isArray(stop?.sourceEvidence) ? stop.sourceEvidence : [];
  if (explicit.length) return explicit;
  const sources = Array.isArray(routebook?.importedSources) ? routebook.importedSources : [];
  if (!sources.length) return [];
  const stopName = String(stop?.name ?? '');
  const area = String(stop?.area ?? '');
  const matched = sources.filter((source) => {
    const text = `${source.title ?? ''} ${source.description ?? ''} ${source.excerpt ?? ''}`;
    return (stopName && text.includes(stopName)) || (area && text.includes(area));
  });
  const selected = matched.length ? matched : sources.slice(0, 1);
  return selected.slice(0, 3).map((source, index) => ({
    id: `${source.platform || 'source'}-${index}`,
    type: matched.length ? 'matched-source' : 'route-source',
    label: `${source.platform || '导入来源'}｜来源预测 ${sourcePredictionLabel(source)}`,
    detail: matched.length
      ? (source.title || source.description || source.excerpt || '来源命中该站点。')
      : `路线级来源，未在公开摘要中逐点命中「${stopName}」。${source.title || source.description || ''}`,
    platform: source.platform,
    predictionScore: source.predictionScore ?? source.trustScore,
    trustScore: source.trustScore,
    url: source.url
  }));
}

function sourcePredictionLabel(source) {
  const value = source?.predictionScore ?? source?.trustScore;
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Math.round(Number(value)) : '待计算';
}

function buildPoiTrustState(stop, city) {
  const trust = stop?.poiTrust;
  // verified 判定收敛到 trust.js 唯一出口，禁止在组件内重复实现阈值判断。
  const { sampleCount, score, verified } = evaluatePoiTrustSample(trust);

  if (!trustedCities.includes(city)) {
    return {
      tone: 'trial',
      badgeClass: 'badge-orange',
      verified: false,
      value: '待复核',
      label: '试验生成 · 待复核',
      detailLabel: '当前城市尚未进入可信范围',
      detail: 'POI、营业信息和导航需人工复核，暂不输出数值分。',
      score: null
    };
  }

  if (verified) {
    const validArrivals = Math.max(0, Number(trust?.validArrivals) || 0);
    const pitfallRate = trust?.pitfallRate == null || !Number.isFinite(Number(trust.pitfallRate))
      ? null
      : Math.max(0, Math.min(100, Number(trust.pitfallRate)));
    return {
      tone: 'verified',
      badgeClass: 'badge-green',
      verified: true,
      value: String(Math.round(score)),
      label: `POI 可信 ${Math.round(score)}`,
      detailLabel: trust?.label || '独立身份打卡验证',
      detail: [
        trust?.freshnessLabel,
        `独立有效样本 ${sampleCount} 个`,
        `有效到达 ${validArrivals} 次`,
        pitfallRate == null ? '' : `踩坑率 ${pitfallRate}%`
      ].filter(Boolean).join(' · '),
      score
    };
  }

  return {
    tone: 'prediction',
    badgeClass: 'badge-blue',
    verified: false,
    value: '待验证',
    label: 'POI 待验证',
    detailLabel: '独立身份样本不足',
    detail: `独立有效样本 ${Math.min(sampleCount, PUBLIC_TRUST_SAMPLE_THRESHOLD)}/${PUBLIC_TRUST_SAMPLE_THRESHOLD}，暂不输出 POI 可信分。`,
    score: null
  };
}

// stop.poiTrust 真实反哺契约（服务端同波落地，字段可能暂缺，必须防御渲染）：
// audienceBreakdown:[{label,count,share}] / queueMinutesMedian / costMedian
// / crowdLevel / latestFeedbackAt / recentCorrectionCount。
// share 契约固定为 0-100 的整数百分比，这里只做 clamp，不再做小数/百分比启发式换算。
// 无任何真实数据时 hasData=false，页面只展示「待真实打卡验证」，不编造占比。
function buildPoiRealFeedback(stop) {
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

  const queueRaw = Number(trust.queueMinutesMedian);
  const queueMinutes = Number.isFinite(queueRaw) && queueRaw >= 0 ? Math.round(queueRaw) : null;
  const costRaw = Number(trust.costMedian);
  const costMedian = Number.isFinite(costRaw) && costRaw >= 0 ? Math.round(costRaw) : null;

  const crowdLabelMap = { low: '较宽松', medium: '一般', moderate: '一般', high: '拥挤', 'very-high': '非常拥挤' };
  const crowdRaw = typeof trust.crowdLevel === 'string' ? trust.crowdLevel.trim() : '';
  const crowdLabel = crowdRaw ? (crowdLabelMap[crowdRaw.toLowerCase()] ?? crowdRaw.slice(0, 12)) : '';

  const latestTimestamp = Date.parse(trust.latestFeedbackAt ?? '');
  const latestDaysAgo = Number.isFinite(latestTimestamp)
    ? Math.max(0, Math.floor((Date.now() - latestTimestamp) / 86400000))
    : null;

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

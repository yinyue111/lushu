import { costDisplay } from '../../lib/cost';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, Clock, Wallet, Users, AlertTriangle, ShieldCheck, ExternalLink, Ticket, Flag, FileSearch } from 'lucide-react';
import { createPoiCorrection, getPoiKnowledge } from '../../lib/api';
import { recordProductClick, recordProductExposure } from '../../lib/productTelemetry';
import { getProfile } from '../../lib/profile';
import { productsForStop, useProductCards } from '../../lib/products';
import { clickStorageKey, safeWriteJsonStorage } from '../../lib/storage';
import { amapNameSearchUrl, coordinateReviewLabel, isNavigableCoordinate } from '../../lib/coordinates';
import { trustedCities } from '../../lib/content';
import { PUBLIC_TRUST_SAMPLE_THRESHOLD, evaluatePoiTrustSample } from '../../lib/trust';
import { coordinateVerificationLevel } from '../../lib/trustSignals';
import { Sheet } from '../ui/sheet';
import { StopProvenanceDetail } from './StopProvenance';
import { Button } from '../ui/button';
import { Field, inputClass } from '../ui/field';
import { cn } from '../ui/cn';
import { buildPoiRealFeedback } from './poiFeedbackModel';

/** @param {Record<string, any>} props */
export default function PoiDetail({ stop, routebook, onClose }) {
  const profile = useMemo(() => getProfile(), []);
  const [showCorrection, setShowCorrection] = useState(false);
  const [correction, setCorrection] = useState({ field: '开放时间', suggestedValue: '', reason: '' });
  const [message, setMessage] = useState('');
  const [knowledge, setKnowledge] = useState([]);
  const exposureRef = useRef(new Set());
  const productCards = useProductCards();
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
  const PoiTrustIcon = poiTrustState.tone === 'trial' ? AlertTriangle : ShieldCheck;
  const creatorId = routebook?.creator?.id;
  const relatedProducts = useMemo(() => {
    const cityScoped = productCards.filter((item) => !item.city || item.city === routeCity);
    const merged = [...productsForStop(cityScoped, stopName), ...productsForStop(cityScoped, stopArea)];
    return merged
      .filter(
        (item, index) => merged.findIndex((next) => (next.id || `${next.provider}-${next.title}`) === (item.id || `${item.provider}-${item.title}`)) === index
      )
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
      recordProductExposure({
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
      surface: 'poi-detail',
      sourcePosition: 'poi-detail',
      clickedAt: new Date().toISOString()
    };
    const existing = safeReadClicks();
    if (!safeWriteJsonStorage(clickStorageKey(profile.id), [payload, ...existing].slice(0, 100))) {
      setMessage('链接已打开，正在记录这次点击');
    }
    recordProductClick(payload).catch(() => {});
    if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer');
  }

  function openInMap() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setMessage('需要网络：联网后才能打开高德地图');
      return;
    }
    if (!canNavigate) {
      window.open(amapNameSearchUrl(stop, routeCity), '_blank', 'noopener,noreferrer');
      return;
    }
    window.open(
      `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(stop.name)}&src=trusted-routebook&coordinate=wgs84&callnative=1`,
      '_blank',
      'noopener,noreferrer'
    );
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
      setMessage('已提交，运营核对后会更新');
      setShowCorrection(false);
      setCorrection({ field: '开放时间', suggestedValue: '', reason: '' });
    } catch (error) {
      setMessage(`提交失败：${error.message}`);
    }
  }

  const trustTone = poiTrustState.tone === 'trial' ? 'warn' : poiTrustState.verified ? 'ok' : 'sky';

  return (
    <Sheet title={stop.name} description={stop.area || routebook?.city} onClose={onClose} wide>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={trustTone}>
          <PoiTrustIcon aria-hidden="true" /> {poiTrustState.label}
        </Pill>
        {!canNavigate && <Pill tone="warn">定位待复核</Pill>}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <InfoTile icon={Clock} iconClass="text-sky-ink bg-sky-soft" label="建议停留" value={stop.stay || '—'} />
        {stop.verifiedPrice?.text ? (
          <InfoTile
            icon={Wallet}
            iconClass="text-success-ink bg-success-soft"
            label="已核验费用"
            value={stop.verifiedPrice.text}
            hint={verifiedPriceHint(stop.verifiedPrice)}
          />
        ) : (
          <InfoTile icon={Wallet} iconClass="text-success-ink bg-success-soft" label="价格" value={costDisplay(stop).text || '—'} />
        )}
        <InfoTile
          icon={MapPin}
          iconClass="text-primary-strong bg-primary-soft"
          label="坐标"
          value={coordinateLabel}
          hint={!canNavigate ? '只知道大概范围，别直接导航' : ''}
        />
        <InfoTile icon={Users} iconClass="text-lemon-ink bg-lemon-soft" label="适合人群" value={realFeedback.audienceText || '待真实验证'} />
      </div>

      <Section title="真实人群与排队">
        {realFeedback.hasData ? (
          <ul className="grid gap-2 rounded-tile bg-canvas p-3.5 text-sm text-ink-2">
            {realFeedback.audienceText && (
              <Line icon={Users}>
                适合人群{realFeedback.feedbackCount > 0 ? `（近 30 天 ${realFeedback.feedbackCount} 份真实反馈）` : ''}：{realFeedback.audienceText}
              </Line>
            )}
            {(realFeedback.queueMinutes != null || realFeedback.costMedian != null) && (
              <Line icon={Clock}>
                {[
                  realFeedback.queueMinutes != null ? `实测排队约 ${realFeedback.queueMinutes} 分钟` : '',
                  realFeedback.costMedian != null ? `人均约 ${realFeedback.costMedian} 元` : ''
                ]
                  .filter(Boolean)
                  .join(' / ')}
              </Line>
            )}
            {realFeedback.crowdLabel && <Line icon={Users}>实测拥挤程度：{realFeedback.crowdLabel}</Line>}
            {realFeedback.latestDaysAgo != null && (
              <Line icon={Clock}>
                {realFeedback.latestDaysAgo === 0 ? '今天有人反馈过这里的情况' : `${realFeedback.latestDaysAgo} 天前有人反馈过这里的情况`}
              </Line>
            )}
          </ul>
        ) : (
          <p className="rounded-tile border border-dashed border-line-strong p-3.5 text-sm text-muted">
            还没有真实打卡。有人打卡后，这里会出现真实人群与排队数据。
          </p>
        )}
        {realFeedback.correctionCount > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-lemon-ink">
            <AlertTriangle className="size-4" aria-hidden="true" /> 近期有 {realFeedback.correctionCount} 条营业信息纠错，出发前请再确认
          </p>
        )}
      </Section>

      <Section title="出发前确认">
        <ul className="grid gap-2 rounded-tile bg-lemon-soft/60 p-3.5 text-sm text-ink-2">
          <Line icon={ShieldCheck} iconClass="text-sky-ink">
            {stop.verify || '出发前核对开放时间与现场条件'}
          </Line>
          {stop.risk && (
            <Line icon={AlertTriangle} iconClass="text-lemon-ink">
              {stop.risk}
            </Line>
          )}
        </ul>
      </Section>

      {(evidence.length > 0 || approvedKnowledge.length > 0) && (
        <Section title="来源与已审纠错" icon={FileSearch}>
          <div className="grid gap-2 sm:grid-cols-2">
            {evidence.slice(0, 4).map((item) => (
              <EvidenceCard
                key={item.id || item.url || item.label}
                href={item.url}
                tag={item.platform || (item.type === 'matched-source' ? '来源提到' : '路线来源')}
                title={item.label}
                detail={item.detail || '来源只作为规划线索，出发前仍需复核。'}
              />
            ))}
            {approvedKnowledge.map((item) => (
              <EvidenceCard
                key={item.correctionId || item.id}
                approved
                tag="运营已审"
                title={item.field || '综合信息'}
                detail={`${item.value || item.suggestedValue || ''}${item.reason ? `；依据：${item.reason}` : ''}`}
              />
            ))}
          </div>
        </Section>
      )}

      {stop.facts?.length > 0 && (
        <Section title="事实核验" icon={FileSearch}>
          <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line">
            {stop.facts.slice(0, 6).map((fact) => {
              const body = (
                <>
                  <span className="num shrink-0 rounded-full bg-sky-soft px-2 py-0.5 text-xs font-bold text-sky-ink">{fact.confidence ?? '-'}%</span>
                  <span className="min-w-0">
                    <strong className="block text-sm font-bold">{fact.field}</strong>
                    <span className="block text-sm text-ink-2">{fact.value}</span>
                    <span className="block text-xs text-muted">
                      {fact.status} · {fact.sourceLabel || fact.sourceType || '来源待补充'}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={fact.id || `${fact.field}-${fact.value}`}>
                  {fact.sourceUrl ? (
                    <a className="flex items-start gap-3 p-3 hover:bg-canvas" href={fact.sourceUrl} target="_blank" rel="noreferrer">
                      {body}
                    </a>
                  ) : (
                    <div className="flex items-start gap-3 p-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section title="可信度">
        <div className={cn('rounded-tile border p-3.5', poiTrustState.verified ? 'border-success/30 bg-success-soft/60' : 'border-line bg-white')}>
          <div className="flex items-center justify-between gap-3">
            <strong className="text-sm font-extrabold">{poiTrustState.detailLabel}</strong>
            <Pill tone={trustTone}>{poiTrustState.verified ? `可信分 ${poiTrustState.value}` : poiTrustState.value}</Pill>
          </div>
          <p className="mt-1 text-meta text-muted">{poiTrustState.detail}</p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-canvas" aria-hidden="true">
            <div
              className={cn('h-full rounded-full', poiTrustState.tone === 'trial' ? 'bg-lemon' : poiTrustState.verified ? 'bg-success' : 'bg-sky')}
              style={{ width: poiTrustState.verified ? `${poiTrustState.score}%` : '0%' }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted">
            <span>
              坐标
              {{ verified: '已精确定位', approximate: '为近似位置', none: '缺失' }[coordinateVerificationLevel(stop)]}
            </span>
            <span>坐标系 {stop.coordinateSystem ?? 'WGS84'}</span>
          </div>
        </div>
        <StopProvenanceDetail stop={stop} />
      </Section>

      {relatedProducts.length > 0 && (
        <Section title="相关门票与商品" icon={Ticket}>
          <div className="grid gap-2">
            {relatedProducts.map((item, index) => (
              <button
                key={item.id || item.url || `${item.provider}-${item.title}-${index}`}
                type="button"
                className="flex items-center justify-between gap-3 rounded-tile border border-line bg-white p-3 text-left hover:border-line-strong hover:shadow-card"
                onClick={() => handleProductClick(item)}
              >
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-bold">{item.title}</strong>
                  <span className="text-xs text-muted">
                    {item.type} · {item.price}
                  </span>
                </span>
                <Pill tone="sky">{item.deepLinkStatus === 'verified' ? '直达链接' : '外部入口'}</Pill>
              </button>
            ))}
          </div>
        </Section>
      )}

      <div className="sticky -bottom-6 -mx-6 mt-5 flex flex-wrap gap-2 border-t border-line bg-white/95 px-6 py-3 backdrop-blur max-md:-bottom-5 max-md:-mx-5 max-md:px-5">
        <Button variant="dark" onClick={openInMap}>
          <ExternalLink /> {canNavigate ? '在地图中查看' : '在高德按名字搜'}
        </Button>
        <Button variant="outline" aria-expanded={showCorrection} onClick={() => setShowCorrection((value) => !value)}>
          <Flag /> 信息有误？纠错
        </Button>
      </div>

      {showCorrection && (
        <form className="mt-3 grid gap-3 rounded-tile bg-canvas p-4" onSubmit={submitCorrection}>
          <Field label="哪里不对">
            <select className={inputClass} value={correction.field} onChange={(event) => setCorrection((prev) => ({ ...prev, field: event.target.value }))}>
              {['开放时间', '价格', '闭店/暂停', '位置坐标', '排队/拥挤', '适合人群', '其他'].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </Field>
          <Field label="正确的是">
            <textarea
              className={cn(inputClass, 'min-h-20')}
              value={correction.suggestedValue}
              onChange={(event) => setCorrection((prev) => ({ ...prev, suggestedValue: event.target.value }))}
              placeholder="例如：门票已涨到 15 元，周一闭馆..."
            />
          </Field>
          <Field label="依据">
            <input
              className={inputClass}
              value={correction.reason}
              onChange={(event) => setCorrection((prev) => ({ ...prev, reason: event.target.value }))}
              placeholder="现场打卡、官方公告、地图信息..."
            />
          </Field>
          <Button type="submit" variant="primary" size="sm" className="justify-self-start">
            提交纠错
          </Button>
        </form>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm font-semibold text-ink-2">
          {message}
        </p>
      )}
    </Sheet>
  );
}

/** @param {Record<string, any>} props */
function Pill({ tone = 'sky', children }) {
  const tones = {
    sky: 'bg-sky-soft text-sky-ink',
    ok: 'bg-success-soft text-success-ink',
    warn: 'bg-lemon-soft text-lemon-ink'
  };
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold [&_svg]:size-3.5', tones[tone])}>{children}</span>;
}

/** @param {any} price */
function verifiedPriceHint(price) {
  const day = (value) => (value ? String(value).slice(0, 10) : '');
  return [price.source?.label || '运营核验', price.verifiedAt ? `核验于 ${day(price.verifiedAt)}` : '', price.expiresAt ? `有效至 ${day(price.expiresAt)}` : '']
    .filter(Boolean)
    .join(' · ');
}

/** @param {Record<string, any>} props */
function InfoTile({ icon: Icon, iconClass, label, value, hint = '' }) {
  return (
    <div className="flex gap-2.5 rounded-tile bg-canvas p-3">
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', iconClass)}>
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-muted">{label}</p>
        <p className="num text-sm font-extrabold break-words">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Section({ title, icon: Icon, children }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-copy font-extrabold">
        {Icon && <Icon className="size-4 text-muted" aria-hidden="true" />}
        {title}
      </h3>
      {children}
    </section>
  );
}

/** @param {Record<string, any>} props */
function Line({ icon: Icon, iconClass = 'text-muted', children }) {
  return (
    <li className="flex items-start gap-2">
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconClass)} aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

/** @param {Record<string, any>} props */
function EvidenceCard({ href, tag, title, detail, approved = false }) {
  const body = (
    <>
      <span className={cn('self-start rounded-full px-2 py-0.5 text-xs font-bold', approved ? 'bg-success-soft text-success-ink' : 'bg-sky-soft text-sky-ink')}>
        {tag}
      </span>
      <strong className="text-sm font-bold">{title}</strong>
      <span className="line-clamp-3 text-xs text-muted">{detail}</span>
    </>
  );
  const cls = cn('flex flex-col gap-1 rounded-tile border p-3', approved ? 'border-success/30 bg-success-soft/40' : 'border-line bg-white');
  return href ? (
    <a className={cn(cls, 'hover:border-line-strong hover:shadow-card')} href={href} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
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
      ? source.title || source.description || source.excerpt || '来源里提到了这一站。'
      : `这条来源讲的是整条路线，摘要里没直接提到「${stopName}」。${source.title || source.description || ''}`,
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
      label: 'AI 草稿 · 未实地确认',
      detailLabel: '这座城市还没开放可信评分',
      detail: '地点、营业信息和导航还要人工复核，先不打分。',
      score: null
    };
  }

  if (verified) {
    const validArrivals = Math.max(0, Number(trust?.validArrivals) || 0);
    const pitfallRate =
      trust?.pitfallRate == null || !Number.isFinite(Number(trust.pitfallRate)) ? null : Math.max(0, Math.min(100, Number(trust.pitfallRate)));
    return {
      tone: 'verified',
      badgeClass: 'badge-green',
      verified: true,
      value: String(Math.round(score)),
      label: `POI 可信 ${Math.round(score)}`,
      detailLabel: trust?.label || '不同的人打卡验证',
      detail: [trust?.freshnessLabel, `${sampleCount} 个人有效打卡`, `有效到达 ${validArrivals} 次`, pitfallRate == null ? '' : `踩坑率 ${pitfallRate}%`]
        .filter(Boolean)
        .join(' · '),
      score
    };
  }

  return {
    tone: 'prediction',
    badgeClass: 'badge-blue',
    verified: false,
    value: '待验证',
    label: 'POI 待验证',
    detailLabel: '打卡的人还不够',
    detail: `已有 ${Math.min(sampleCount, PUBLIC_TRUST_SAMPLE_THRESHOLD)}/${PUBLIC_TRUST_SAMPLE_THRESHOLD} 个人有效打卡，够数后再打分。`,
    score: null
  };
}

// stop.poiTrust 真实反哺契约（服务端同波落地，字段可能暂缺，必须防御渲染）：
// audienceBreakdown:[{label,count,share}] / queueMinutesMedian / costMedian
// / crowdLevel / latestFeedbackAt / recentCorrectionCount。
// share 契约固定为 0-100 的整数百分比，这里只做 clamp，不再做小数/百分比启发式换算。
// 无任何真实数据时 hasData=false，页面只展示「待真实打卡验证」，不编造占比。

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Camera, MapPin, Plus, Route, Shield, Sparkles } from 'lucide-react';
import { getCityPhotos, getCityRoutes, getCityStory, curatedRouteToRoutebook, trustedCities } from '../../lib/content';
import { getRoutebooksByCity } from '../../lib/api';
import { getRouteTrustBadgeState } from '../../lib/trust';

export default function DestinationPage({ city, onBack, onOpenBook, onNewBook, onOpenDestination }) {
  const [serverState, setServerState] = useState({ city: '', books: [], error: '' });
  const requestSequence = useRef(0);
  const serverBooks = serverState.city === city ? serverState.books : [];
  const error = serverState.city === city ? serverState.error : '';
  const story = getCityStory(city);
  const curated = useMemo(() => getCityRoutes(city), [city]);
  const photos = useMemo(() => getCityPhotos(city), [city]);

  useEffect(() => {
    const ctrl = new AbortController();
    const requestId = ++requestSequence.current;
    setServerState({ city, books: [], error: '' });
    getRoutebooksByCity(city, 40, ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted && requestSequence.current === requestId) {
          setServerState({ city, books: data.routebooks ?? [], error: '' });
        }
      })
      .catch((err) => {
        if (!ctrl.signal.aborted && requestSequence.current === requestId) {
          setServerState({ city, books: [], error: err.message });
        }
      });
    return () => ctrl.abort();
  }, [city]);

  return (
    <div className="destination-page page-enter">
      <section className="destination-hero" style={/** @type {import('react').CSSProperties} */ ({ '--hero-image': `url(${story.image})` })}>
        <div className="home-hero-shade" />
        <div className="destination-hero-content">
          <button className="btn btn-secondary btn-sm" onClick={onBack}><ArrowLeft size={16} /> 返回首页</button>
          <div>
            <span className="home-kicker">{story.kicker}</span>
            <h1>{city} 目的地页</h1>
            <p>{story.summary}</p>
            <div className="home-hero-metrics">
              <span><Shield size={15} /> 编辑样板 · 待真实验证</span>
              <span><Camera size={15} /> 真实数据来自有效 GPS 打卡</span>
              <span><Route size={15} /> {serverBooks.length ? `公开路线 ${serverBooks.length} 条 · ` : ''}编辑样板 {curated.length} 条</span>
            </div>
          </div>
          <button className="btn btn-primary btn-lg" onClick={() => onNewBook({ city, guide: `想去${city}，请生成适合我的可信路书。` })}>
            <Sparkles size={18} /> 生成我的{city}路书
          </button>
        </div>
      </section>

      <main className="container home-content">
        {error && <p className="text-caption" style={{ color: 'var(--orange)' }}>服务端路线读取失败，已展示运营精选：{error}</p>}
        <section className="home-section">
          <div className="section-heading">
            <div>
              <span className="section-kicker">推荐路线</span>
              <h2>编辑精选 + 用户保存路线</h2>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => onNewBook({ city })}><Plus size={15} /> 新建</button>
          </div>
          <div className="curated-route-grid">
            {curated.map((route) => (
              <article key={route.id} className="curated-route-card">
                <button className="route-card-cover" onClick={() => onOpenBook(curatedRouteToRoutebook(route))}>
                  <img src={route.image} alt={`${route.title} 封面`} />
                  <span className="trust-pill badge badge-blue" style={{ background: 'var(--blue-bg)', color: 'var(--blue)' }}>
                    <Shield size={13} /> 预测编排 · 待真实验证
                  </span>
                </button>
                <div className="route-card-body">
                  <h3>{route.title}</h3>
                  <p>{route.summary}</p>
                  <button className="btn btn-secondary btn-sm" onClick={() => onOpenBook(curatedRouteToRoutebook(route))}><Route size={15} /> 查看路书</button>
                </div>
              </article>
            ))}
            {serverBooks.map((book) => {
              const trustState = getRouteTrustBadgeState(book);
              return (
                <button key={book.publicId ?? book.title} className="book-card compact-book" onClick={() => onOpenBook(book)}>
                  <span className={`badge ${trustState.badgeClass}`}><Shield size={12} /> {trustState.compactText}</span>
                  <h3>{book.title}</h3>
                  <p>{book.summary}</p>
                  <span><MapPin size={12} /> {book.stops?.length ?? 0} 站 · 用户保存</span>
                </button>
              );
            })}
            {!curated.length && !serverBooks.length && (
              <div className="national-empty-routes">
                <MapPin size={28} />
                <h3>{city} 暂无公开精选路线</h3>
                <p>这个目的地还没有足够真实执行数据。粘贴小红书、抖音、X 或公众号攻略链接后，可以先生成个人预测可信路书，出行打卡后再反哺为路线资产。</p>
                <button className="btn btn-primary" onClick={() => onNewBook({ city, guide: `想去${city}，请基于我后续粘贴的攻略生成可信路书。` })}>
                  <Sparkles size={16} /> 导入攻略生成{city}路书
                </button>
                {onOpenDestination && (
                  <div className="empty-city-guide">
                    <span>或先去已验证的目的地看看：</span>
                    <div className="city-suggestion-strip">
                      {trustedCities.filter((item) => item !== city).map((item) => (
                        <button key={item} onClick={() => onOpenDestination(item)}>{item}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="home-section">
          <div className="section-heading">
            <div>
              <span className="section-kicker">目的地图集</span>
              <h2>与 POI 关联的灵感图</h2>
            </div>
          </div>
          <div className="photo-wall">
            {photos.map((photo) => (
              <figure key={`${photo.poi}-${photo.title}`} className="photo-card">
                <img src={photo.image} alt={`${photo.poi} ${photo.title}`} loading="lazy" />
                <figcaption>
                  <strong>{photo.title}</strong>
                  <span><MapPin size={12} /> {photo.poi} · {photo.source}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

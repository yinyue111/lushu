import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Bell, Camera, Clock3, Compass, Link2, MapPin, Plus, Route, Shield, Sparkles } from 'lucide-react';
import { curatedRouteToRoutebook, getCityPhotos, getCityRoutes, getCityStory, trustedCities } from '../lib/content';
import { getCmsConfig } from '../lib/api';
import { getProfile } from '../lib/profile';
import { getRouteTrustBadgeState } from '../lib/trust';

const themes = ['Citywalk', '美食拍照', '寺院茶山', '亲子慢游', '雨天备选'];
const durations = ['1 日', '2 天 1 晚', '3 天 2 晚'];
// 同一会话内记住用户已选/输入的目的地，路由往返首页后恢复，优先于 CMS defaultCity。
const HOME_CITY_STORAGE_KEY = 'trusted-routebook:home-city';

export default function HomePage({ books, onNewBook, onOpenBook, onOpenDestination, onRefresh }) {
  const [profile] = useState(() => getProfile());
  const [storedCity] = useState(() => readStoredHomeCity());
  const [cmsConfig, setCmsConfig] = useState(null);
  const [city, setCity] = useState(() => storedCity || (profile.preferredCities?.[0] ?? profile.homeCity ?? '杭州'));
  const [duration, setDuration] = useState('2 天 1 晚');
  const [theme, setTheme] = useState(profile.themes?.[0] ?? 'Citywalk');
  const [guideSeed, setGuideSeed] = useState('');
  const [cityQuery, setCityQuery] = useState(() => storedCity || (profile.preferredCities?.[0] ?? profile.homeCity ?? '杭州'));
  const [cityTouched, setCityTouched] = useState(false);
  // CMS defaultCity 是异步返回的：用户开始输入后（即使还没提交）就不能再被覆盖；
  // 会话内已恢复过用户选择的城市时同样不覆盖。
  const cityDirtyRef = useRef(Boolean(storedCity));
  const refreshRef = useRef(onRefresh);
  const story = getCityStory(city);
  const cityRoutes = useMemo(() => getCityRoutes(city), [city]);
  const cityPhotos = useMemo(() => getCityPhotos(city), [city]);
  const visibleThemes = useMemo(() => [...new Set([...(profile.themes ?? []), ...themes])].slice(0, 8), [profile.themes]);
  const isTrustedCity = trustedCities.includes(city);

  useEffect(() => {
    const ctrl = new AbortController();
    getCmsConfig(ctrl.signal)
      .then((data) => {
        const config = data.config ?? null;
        setCmsConfig(config);
        if (!cityTouched && !cityDirtyRef.current && config?.defaultCity) {
          const configuredCity = String(config.defaultCity).trim().replace(/市$/, '');
          const nextCity = trustedCities.includes(configuredCity) ? configuredCity : '杭州';
          setCity(nextCity);
          setCityQuery(nextCity);
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [cityTouched]);

  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const refresh = () => refreshRef.current?.();
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  function commitCity(nextCity = cityQuery) {
    const normalized = String(nextCity ?? '')
      .trim()
      .replace(/市$/, '');
    if (!normalized) return;
    cityDirtyRef.current = true;
    setCityTouched(true);
    setCity(normalized);
    setCityQuery(normalized);
    persistHomeCity(normalized);
  }

  function startFromHero() {
    onNewBook({
      city,
      duration,
      theme: [theme],
      guide: `想要${city}${duration}，主题偏好：${theme}。希望路线可信、少绕路，并保留真实打卡反馈。`
    });
  }

  function startFromImport() {
    const guide = guideSeed.trim();
    if (!guide) return;
    onNewBook({ city, duration, theme: [theme], guide, initialStep: 1, autoImport: true });
  }

  return (
    <div className="home-page page-enter">
      <link rel="preload" as="image" href={story.image} />
      <section className="home-hero" style={/** @type {import('react').CSSProperties} */ ({ '--hero-image': `url(${story.image})` })}>
        <div className="home-hero-shade" />
        <div className="home-hero-content">
          <div className="home-hero-copy">
            <span className="home-kicker">{story.kicker}</span>
            <h1>可信路书 AI</h1>
            <p>{cmsConfig?.heroTitle || '把小红书、抖音、X 和收藏地点，整理成能照着走、能被真实打卡验证的个人路书。'}</p>
            {cmsConfig?.announcements?.length > 0 && (
              <div className="home-announcements" aria-label="运营公告">
                {cmsConfig.announcements.slice(0, 2).map((item) => (
                  <span key={item}>
                    <Bell size={14} /> {item}
                  </span>
                ))}
              </div>
            )}
            <div className="home-hero-metrics" aria-label={`${city} 路线数据`}>
              <span>
                <Shield size={15} /> 编辑样板 · 待真实验证
              </span>
              <span>
                <Camera size={15} /> 真实数据来自有效 GPS 打卡
              </span>
              <span>
                <Clock3 size={15} /> {story.season}
              </span>
            </div>
          </div>

          <div className="routebook-composer" aria-label="导入并生成可信路书">
            <div className="home-import-row">
              <label>
                <span>攻略链接或正文</span>
                <input
                  value={guideSeed}
                  onChange={(event) => setGuideSeed(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') startFromImport();
                  }}
                  placeholder="粘贴小红书 / 抖音 / X 链接，或输入想去的地点"
                  aria-label="粘贴攻略链接或正文"
                />
              </label>
              <button className="btn btn-primary btn-lg" onClick={startFromImport} disabled={!guideSeed.trim()}>
                <Link2 size={18} /> 导入并分析
              </button>
            </div>
            <div className="composer-row compact">
              <label>
                <span>目的地</span>
                <input
                  value={cityQuery}
                  onChange={(event) => {
                    cityDirtyRef.current = true;
                    setCityQuery(event.target.value);
                  }}
                  onBlur={() => commitCity()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitCity();
                  }}
                  placeholder="输入目的地城市"
                  aria-label="输入目的地城市"
                />
              </label>
              <label>
                <span>天数</span>
                <select value={duration} onChange={(event) => setDuration(event.target.value)}>
                  {durations.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="city-suggestion-strip" aria-label="首批可信城市快捷选择">
              {trustedCities.map((item) => (
                <button key={item} className={item === city ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => commitCity(item)}>
                  {item}
                </button>
              ))}
            </div>
            {!isTrustedCity && (
              <p role="status" className="composer-trial-note">
                {city}为试验生成，POI、营业信息和导航需人工复核。
              </p>
            )}
            <div>
              <span className="composer-label">主题</span>
              <div className="composer-chips">
                {visibleThemes.map((item) => (
                  <button key={item} className={`chip ${theme === item ? 'active' : ''}`} aria-pressed={theme === item} onClick={() => setTheme(item)}>
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn btn-secondary composer-import" onClick={startFromHero}>
              <Sparkles size={17} /> 不导入攻略，直接规划 <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </section>

      <main className="container home-content">
        <section className="home-section">
          <div className="section-heading">
            <div>
              <span className="section-kicker">{city} 推荐路线</span>
              <h2>可复制、可继续验证的编辑样板</h2>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={startFromHero}>
              <Plus size={15} /> 定制此目的地
            </button>
          </div>
          <div className="curated-route-grid">
            {cityRoutes.length ? (
              cityRoutes.map((route) => (
                <article key={route.id} className="curated-route-card">
                  <button className="route-card-cover" onClick={() => onOpenBook(curatedRouteToRoutebook(route))}>
                    <img src={route.image} alt={`${route.title} 封面`} loading="lazy" />
                    <span className="trust-pill badge badge-blue" style={{ background: 'var(--blue-bg)', color: 'var(--blue)' }}>
                      <Shield size={13} /> 预测编排 · 待真实验证
                    </span>
                  </button>
                  <div className="route-card-body">
                    <div className="route-card-tags">
                      {route.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                    <h3>{route.title}</h3>
                    <p>{route.summary}</p>
                    <div className="route-card-facts">
                      <span>{route.subtitle}</span>
                      <span>预测编排 · 待真实打卡验证</span>
                    </div>
                    <div className="route-card-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => onOpenBook(curatedRouteToRoutebook(route))}>
                        <Route size={15} /> 查看路书
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => onNewBook({ city: route.city, duration, theme: route.tags, guide: route.summary })}
                      >
                        AI 改成适合我 <ArrowRight size={15} />
                      </button>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <div className="national-empty-routes">
                <MapPin size={28} />
                <h3>{city} 暂无运营精选路线</h3>
                <p>可粘贴当地攻略、收藏地点或想去的商圈生成试验路书。POI、营业信息和导航需人工复核。</p>
                <button className="btn btn-primary" onClick={startFromHero}>
                  <Sparkles size={16} /> 生成{city}路书
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="home-section destination-panel">
          <div className="destination-copy">
            <span className="section-kicker">目的地专题</span>
            <h2>{city} 当季路线资产</h2>
            <p>{story.summary}</p>
            <div className="destination-stats">
              <span>
                <Shield size={16} /> 编辑样板 · 待真实验证
              </span>
              <span>
                <Camera size={16} /> 有效 GPS 样本达标后展示真实可信分
              </span>
              <span>
                <Compass size={16} /> 首批可信城市：上海 · 杭州 · 苏州
              </span>
            </div>
            <button className="btn btn-secondary btn-sm" style={{ marginTop: 18 }} onClick={() => onOpenDestination(city)}>
              <MapPin size={15} /> 打开{city}目的地页
            </button>
          </div>
          <div className="photo-wall" aria-label={`${city} 美图灵感`}>
            {cityPhotos.map((photo) => (
              <figure key={`${photo.city}-${photo.poi}-${photo.title}`} className="photo-card">
                <img src={photo.image} alt={`${photo.poi} ${photo.title}`} loading="lazy" />
                <figcaption>
                  <strong>{photo.title}</strong>
                  <span>
                    <MapPin size={12} /> {photo.poi} · {photo.source}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="home-section">
          <div className="section-heading">
            <div>
              <span className="section-kicker">我的路书</span>
              <h2>继续编辑或出发执行</h2>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => onNewBook({ city, duration, theme: [theme] })}>
              <Plus size={15} /> 新建
            </button>
          </div>

          {books.length === 0 ? (
            <div className="saved-empty">
              <Shield size={24} />
              <div>
                <h3>还没有保存的路书</h3>
                <p>从推荐路线复制一份，或粘贴攻略链接生成你的第一份可信路书。</p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={startFromHero}>
                开始生成
              </button>
            </div>
          ) : (
            <div className="book-grid compact">
              {books.map((book, idx) => {
                const trustState = getRouteTrustBadgeState(book);
                return (
                  <button key={`${book.city}-${idx}`} className="book-card compact-book" onClick={() => onOpenBook(book)}>
                    <span className={`badge ${trustState.badgeClass}`}>
                      <Shield size={12} /> {trustState.compactText}
                    </span>
                    <h3>{book.title ?? `${book.city} 路书`}</h3>
                    <p>{book.summary?.slice(0, 58) ?? '可信路书'}</p>
                    <span>
                      <MapPin size={12} /> {book.city} · {book.stops?.length ?? 0} 站
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function readStoredHomeCity() {
  try {
    return String(sessionStorage.getItem(HOME_CITY_STORAGE_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

function persistHomeCity(city) {
  try {
    sessionStorage.setItem(HOME_CITY_STORAGE_KEY, city);
  } catch {
    // sessionStorage 不可用（隐私模式等）时静默降级，城市仅保留内存态。
  }
}

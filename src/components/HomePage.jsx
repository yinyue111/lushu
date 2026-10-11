import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Bell, Clock3, Compass, Link2, MapPin, Plus, Route, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from './ui/button';
import { Chip } from './ui/chip';
import { cn } from './ui/cn';
import { inputClass } from './ui/field';
import { RouteCard } from './cards/RouteCard';
import { routebookCardMeta } from '../lib/routebookCardMeta';
import { SectionHeading } from './ui/section-heading';
import { CityBackdrop } from './visual/CityBackdrop';
import { hasCityPhotos, smallImage } from './visual/theme';
import { curatedRouteToRoutebook, getCityPhotos, getCityRoutes, getCityStory, seasonNoteFor, trustedCities } from '../lib/content';
import { getCmsConfig } from '../lib/api';
import { getProfile } from '../lib/profile';
import { useAccount } from './Account/AccountProvider';

const themes = ['Citywalk', '美食拍照', '寺院茶山', '亲子慢游', '雨天备选'];
const durations = ['1 日', '2 天 1 晚', '3 天 2 晚'];
// 同一会话内记住用户已选/输入的目的地，路由往返首页后恢复，优先于 CMS defaultCity。
const HOME_CITY_STORAGE_KEY = 'trusted-routebook:home-city';

export default function HomePage({ books, onNewBook, onOpenBook, onOpenDestination, onRefresh }) {
  const { required: loginRequired, account } = useAccount();
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

  const quickCities = trustedCities;

  return (
    <div className="bg-white pb-16 text-ink">
      {/* Hero: city photo + import composer */}
      <section className="relative isolate overflow-hidden">
        <CityBackdrop city={city} />
        <div
          className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(10,12,16,.35)_0%,rgba(10,12,16,.15)_40%,rgba(10,12,16,.7)_100%)]"
          aria-hidden="true"
        />
        <div className="mx-auto grid max-w-[1376px] grid-cols-[minmax(0,1fr)] gap-8 px-4 pt-10 pb-8 lg:grid-cols-[minmax(0,1fr)_520px] lg:items-end lg:px-8 lg:pt-20 lg:pb-14">
          <div className="text-white">
            <Chip tone="lemon" wrap>
              <MapPin /> {story.kicker}
            </Chip>
            <h1 className="mt-4 text-display-md max-[359px]:text-display-sm leading-[1.15] font-extrabold tracking-tight [text-shadow:0_2px_18px_rgba(0,0,0,.25)] lg:text-display-xl">
              把收藏的攻略，
              <br />
              变成能照着走的路书
            </h1>
            <p className="mt-4 max-w-[620px] text-base text-white/92 lg:text-lg">
              {cmsConfig?.heroTitle || '粘贴小红书、抖音、X 链接或收藏地点，AI 帮你排好顺序；走过的人用 GPS 打卡帮你验证。'}
            </p>
            <div className="mt-5 flex flex-wrap gap-2" aria-label={`${city} 路线数据`}>
              <Chip tone="glass" wrap>
                <ShieldCheck /> 真实打卡才出可信分
              </Chip>
              <Chip tone="glass" wrap>
                <Clock3 /> {seasonNoteFor(story)}
              </Chip>
            </div>
            {cmsConfig?.announcements?.length > 0 && (
              <div className="mt-4 flex flex-col gap-2" aria-label="运营公告">
                {cmsConfig.announcements.slice(0, 2).map((item) => (
                  <span key={item} className="inline-flex items-center gap-2 self-start rounded-full bg-lemon px-3 py-1.5 text-sm font-semibold text-ink">
                    <Bell className="size-4" /> {item}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-panel bg-white p-4 text-ink shadow-pop sm:p-5" aria-label="导入并生成可信路书" role="group">
            <label className="block">
              <span className="text-sm font-bold text-ink-2">攻略链接或正文</span>
              <textarea
                value={guideSeed}
                onChange={(event) => setGuideSeed(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    startFromImport();
                  }
                }}
                rows={2}
                placeholder="粘贴小红书 / 抖音 / X 链接，或写下想去的地方"
                aria-label="粘贴攻略链接或正文"
                className={`${inputClass} mt-1.5 min-h-[76px] resize-none`}
              />
            </label>
            {!account && guideSeed.trim() && (
              <p className="mt-2 text-sm font-semibold text-ink-2" role="status">
                {loginRequired
                  ? '下一步会请你登录，攻略内容会保留。'
                  : '登录后路书会同步到账号，换设备也能看（可选）。'}
              </p>
            )}
            <Button variant="primary" size="lg" className="mt-3 h-[52px] w-full text-lead" onClick={startFromImport} disabled={!guideSeed.trim()}>
              <Link2 /> 导入并分析
            </Button>

            <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
              <label className="block min-w-0">
                <span className="text-sm font-bold text-ink-2">目的地</span>
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
                  className={`${inputClass} mt-1.5`}
                />
              </label>
              <label className="block">
                <span className="text-sm font-bold text-ink-2">天数</span>
                <select value={duration} onChange={(event) => setDuration(event.target.value)} className={`${inputClass} mt-1.5 w-auto`}>
                  {durations.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2" aria-label="首批可信城市快捷选择">
              {quickCities.map((item) => (
                <button
                  type="button"
                  key={item}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commitCity(item)}
                  aria-pressed={item === city}
                  className={cn('h-8 rounded-full px-3.5 text-sm font-bold', item === city ? 'bg-lemon text-ink' : 'bg-canvas text-ink-2 hover:bg-line')}
                >
                  {item}
                </button>
              ))}
            </div>
            {!isTrustedCity && (
              <p role="status" className="mt-2.5 rounded-tile bg-lemon-soft px-3 py-2 text-meta font-semibold text-lemon-ink">
                {city}还在试运行：AI 能帮你排路线，但地点、营业时间和导航要自己再核对。
              </p>
            )}
            <div className="mt-4">
              <span className="text-sm font-bold text-ink-2">想怎么玩</span>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {visibleThemes.map((item) => (
                  <button
                    type="button"
                    key={item}
                    aria-pressed={theme === item}
                    onClick={() => setTheme(item)}
                    className={cn('h-8 rounded-full px-3.5 text-sm font-semibold', theme === item ? 'bg-ink text-white' : 'bg-canvas text-ink-2 hover:bg-line')}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <Button variant="ghost" className="mt-3 w-full text-sky-ink" onClick={startFromHero}>
              <Sparkles /> 没有攻略？直接帮我规划 <ArrowRight />
            </Button>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1376px] px-4 lg:px-8">
        {/* Curated routes */}
        <section className="mt-10 lg:mt-14" aria-labelledby="home-curated-title">
          <SectionHeading
            id="home-curated-title"
            kicker={`${city} · 精选路线`}
            title="照着走就行的路线"
            action={
              <Button size="sm" onClick={startFromHero}>
                <Plus /> 按我的喜好定制
              </Button>
            }
          />
          {cityRoutes.length ? (
            <div className={cn('grid grid-cols-1 gap-4', cityRoutes.length > 1 && 'sm:grid-cols-2', cityRoutes.length > 2 && 'lg:grid-cols-3')}>
              {cityRoutes.map((route) => {
                const book = curatedRouteToRoutebook(route);
                return (
                  <RouteCard
                    key={route.id}
                    routebook={book}
                    image={route.image}
                    tags={route.tags}
                    curated
                    layout={cityRoutes.length === 1 ? 'feature' : 'tall'}
                    meta={route.subtitle}
                    onOpen={() => onOpenBook(book)}
                    actions={
                      <>
                        <Button size="sm" variant="dark" onClick={() => onOpenBook(book)}>
                          <Route /> 看路书
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-sky-ink"
                          onClick={() => onNewBook({ city: route.city, duration, theme: route.tags, guide: route.summary })}
                        >
                          改成适合我的 <ArrowRight />
                        </Button>
                      </>
                    }
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-panel bg-canvas px-6 py-10 text-center">
              <span className="grid size-14 place-items-center rounded-full bg-white text-primary-strong shadow-card">
                <MapPin className="size-7" />
              </span>
              <h3 className="text-lg font-extrabold">{city} 还没有精选路线</h3>
              <p className="max-w-md text-sm text-muted">粘贴当地攻略、收藏的地点或想逛的商圈，AI 先帮你排一版；地点和营业信息出发前要自己再核对。</p>
              <Button variant="primary" onClick={startFromHero}>
                <Sparkles /> 生成{city}路书
              </Button>
            </div>
          )}
        </section>

        {/* Destination feature */}
        <section
          className={cn(
            'mt-10 grid gap-4 overflow-hidden rounded-panel bg-ink p-5 text-white lg:mt-14 lg:p-8',
            hasCityPhotos(city) && 'lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]'
          )}
          aria-labelledby="home-destination-title"
        >
          <div className="flex flex-col justify-center">
            <span className="text-xs font-extrabold tracking-[0.08em] text-lemon">目的地专题</span>
            <h2 id="home-destination-title" className="mt-2 text-title leading-tight font-extrabold lg:text-display-md">
              {city}，这个季节怎么玩
            </h2>
            <p className="mt-3 text-copy text-white/85">{story.summary}</p>
            <ul className="mt-4 flex flex-col gap-2 text-sm text-white/90">
              <li className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-lemon" /> 有足够真实打卡后才显示可信分
              </li>
              <li className="flex items-center gap-2">
                <Compass className="size-4 text-lemon" /> 首批可信城市：上海 · 杭州 · 苏州
              </li>
            </ul>
            <Button variant="light" size="sm" className="mt-5 self-start" onClick={() => onOpenDestination(city)}>
              <MapPin /> 打开{city}专题
            </Button>
          </div>
          <div
            tabIndex={0}
            role="region"
            className="no-scrollbar -mx-5 flex snap-x gap-3 overflow-x-auto px-5 lg:mx-0 lg:grid lg:grid-cols-2 lg:px-0"
            aria-label={`${city} 美图灵感`}
          >
            {(hasCityPhotos(city) ? cityPhotos : []).slice(0, 4).map((photo) => (
              <figure
                key={`${photo.city}-${photo.poi}-${photo.title}`}
                className="relative isolate aspect-[4/5] w-56 shrink-0 snap-start overflow-hidden rounded-card lg:aspect-[4/3] lg:w-auto"
              >
                <img
                  src={smallImage(photo.image)}
                  alt={`${photo.poi} ${photo.title}`}
                  loading="lazy"
                  className="absolute inset-0 -z-10 size-full object-cover"
                />
                <figcaption className="absolute inset-x-0 bottom-0 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,.7))] p-3 pt-10">
                  <strong className="block text-base">{photo.title}</strong>
                  <span className="flex items-center gap-1 text-xs text-white/85">
                    <MapPin className="size-3" /> {photo.poi}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        {/* My routebooks */}
        <section className="mt-10 lg:mt-14" aria-labelledby="home-my-title">
          <SectionHeading
            id="home-my-title"
            kicker="我的路书"
            title="接着改，或者直接出发"
            action={
              <Button size="sm" variant="primary" onClick={() => onNewBook({ city, duration, theme: [theme] })}>
                <Plus /> 新建
              </Button>
            }
          />
          {books.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-panel bg-canvas p-6 sm:flex-row sm:items-center">
              <span className="grid size-12 shrink-0 place-items-center rounded-full bg-white text-primary-strong shadow-card">
                <Route className="size-6" />
              </span>
              <div className="flex-1">
                <h3 className="text-base font-extrabold">还没有保存的路书</h3>
                <p className="text-sm text-muted">复制一条精选路线，或者粘贴攻略生成你的第一份路书。</p>
              </div>
              <Button size="sm" variant="dark" onClick={startFromHero}>
                开始生成
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {books.map((book, idx) => (
                <RouteCard key={`${book.publicId || book.id || book.city}-${idx}`} routebook={book} layout="row" meta={routebookCardMeta(book)} onOpen={() => onOpenBook(book)} />
              ))}
            </div>
          )}
        </section>
      </div>
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

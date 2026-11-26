import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Camera, Link2, MapPin, Plus, Route, ShieldCheck, Sparkles } from 'lucide-react';
import { getCityPhotos, getCityRoutes, getCityStory, curatedRouteToRoutebook, trustedCities } from '../../lib/content';
import { cities as supportedCities, isCityOpenForGeneration } from '../../lib/chinaCities.js';
import { getCities, getRoutebooksByCity } from '../../lib/api';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';
import { SectionHeading } from '../ui/section-heading';
import { RouteCard } from '../cards/RouteCard';
import { CityBackdrop } from '../visual/CityBackdrop';
import { EmptyArt } from '../visual/EmptyArt';
import { hasCityPhotos, smallImage } from '../visual/theme';
import { useDocumentTitle } from '../../lib/useDocumentTitle.js';

function isValidDestinationCity(value) {
  const raw = String(value ?? '');
  if (!raw || raw !== raw.trim() || /\s/.test(raw)) return false;
  return supportedCities.includes(raw);
}

/** @param {Record<string, any>} props */
export default function DestinationPage({ city, onBack, onOpenBook, onNewBook, onOpenDestination }) {
  const validCity = isValidDestinationCity(city);
  const [openSet, setOpenSet] = useState(/** @type {Set<string> | null} */ (null));
  const [serverState, setServerState] = useState({ city: '', books: [], error: '' });
  const requestSequence = useRef(0);
  const openForGeneration = validCity && (openSet ? openSet.has(city) : isCityOpenForGeneration(city));
  const curated = useMemo(() => (validCity ? getCityRoutes(city) : []), [city, validCity]);
  const photos = useMemo(() => (validCity && hasCityPhotos(city) ? getCityPhotos(city) : []), [city, validCity]);

  useDocumentTitle(validCity ? `${city}｜AI 可信路书` : '没找到这个城市｜AI 可信路书');

  useEffect(() => {
    const ctrl = new AbortController();
    getCities('', ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted && Array.isArray(data?.openCities) && data.openCities.length) {
          setOpenSet(new Set(data.openCities));
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    if (!validCity || !openForGeneration) return undefined;
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
  }, [city, openForGeneration, validCity]);

  if (!validCity) {
    return (
      <div className="page-enter mx-auto grid min-h-[60vh] max-w-[680px] place-items-center px-4 py-12">
        <div className="w-full rounded-panel border border-line bg-white p-6 text-center shadow-card sm:p-8">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-primary-soft text-primary-strong">
            <AlertCircle className="size-6" aria-hidden="true" />
          </span>
          <h1 className="mt-3 text-title-sm font-extrabold text-ink">没找到这个城市</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">网址里的城市不在目前支持的城市列表里，可以先去已开放的目的地看看。</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={onBack}>
              返回首页
            </Button>
            {onOpenDestination &&
              trustedCities.map((item) => (
                <Button key={item} variant="outline" size="sm" onClick={() => onOpenDestination(item)}>
                  {item} <ArrowRight />
                </Button>
              ))}
          </div>
        </div>
      </div>
    );
  }

  const serverBooks = serverState.city === city ? serverState.books : [];
  const error = serverState.city === city ? serverState.error : '';
  const story = getCityStory(city);
  const generate = () => onNewBook({ city, initialStep: 2, guide: `想去${city}，请生成适合我的可信路书。` });

  return (
    <div className="page-enter pb-16">
      <section className="relative isolate overflow-hidden bg-[#1c2230] text-white">
        <CityBackdrop city={city} />
        <div
          className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(10,12,16,.62)_0%,rgba(10,12,16,.58)_45%,rgba(10,12,16,.88)_100%)]"
          aria-hidden="true"
        />
        <div className="mx-auto flex min-h-[360px] max-w-[1200px] flex-col justify-between gap-8 px-4 pt-5 pb-8 lg:min-h-[440px] lg:px-8 lg:pb-12">
          <Button variant="glass" size="sm" className="self-start" onClick={onBack}>
            <ArrowLeft /> 返回首页
          </Button>
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs font-bold text-white backdrop-blur">
              <MapPin className="size-3.5" aria-hidden="true" /> {openForGeneration ? story.kicker : `${city} · 暂未开放生成`}
            </span>
            <h1 className="mt-3 text-4xl leading-tight font-black tracking-tight text-white lg:text-6xl">{city}</h1>
            <p className="mt-3 max-w-xl text-copy leading-relaxed text-white lg:text-lg">
              {openForGeneration ? story.summary : `内测阶段优先打磨上海、江苏、浙江的目的地资料，${city}的路书生成与地点核对将在后续开放。`}
            </p>
            {openForGeneration ? (
              <>
                <div className="mt-4 flex flex-wrap gap-2 text-meta font-semibold">
                  <HeroFact icon={ShieldCheck}>{trustedCities.includes(city) ? '核心地点与定位已核对' : '支持粘贴攻略生成草稿'}</HeroFact>
                  <HeroFact icon={Camera}>真实评价仅采信到场打卡</HeroFact>
                  <HeroFact icon={Route}>
                    {serverBooks.length ? `公开路线 ${serverBooks.length} 条 · ` : ''}精选路线 {curated.length} 条
                  </HeroFact>
                </div>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Button size="lg" variant="primary" onClick={generate}>
                    <Sparkles /> 生成我的{city}路书
                  </Button>
                  <Button size="lg" variant="glass" onClick={() => onNewBook({ city, initialStep: 1, guide: '' })}>
                    <Link2 /> 导入攻略链接
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1200px] px-4 pt-8 lg:px-8 lg:pt-12">
        {!openForGeneration ? (
          <div className="rounded-panel border border-line bg-white p-6 shadow-card lg:p-8">
            <Notice tone="warn" role="status">
              内测期间先开放江浙沪的城市（上海、江苏、浙江），{city}暂时还不能生成。
            </Notice>
            {onOpenDestination && (
              <div className="mt-5">
                <p className="text-meta font-semibold text-ink-2">可以先去已开放的目的地看看：</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {trustedCities.map((item) => (
                    <Button key={item} size="sm" variant="outline" onClick={() => onOpenDestination(item)}>
                      {item} <ArrowRight />
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {error && (
              <p role="status" className="mb-4 rounded-tile bg-lemon-soft px-4 py-3 text-sm font-semibold text-lemon-ink">
                用户路线暂时读不到，先看编辑精选。（{error}）
              </p>
            )}

            <section aria-labelledby="dest-routes">
              <SectionHeading
                id="dest-routes"
                kicker={`${city} · 推荐路线`}
                title="编辑精选 + 用户保存路线"
                action={
                  <Button size="sm" variant="outline" onClick={() => onNewBook({ city })}>
                    <Plus /> 新建路书
                  </Button>
                }
              />
              {curated.length || serverBooks.length ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {curated.map((route) => {
                    const book = curatedRouteToRoutebook(route);
                    return (
                      <RouteCard
                        key={route.id}
                        routebook={book}
                        image={route.image}
                        tags={route.tags}
                        curated
                        meta={route.subtitle}
                        onOpen={() => onOpenBook(book)}
                        actions={
                          <Button size="sm" variant="dark" onClick={() => onOpenBook(book)}>
                            <Route /> 看路书
                          </Button>
                        }
                      />
                    );
                  })}
                  {serverBooks.map((book, idx) => (
                    <RouteCard
                      key={book.publicId ?? `${book.title}-${idx}`}
                      routebook={book}
                      meta={`${book.stops?.length ?? 0} 站 · 用户保存`}
                      onOpen={() => onOpenBook(book)}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-panel border border-dashed border-line-strong bg-white p-6 text-center lg:p-10">
                  <EmptyArt
                    className="w-56"
                    fallback={
                      <span className="mx-auto grid size-14 place-items-center rounded-full bg-primary-soft text-primary-strong">
                        <MapPin className="size-7" aria-hidden="true" />
                      </span>
                    }
                  />
                  <h3 className="mt-4 text-xl font-extrabold">{city} 还没有公开精选路线</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted">
                    这座城市还没人走过。粘贴小红书、抖音或公开网页的攻略链接，先生成你的路书；你出发打卡后，路线会更可信。
                  </p>
                  <Button
                    className="mt-5"
                    variant="primary"
                    onClick={() => onNewBook({ city, initialStep: 1, guide: `想去${city}，请基于我后续粘贴的攻略生成可信路书。` })}
                  >
                    <Sparkles /> 导入攻略生成{city}路书
                  </Button>
                  {onOpenDestination && (
                    <div className="mt-6">
                      <p className="text-meta font-semibold text-ink-2">或先去已核对的目的地看看：</p>
                      <div className="mt-2 flex flex-wrap justify-center gap-2">
                        {trustedCities
                          .filter((item) => item !== city)
                          .map((item) => (
                            <Button key={item} size="sm" variant="outline" onClick={() => onOpenDestination(item)}>
                              {item} <ArrowRight />
                            </Button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {photos.length > 0 && (
              <section aria-labelledby="dest-photos" className="mt-12">
                <SectionHeading id="dest-photos" kicker="目的地图集" title="和地点对得上的灵感图" />
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                  {photos.map((photo) => (
                    <figure key={`${photo.poi}-${photo.title}`} className="group relative isolate aspect-[4/3] overflow-hidden rounded-card bg-canvas">
                      <img
                        src={smallImage(photo.image)}
                        alt={`${photo.poi} ${photo.title}`}
                        loading="lazy"
                        className="absolute inset-0 -z-10 size-full object-cover"
                      />
                      <figcaption className="absolute inset-x-0 bottom-0 bg-[linear-gradient(180deg,rgba(10,12,16,0)_0%,rgba(10,12,16,.74)_45%,rgba(10,12,16,.9)_100%)] p-3 pt-8 text-white">
                        <strong className="block text-sm font-extrabold text-white">{photo.title}</strong>
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-white">
                          <MapPin className="size-3" aria-hidden="true" /> {photo.poi} · {photo.source}
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** @param {Record<string, any>} props */
function HeroFact({ icon: Icon, children }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-white backdrop-blur">
      <Icon className="size-3.5" aria-hidden="true" /> {children}
    </span>
  );
}

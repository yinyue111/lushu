import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, Link2, MapPin, Plus, Route, ShieldCheck, Sparkles } from 'lucide-react';
import { getCityPhotos, getCityRoutes, getCityStory, curatedRouteToRoutebook, trustedCities } from '../../lib/content';
import { getRoutebooksByCity } from '../../lib/api';
import { Button } from '../ui/button';
import { SectionHeading } from '../ui/section-heading';
import { RouteCard } from '../cards/RouteCard';
import { CityBackdrop } from '../visual/CityBackdrop';
import { hasCityPhotos } from '../visual/theme';

/** @param {Record<string, any>} props */
export default function DestinationPage({ city, onBack, onOpenBook, onNewBook, onOpenDestination }) {
  const [serverState, setServerState] = useState({ city: '', books: [], error: '' });
  const requestSequence = useRef(0);
  const serverBooks = serverState.city === city ? serverState.books : [];
  const error = serverState.city === city ? serverState.error : '';
  const story = getCityStory(city);
  const curated = useMemo(() => getCityRoutes(city), [city]);
  const photos = useMemo(() => (hasCityPhotos(city) ? getCityPhotos(city) : []), [city]);

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

  const generate = () => onNewBook({ city, guide: `想去${city}，请生成适合我的可信路书。` });

  return (
    <div className="page-enter pb-16">
      <section className="relative isolate overflow-hidden text-white">
        <CityBackdrop city={city} />
        <div
          className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(10,12,16,.35)_0%,rgba(10,12,16,.1)_40%,rgba(10,12,16,.8)_100%)]"
          aria-hidden="true"
        />
        <div className="mx-auto flex min-h-[360px] max-w-[1200px] flex-col justify-between gap-8 px-4 pt-5 pb-8 lg:min-h-[440px] lg:px-8 lg:pb-12">
          <Button variant="glass" size="sm" className="self-start" onClick={onBack}>
            <ArrowLeft /> 返回首页
          </Button>
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-bold backdrop-blur">
              <MapPin className="size-3.5" aria-hidden="true" /> {story.kicker}
            </span>
            <h1 className="mt-3 text-4xl leading-tight font-black tracking-tight lg:text-6xl">{city}</h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-white/90 lg:text-lg">{story.summary}</p>
            <div className="mt-4 flex flex-wrap gap-2 text-[13px] font-semibold">
              <HeroFact icon={ShieldCheck}>编辑样板 · 待真实验证</HeroFact>
              <HeroFact icon={Camera}>真实数据来自有效 GPS 打卡</HeroFact>
              <HeroFact icon={Route}>
                {serverBooks.length ? `公开路线 ${serverBooks.length} 条 · ` : ''}编辑样板 {curated.length} 条
              </HeroFact>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button size="lg" variant="primary" onClick={generate}>
                <Sparkles /> 生成我的{city}路书
              </Button>
              <Button size="lg" variant="glass" onClick={() => onNewBook({ city, guide: `想去${city}，请基于我后续粘贴的攻略生成可信路书。` })}>
                <Link2 /> 导入攻略链接
              </Button>
            </div>
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-[1200px] px-4 pt-8 lg:px-8 lg:pt-12">
        {error && (
          <p role="status" className="mb-4 rounded-tile bg-lemon-soft px-4 py-3 text-sm font-semibold text-lemon-ink">
            服务端路线暂时读不到，先展示编辑精选。（{error}）
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
              <span className="mx-auto grid size-14 place-items-center rounded-full bg-primary-soft text-primary-strong">
                <MapPin className="size-7" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-xl font-extrabold">{city} 还没有公开精选路线</h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted">
                这里还缺真实执行数据。粘贴小红书、抖音、X 或公众号攻略链接，先生成你的个人路书；出行打卡后，它会变成更可信的路线。
              </p>
              <Button className="mt-5" variant="primary" onClick={() => onNewBook({ city, guide: `想去${city}，请基于我后续粘贴的攻略生成可信路书。` })}>
                <Sparkles /> 导入攻略生成{city}路书
              </Button>
              {onOpenDestination && (
                <div className="mt-6">
                  <p className="text-[13px] font-semibold text-muted">或先去已验证的目的地看看：</p>
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
                    src={photo.image}
                    alt={`${photo.poi} ${photo.title}`}
                    loading="lazy"
                    className="absolute inset-0 -z-10 size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                  />
                  <figcaption className="absolute inset-x-0 bottom-0 bg-[linear-gradient(180deg,transparent,rgba(10,12,16,.78))] p-3 pt-8 text-white">
                    <strong className="block text-sm font-extrabold">{photo.title}</strong>
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-white/85">
                      <MapPin className="size-3" aria-hidden="true" /> {photo.poi} · {photo.source}
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

/** @param {Record<string, any>} props */
function HeroFact({ icon: Icon, children }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-black/30 px-3 py-1.5 backdrop-blur">
      <Icon className="size-3.5" aria-hidden="true" /> {children}
    </span>
  );
}

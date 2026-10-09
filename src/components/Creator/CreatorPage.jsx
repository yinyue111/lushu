import { useEffect, useState } from 'react';
import { ArrowLeft, Camera, Copy, Route, ShieldCheck, ShieldQuestion, Ticket } from 'lucide-react';
import { getCreatorProfile } from '../../lib/api';
import { getRouteTrustBadgeState } from '../../lib/trust';
import { publishStatusLabel, sourceAuthorizationLabel } from '../ui/labels';
import { Button } from '../ui/button';
import { RouteCard } from '../cards/RouteCard';
import { cn } from '../ui/cn';
import { EmptyArt } from '../visual/EmptyArt';
import { SectionHeading } from '../ui/section-heading';

/** @param {Record<string, any>} props */
export default function CreatorPage({ creatorId, onBack, onOpenBook, onCustomize }) {
  const [state, setState] = useState({ loading: true, error: '', data: null });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ loading: true, error: '', data: null });
    getCreatorProfile(creatorId, ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ loading: false, error: '', data: data.profile });
      })
      .catch((error) => {
        if (!ctrl.signal.aborted) setState({ loading: false, error: error.message, data: null });
      });
    return () => ctrl.abort();
  }, [creatorId]);

  if (state.loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4" role="status">
        <div className="flex flex-col items-center gap-3 text-muted">
          <Route className="size-7 animate-pulse text-primary" aria-hidden="true" />
          <p className="text-sm font-semibold">正在读取达人的路线合集...</p>
        </div>
      </div>
    );
  }

  if (state.error || !state.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4">
        <div className="max-w-sm rounded-panel border border-line bg-white p-6 text-center shadow-card">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-primary-soft text-primary-strong">
            <Route className="size-6" aria-hidden="true" />
          </span>
          <h1 className="mt-3 text-xl font-extrabold">达人主页暂时打不开</h1>
          <p className="mt-1 text-sm text-muted">{state.error || '达人不存在或还没发布路线'}</p>
          <Button variant="outline" className="mt-4" onClick={onBack}>
            <ArrowLeft /> 返回
          </Button>
        </div>
      </div>
    );
  }

  const { creator, stats, routebooks } = state.data;
  const visibleRoutebooks = (routebooks ?? []).filter((book) => book.publishStatus !== 'archived');
  const verifiedScores = visibleRoutebooks
    .map((book) => getRouteTrustBadgeState(book))
    .filter((trustState) => trustState.verified)
    .map((trustState) => trustState.score);
  const verifiedAverage = verifiedScores.length ? Math.round(verifiedScores.reduce((sum, score) => sum + score, 0) / verifiedScores.length) : null;

  return (
    <div className="page-enter pb-16">
      <section className="relative isolate overflow-hidden bg-[linear-gradient(135deg,#e8553d_0%,#d9822b_45%,#ffc93c_100%)] text-white">
        <Route className="absolute -right-10 -bottom-14 -z-10 size-72 text-white/10" strokeWidth={1} aria-hidden="true" />
        <div className="mx-auto max-w-[1200px] px-4 pt-5 pb-8 lg:px-8 lg:pb-10">
          <Button variant="glass" size="sm" onClick={onBack}>
            <ArrowLeft /> 返回平台
          </Button>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <span
              className="grid size-20 shrink-0 place-items-center rounded-full border-4 border-white/70 bg-white text-3xl font-black text-primary-strong shadow-pop"
              aria-hidden="true"
            >
              {creator.name?.slice(0, 1) || '路'}
            </span>
            <div className="min-w-0">
              <span className="inline-flex rounded-full bg-black/20 px-2.5 py-0.5 text-xs font-bold backdrop-blur">
                {sourceAuthorizationLabel(creator.sourceAuthorization)}
              </span>
              <h1 className="mt-1.5 text-3xl font-black tracking-tight lg:text-4xl">{creator.name || creator.id}</h1>
              <p className="mt-1 max-w-xl text-copy text-white/90">{creator.bio || 'TA 公开的路线都在这里，附带别人保存、复制和打卡的次数。'}</p>
            </div>
          </div>
          <dl className={cn('mt-6 grid grid-cols-3 gap-2.5 lg:max-w-3xl', stats.clickCount > 0 && 'grid-cols-2 sm:grid-cols-4')}>
            <Stat icon={Route} label="公开路线" value={stats.routebookCount ?? visibleRoutebooks.length} />
            <Stat icon={Copy} label="被复制" value={stats.copyCount ?? 0} />
            <Stat icon={Camera} label="有效打卡" value={stats.validCheckins ?? 0} />
            {stats.clickCount > 0 && <Stat icon={Ticket} label="商品点击" value={stats.clickCount} />}
          </dl>
        </div>
      </section>

      <div className="mx-auto max-w-[1200px] px-4 pt-8 lg:px-8 lg:pt-10">
        <SectionHeading
          kicker="路线合集"
          title={`${creator.name || '达人'} 的路线`}
          action={
            <span
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${verifiedAverage === null ? 'bg-sky-soft text-sky-ink' : 'bg-success-soft text-success-ink'}`}
            >
              {verifiedAverage === null ? <ShieldQuestion className="size-3.5" aria-hidden="true" /> : <ShieldCheck className="size-3.5" aria-hidden="true" />}
              {verifiedAverage === null ? '真实可信均分待验证' : `真实可信均分 ${verifiedAverage}`}
            </span>
          }
        />
        {visibleRoutebooks.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleRoutebooks.map((book) => (
              <RouteCard
                key={book.publicId || book.title}
                routebook={book}
                meta={`${book.city || '目的地'} · 被复制 ${book.copyCount ?? 0} 次 · ${publishStatusLabel(book.publishStatus)}`}
                onOpen={() => onOpenBook(book)}
                actions={
                  <>
                    <Button size="sm" variant="dark" onClick={() => onOpenBook(book)}>
                      <Route /> 看路书
                    </Button>
                    <Button size="sm" variant="ghost" className="text-sky-ink" onClick={() => onCustomize(book)}>
                      生成我的定制版
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        ) : (
          <div className="rounded-panel border border-dashed border-line-strong bg-white p-6 text-center">
            <EmptyArt />
            <p className="mt-2 text-sm text-muted">这位达人还没有公开路线。</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Stat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-tile bg-white/20 p-3 backdrop-blur">
      <dt className="flex items-center gap-1.5 text-xs font-semibold text-white/90">
        <Icon className="size-3.5" aria-hidden="true" /> {label}
      </dt>
      <dd className="num mt-0.5 text-2xl font-black">{value}</dd>
    </div>
  );
}

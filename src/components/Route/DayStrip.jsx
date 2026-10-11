import { useRef } from 'react';
import { ChevronLeft, ChevronRight, Route as RouteIcon, Trash2, GitMerge } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { dayCover, smallImage } from '../visual/theme';

/** "每天怎么玩" — horizontally scrolling day cards acting as day tabs. */
export default function DayStrip({ city, dayEntries, activeDay, onSelectDay, canEdit = false, onDeleteDay, onMergeDay }) {
  const scrollerRef = useRef(null);
  const scrollBy = (direction) => scrollerRef.current?.scrollBy({ left: direction * scrollerRef.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <section aria-labelledby="day-strip-title">
      <div className="mt-6 mb-3 flex items-baseline justify-between lg:mt-8 lg:mb-3.5">
        <h2 id="day-strip-title" className="text-xl font-extrabold tracking-tight lg:text-2xl">
          每天怎么玩
        </h2>
        {dayEntries.length > 2 && (
          <div className="hidden gap-2 sm:flex">
            <Button size="icon-sm" onClick={() => scrollBy(-1)} aria-label="向左滚动">
              <ChevronLeft />
            </Button>
            <Button size="icon-sm" onClick={() => scrollBy(1)} aria-label="向右滚动">
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="按天查看"
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto px-4 pt-1.5 pb-2.5 sm:mx-[-4px] sm:gap-3.5 sm:px-1"
      >
        {dayEntries.map((entry) => {
          const selected = entry.day === activeDay;
          const cover = dayCover(city, entry.index);
          return (
            <div key={entry.day} className="relative shrink-0 snap-start">
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onSelectDay(entry.day)}
                className={cn(
                  'relative isolate flex h-32 w-[200px] flex-col justify-end overflow-hidden rounded-card px-3.5 py-3 text-left text-white transition-transform duration-300 ease-(--ease-spring) hover:-translate-y-[3px] sm:h-[150px] sm:w-[calc((100%-28px)/3)] sm:min-w-[220px] sm:px-4 sm:py-3.5',
                  selected && 'shadow-[0_0_0_3px_#fff,0_0_0_6px_var(--color-primary),var(--shadow-pop)]'
                )}
                style={cover ? undefined : { backgroundImage: `linear-gradient(135deg, ${entry.theme.from}, ${entry.theme.to})` }}
              >
                {cover ? (
                  <img src={smallImage(cover)} alt="" loading="lazy" className="absolute inset-0 -z-20 size-full object-cover" />
                ) : (
                  <RouteIcon className="absolute -top-2 -right-3 -z-10 size-28 text-white/15" strokeWidth={1.5} aria-hidden="true" />
                )}
                <span className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(0,0,0,0)_25%,rgba(0,0,0,.7))]" aria-hidden="true" />
                <span className="num absolute top-3 left-3 inline-flex h-7 items-center rounded-full px-3 text-sm" style={{ background: entry.theme.ink }}>
                  DAY {entry.number}
                </span>
                <b className="line-clamp-1 text-lead leading-tight font-extrabold sm:text-xl">{entry.label}</b>
                <span className="text-meta text-white/92 sm:text-sm">{entry.summary}</span>
              </button>
              {canEdit && dayEntries.length > 1 && selected && (
                <div className="absolute top-2 right-2 z-10 flex gap-1">
                  {dayEntries.length > 1 && (
                    <Button
                      size="icon-sm"
                      variant="light"
                      className="size-8 bg-white/90"
                      aria-label={`合并 ${entry.day}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onMergeDay?.(entry.day);
                      }}
                    >
                      <GitMerge className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    variant="light"
                    className="size-8 bg-white/90 text-danger"
                    aria-label={`删除 ${entry.day}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteDay?.(entry.day);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

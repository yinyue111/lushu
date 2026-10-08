import { MapPin, Route as RouteIcon } from 'lucide-react';
import { cn } from '../ui/cn';
import { cityCover, dayTheme } from '../visual/theme';
import { TrustChip } from './TrustChip';

/**
 * Route card used on home / destination / my / creator pages. Uses the route's
 * own cover image when present, otherwise the city photo, otherwise a gradient.
 */
/** @param {Record<string, any>} props */
export function RouteCard({ routebook, image, tags = [], meta, curated = false, onOpen, actions, className, layout = 'tall' }) {
  const cover = image || cityCover(routebook.city);
  const theme = dayTheme(Math.abs(hashCode(routebook.city || routebook.title || '')) % 5);
  const stopCount = routebook.stops?.length ?? 0;
  return (
    <article
      className={cn(
        'group relative flex overflow-hidden rounded-card border border-line bg-white shadow-card transition-[transform,box-shadow] duration-300 ease-(--ease-spring) hover:-translate-y-1 hover:shadow-pop',
        layout === 'tall' ? 'flex-col' : 'flex-row',
        className
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className={cn('relative isolate shrink-0 overflow-hidden text-left', layout === 'tall' ? 'aspect-[16/10] w-full' : 'w-28 sm:w-36')}
        aria-label={`打开 ${routebook.title || '路书'}`}
        style={cover ? undefined : { backgroundImage: `linear-gradient(135deg, ${theme.from}, ${theme.to})` }}
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="absolute inset-0 -z-10 size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        ) : (
          <RouteIcon className="absolute -right-4 -bottom-4 -z-10 size-28 text-white/20" strokeWidth={1.5} aria-hidden="true" />
        )}
        {layout === 'tall' && (
          <span className="absolute top-3 left-3">
            <TrustChip routebook={routebook} curated={curated} className="bg-white/95 shadow-card" />
          </span>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-4">
        {layout !== 'tall' && <TrustChip routebook={routebook} curated={curated} className="self-start" />}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.slice(0, 3).map((tag) => (
              <span key={tag} className="rounded-full bg-lemon-soft px-2 py-0.5 text-xs font-bold text-lemon-ink">
                {tag}
              </span>
            ))}
          </div>
        )}
        <h3 className="line-clamp-2 text-[17px] leading-snug font-extrabold">
          <button type="button" onClick={onOpen} className="text-left hover:text-primary-strong">
            {routebook.title || `${routebook.city} 路书`}
          </button>
        </h3>
        {routebook.summary && <p className="line-clamp-2 text-sm text-muted">{routebook.summary}</p>}
        <p className="mt-auto flex items-center gap-1 pt-1 text-[13px] font-semibold text-ink-2">
          <MapPin className="size-3.5 text-primary-strong" aria-hidden="true" />
          {meta || `${routebook.city || '目的地'}${stopCount ? ` · ${stopCount} 站` : ''}`}
        </p>
        {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </article>
  );
}

function hashCode(text) {
  let hash = 0;
  for (const char of String(text)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash;
}

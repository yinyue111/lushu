import { cn } from '../ui/cn';
import { Illustration } from './Illustration';
import { stopCategory, stopPhoto } from './theme';

/**
 * Stop image tile. Shows the stop's own photo when the data has one; otherwise a
 * category illustration labelled as such (falls back to a gradient + lucide icon
 * if the illustration cannot load) — never a borrowed photo.
 * @param {Record<string, any>} props
 */
export function StopThumb({ stop, number, time, color = '#e8553d', className, compact = false }) {
  const photo = stopPhoto(stop);
  const category = stopCategory(stop);
  const Icon = category.icon;
  return (
    <div
      className={cn('@container relative isolate overflow-hidden rounded-tile', className)}
      style={photo ? undefined : { backgroundImage: `linear-gradient(135deg, ${category.from}, ${category.to})` }}
    >
      {photo ? (
        <img src={photo} alt="" className="absolute inset-0 -z-10 size-full object-cover" loading="lazy" />
      ) : (
        <>
          <Icon aria-hidden="true" className="absolute -right-3 -bottom-3 -z-20 size-20 text-white/25" strokeWidth={1.5} />
          {!compact && !category.illustration && (
            <span className="absolute inset-x-2 top-1/2 line-clamp-2 -translate-y-1/2 text-center text-[13px] leading-tight font-bold text-white/95 drop-shadow-sm">
              <Icon aria-hidden="true" className="mx-auto mb-1 size-6" />
              {category.label}
            </span>
          )}
          <Illustration
            src={category.illustration}
            alt={`${category.label}类地点插画`}
            sizes="(min-width: 1024px) 360px, 60vw"
            className="absolute inset-0 -z-10 size-full object-cover"
          />
          {!compact && category.illustration && (
            <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-ink/60 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur-sm">
              <Icon aria-hidden="true" className="hidden size-3 @[9rem]:block" />
              <span className="hidden @[9rem]:inline">{category.label}</span>插画
            </span>
          )}
        </>
      )}
      {number != null && (
        <span
          className={cn(
            'num absolute top-2 left-2 grid place-items-center rounded-full border-2 border-white text-white',
            compact ? 'size-6 text-xs' : 'size-[30px] text-[15px]'
          )}
          style={{ background: color }}
        >
          {number}
        </span>
      )}
      {time && !compact && (
        <span className="num absolute bottom-2 left-2 inline-flex h-[26px] items-center rounded-full bg-ink/75 px-2.5 text-sm text-white backdrop-blur-sm">
          {time}
        </span>
      )}
    </div>
  );
}

import { cn } from '../ui/cn';
import { SceneBadge, SceneImage } from './SceneImage';
import { stopCategory, stopPhoto } from './theme';

/**
 * Stop image tile. Shows the stop's own photo when the data has one; otherwise a
 * generic category scene labelled 「示意图」 (falls back to a gradient + lucide icon
 * if it cannot load) — never presented as a photo of this stop.
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
          <SceneImage
            src={category.scene}
            alt={`${category.label}类地点示意图（AI 生成）`}
            sizes="(min-width: 1024px) 360px, 60vw"
            className="absolute inset-0 -z-10 size-full object-cover"
            fallback={
              !compact && (
                <span className="absolute inset-x-2 top-1/2 line-clamp-2 -translate-y-1/2 text-center text-meta leading-tight font-bold text-white/95 drop-shadow-sm">
                  <Icon aria-hidden="true" className="mx-auto mb-1 size-6" />
                  {category.label}
                </span>
              )
            }
            badge={
              !compact && (
                <SceneBadge className="top-2 right-2">
                  <Icon aria-hidden="true" className="hidden size-3 @[9rem]:block" />
                  <span className="@[9rem]:hidden">示意</span>
                  <span className="hidden @[9rem]:inline">{category.label}示意图</span>
                </SceneBadge>
              )
            }
          />
        </>
      )}
      {number != null && (
        <span
          className={cn(
            'num absolute top-2 left-2 grid place-items-center rounded-full border-2 border-white text-white',
            compact ? 'size-6 text-xs' : 'size-[30px] text-copy'
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

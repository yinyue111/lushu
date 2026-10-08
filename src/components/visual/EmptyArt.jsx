import { cn } from '../ui/cn';
import { SceneImage } from './SceneImage';
import { EMPTY_SCENE } from './theme';

/**
 * Empty-state image (map + compass flat-lay). `fallback` (usually the
 * old icon bubble) renders if the asset cannot load.
 * @param {Record<string, any>} props
 */
export function EmptyArt({ className, fallback = null }) {
  return (
    <SceneImage
      src={EMPTY_SCENE}
      sizes="240px"
      fallback={fallback}
      className={cn('mx-auto block aspect-[4/3] h-auto w-48 rounded-tile object-cover', className)}
    />
  );
}

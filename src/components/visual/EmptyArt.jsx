import { cn } from '../ui/cn';
import { Illustration } from './Illustration';
import { EMPTY_ILLUSTRATION } from './theme';

/**
 * Empty-state spot illustration (folded map + empty pin). `fallback` (usually the
 * old icon bubble) renders if the asset cannot load.
 * @param {Record<string, any>} props
 */
export function EmptyArt({ className, fallback = null }) {
  return <Illustration src={EMPTY_ILLUSTRATION} sizes="240px" fallback={fallback} className={cn('mx-auto block h-auto w-44', className)} />;
}

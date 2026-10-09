import { useState } from 'react';
import { cn } from '../ui/cn';
import { heroImageProps } from './theme';

/**
 * Bundled AI-generated generic scene (never a photo of the specific place). Renders
 * `fallback` (default nothing) if the asset fails to load, so the caller's
 * gradient + icon shows through. `badge` is only rendered while the image is in use.
 * @param {Record<string, any>} props
 */
export function SceneImage({ src, alt = '', sizes = '100vw', className, loading = 'lazy', fallback = null, badge = null, ...rest }) {
  const [failedSrc, setFailedSrc] = useState(null);
  if (!src || failedSrc === src) return fallback;
  return (
    <>
      <img
        {...heroImageProps(src)}
        sizes={sizes}
        alt={alt}
        className={className}
        loading={loading}
        decoding="async"
        onError={() => setFailedSrc(src)}
        {...rest}
      />
      {badge}
    </>
  );
}

/**
 * 「示意图」 label for AI-generated scene images.
 * @param {Record<string, any>} props
 */
export function SceneBadge({ className, children = '示意图' }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute z-10 inline-flex items-center gap-1 rounded-full bg-ink/60 px-2 py-0.5 text-tag font-bold text-white backdrop-blur-sm',
        className
      )}
    >
      {children}
    </span>
  );
}

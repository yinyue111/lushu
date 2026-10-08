import { useState } from 'react';
import { heroImageProps } from './theme';

/**
 * Bundled illustration (never a photo of a real place). Renders nothing if the
 * asset fails to load (or `fallback`), so the caller's gradient + icon shows through.
 * @param {Record<string, any>} props
 */
export function Illustration({ src, alt = '', sizes = '100vw', className, loading = 'lazy', fallback = null, ...rest }) {
  const [failedSrc, setFailedSrc] = useState(null);
  if (!src || failedSrc === src) return fallback;
  return (
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
  );
}

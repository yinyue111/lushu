import { useEffect, useRef, useState } from 'react';
import { fetchCheckinPhoto } from '../../lib/photoApi.js';
import { cn } from '../ui/cn';

/**
 * Authenticated image requests never put credentials into URLs. The in-memory
 * object URL is revoked on unmount or identity/photo change, and opens the same
 * authorised bytes when the user requests the full image.
 * @param {{photoId: string, profileId?: string, access?: 'owner'|'admin'|'public', alt: string, className?: string, imageClassName?: string}} props
 */
export function CheckinPhoto({ photoId, profileId = '', access = 'public', alt, className = '', imageClassName = '' }) {
  const root = useRef(null);
  const [visible, setVisible] = useState(false);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState({ key: '', url: '', error: '' });
  const key = `${access}:${profileId}:${photoId}:${retry}`;

  useEffect(() => {
    if (!globalThis.IntersectionObserver) {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    const controller = new AbortController();
    let objectUrl = '';
    setState({ key, url: '', error: '' });
    fetchCheckinPhoto(photoId, { profileId, access, signal: controller.signal })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ key, url: objectUrl, error: '' });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ key, url: '', error: error.message });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [access, key, photoId, profileId, visible]);

  const current = state.key === key ? state : { url: '', error: '' };
  return (
    <span ref={root} className={cn('inline-block overflow-hidden rounded-tile', className)}>
      {current.url ? (
        <a href={current.url} target="_blank" rel="noopener noreferrer" title={`打开${alt}`} className="block h-full w-full">
          <img src={current.url} alt={alt} className={cn('h-full w-full object-cover', imageClassName)} />
        </a>
      ) : current.error ? (
        <button
          type="button"
          title={current.error}
          onClick={() => setRetry((value) => value + 1)}
          className="grid h-full min-h-11 w-full place-items-center bg-canvas p-1 text-xs text-muted"
        >
          照片不可用
          <br />
          点击重试
        </button>
      ) : (
        <span className="grid h-full min-h-11 w-full place-items-center bg-canvas text-xs text-muted" role="status" aria-label={`正在读取${alt}`}>
          读取照片…
        </span>
      )}
    </span>
  );
}

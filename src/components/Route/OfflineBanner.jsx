import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { offlineBannerText } from '../../lib/offlineBanner.js';

export function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export default function OfflineBanner({ routebook }) {
  const online = useOnline();
  if (online) return null;
  return (
    <p
      role="status"
      className="sticky top-0 z-[20] flex items-center justify-center gap-2 bg-lemon-soft px-4 py-2 text-center text-sm font-medium text-lemon-ink"
    >
      <WifiOff aria-hidden="true" className="size-4 shrink-0" />
      {offlineBannerText(routebook)}
    </p>
  );
}

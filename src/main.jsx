import { createRoot } from 'react-dom/client';
import App from './App';
import 'leaflet/dist/leaflet.css';
import './styles/tailwind.css';

createRoot(document.getElementById('root')).render(<App />);

// Development never installs a worker; production caches only the static shell,
// not account APIs, photos, or authenticated responses.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener(
    'load',
    () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' }).catch(() => {
        // Offline installation is optional; the normal online app remains usable.
      });
    },
    { once: true }
  );
}

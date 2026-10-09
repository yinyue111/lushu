import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { pwaPrecachePlugin } from './scripts/pwa-precache-plugin.mjs';

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaPrecachePlugin()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:5173',
        changeOrigin: false
      }
    }
  }
});

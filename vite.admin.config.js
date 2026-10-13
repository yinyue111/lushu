import process from 'node:process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Admin console: a separate entry so none of its code or API names ship in the user bundle.
// Served by Node at /admin/ only when ADMIN_ENABLED=true; no PWA / service worker on purpose.
export default defineConfig({
  root: 'admin',
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist-admin', emptyOutDir: true, sourcemap: 'hidden' },
  server: {
    host: '127.0.0.1',
    port: 5175,
    proxy: { '/api': { target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:5173', changeOrigin: false } }
  }
});

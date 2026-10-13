import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { pwaPrecachePlugin } from './scripts/pwa-precache-plugin.mjs';

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaPrecachePlugin()],
  // 生产构建生成 hidden source map（JS 里不留 sourceMappingURL）；构建后由 scripts/move-sourcemaps.mjs
  // 挪到 dist-sourcemaps/（不在静态目录里，外网拿不到），只给服务端/运营用 scripts/symbolicate.mjs 还原报错栈。
  build: { sourcemap: 'hidden' },
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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const SERVICE_WORKER_TEMPLATE_URL = new URL('../public/sw.js', import.meta.url);
const PWA_FIXED_ASSETS = ['manifest.webmanifest', 'icons/routebook-192.svg', 'icons/routebook-512.svg'];

export function pwaPrecachePlugin() {
  return {
    name: 'trusted-routebook-pwa-precache',
    apply: 'build',
    enforce: 'post',
    generateBundle(_outputOptions, bundle) {
      const template = readFileSync(SERVICE_WORKER_TEMPLATE_URL, 'utf8');
      const entries = Object.values(bundle)
        .filter((item) => item.type === 'chunk' || /\.css$/i.test(item.fileName))
        .map((item) => {
          const content = item.type === 'chunk' ? item.code : item.source;
          return {
            url: item.fileName,
            revision: createHash('sha256').update(content).digest('hex').slice(0, 16)
          };
        })
        .sort((a, b) => a.url.localeCompare(b.url));

      if (!entries.some((entry) => /\.js$/i.test(entry.url)) || !entries.some((entry) => /\.css$/i.test(entry.url))) {
        this.error('PWA precache manifest must include the Vite JavaScript and CSS build outputs.');
      }

      const fixedAssetRevisions = PWA_FIXED_ASSETS.map((url) => ({
        url,
        revision: createHash('sha256')
          .update(readFileSync(new URL(`../public/${url}`, import.meta.url)))
          .digest('hex')
          .slice(0, 16)
      }));
      // Every other file Vite emitted into the bundle is content-hashed too
      // (fonts, imported images). public/ files never appear in `bundle`.
      const precached = new Set(entries.map((entry) => entry.url));
      const hashedAssets = Object.values(bundle)
        .filter(
          (item) =>
            item.type === 'asset' &&
            !precached.has(item.fileName) &&
            !/\.html$/i.test(item.fileName) &&
            item.fileName !== 'sw.js' &&
            !/\.map$/i.test(item.fileName)
        )
        .map((item) => item.fileName)
        .sort();
      const revision = createHash('sha256')
        .update(template)
        .update(JSON.stringify(entries))
        .update(JSON.stringify(fixedAssetRevisions))
        .update(JSON.stringify(hashedAssets))
        .digest('hex')
        .slice(0, 16);
      const source = template
        .replace("'__PWA_CACHE_VERSION__'", JSON.stringify(`build-${revision}`))
        .replace('/* __PWA_PRECACHE_MANIFEST__ */ []', JSON.stringify(entries))
        .replace('/* __PWA_HASHED_ASSETS__ */ []', JSON.stringify(hashedAssets));

      if (source.includes('__PWA_CACHE_VERSION__') || source.includes('__PWA_PRECACHE_MANIFEST__') || source.includes('__PWA_HASHED_ASSETS__')) {
        this.error('PWA service-worker template placeholders were not fully replaced.');
      }
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    }
  };
}

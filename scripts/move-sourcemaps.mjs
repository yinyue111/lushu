// 构建后把 dist/ 里的 .map 挪到 dist-sourcemaps/（不在静态目录里，外网拿不到）。
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const OUT = new URL('../dist-sourcemaps/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
let moved = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.map')) {
      const target = join(OUT, relative(DIST, path));
      mkdirSync(join(target, '..'), { recursive: true });
      renameSync(path, target);
      moved += 1;
    }
  }
}
walk(DIST);
console.log(`[sourcemaps] moved ${moved} map file(s) to dist-sourcemaps/`);

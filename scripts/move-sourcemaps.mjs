// 构建后把 dist/ 和 dist-admin/ 里的 .map 挪到 dist-sourcemaps/{user,admin}/（不在静态目录里，外网拿不到），
// 只给服务端/运营用 scripts/symbolicate.mjs 还原报错栈。
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const OUT = join(ROOT, 'dist-sourcemaps');
const TARGETS = [
  { dir: join(ROOT, 'dist'), name: 'user' },
  { dir: join(ROOT, 'dist-admin'), name: 'admin' }
];
rmSync(OUT, { recursive: true, force: true });
for (const { dir, name } of TARGETS) {
  if (!existsSync(dir)) continue;
  let moved = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.map')) {
        const target = join(OUT, name, relative(dir, path));
        mkdirSync(join(target, '..'), { recursive: true });
        renameSync(path, target);
        moved += 1;
      }
    }
  };
  walk(dir);
  console.log(`[sourcemaps] moved ${moved} map file(s) from ${relative(ROOT, dir)}/ to dist-sourcemaps/${name}/`);
}

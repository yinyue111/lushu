// Build gate: the user bundle (dist/) must not contain admin API names, the script-token header, or the old
// ops panels, and no source maps may remain in any served directory. Exits non-zero on a leak.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const FORBIDDEN = ['/api/admin', 'x-routebook-admin-token', 'OpsConfigPanel', 'admin-token'];

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const problems = [];
const dist = join(ROOT, 'dist');
if (!existsSync(dist)) problems.push('dist/ does not exist: run vite build first');
for (const file of files(dist)) {
  if (file.endsWith('.map')) problems.push(`source map in dist: ${relative(ROOT, file)}`);
  if (!/\.(js|mjs|html)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8').toLowerCase();
  for (const needle of FORBIDDEN) if (text.includes(needle.toLowerCase())) problems.push(`${relative(ROOT, file)} contains "${needle}"`);
}
for (const file of files(join(ROOT, 'dist-admin'))) if (file.endsWith('.map')) problems.push(`source map in dist-admin: ${relative(ROOT, file)}`);

if (problems.length) {
  console.error(`[bundle-leaks] FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`[bundle-leaks] ok: ${files(dist).filter((f) => f.endsWith('.js')).length} user JS file(s) clean, no source maps served`);

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'data', 'coverage']);

// Small, dependency-free recursive file lister (Node 20 has no fs.glob).
export function listFiles(root, predicate, base = root) {
  const results = [];
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const fullPath = join(root, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      results.push(...listFiles(fullPath, predicate, base));
    } else if (predicate(relative(base, fullPath).split('\\').join('/'))) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

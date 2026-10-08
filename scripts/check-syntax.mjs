// Runs `node --check` over every server-side ESM file so CI catches syntax
// errors in files that no test happens to import.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listFiles } from './lib/list-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = listFiles(root, (path) => path === 'server.mjs' || /^(scripts|server|test)\/.+\.mjs$/.test(path));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(result.stderr || `node --check failed: ${file}\n`);
  }
}
if (failed) {
  console.error(`check:syntax failed for ${failed} file(s)`);
  process.exit(1);
}
console.log(`check:syntax ok (${files.length} files)`);

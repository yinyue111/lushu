// Collects test/**/*.test.mjs and hands them to the built-in node:test runner.
// (Node 20's `node --test <dir>` would also execute helper modules.)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listFiles } from './lib/list-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const filter = process.argv.slice(2);
const files = listFiles(root, (path) => /^test\/.+\.test\.mjs$/.test(path)).filter((file) => !filter.length || filter.some((item) => file.includes(item)));
if (!files.length) {
  console.error('No test files matched.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);

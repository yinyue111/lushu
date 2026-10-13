// 把前端报错栈（/assets/xxx.js:行:列）还原成源码位置。只在服务器上用，map 在 dist-sourcemaps/。
// 用法：node scripts/symbolicate.mjs "<stack 文本>"   或   echo "<stack>" | node scripts/symbolicate.mjs
import { existsSync, readFileSync } from 'node:fs';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const MAPS = new URL('../dist-sourcemaps/', import.meta.url).pathname;
const input = process.argv[2] ?? readFileSync(0, 'utf8');
const cache = new Map();
const mapFor = (file) => {
  if (!cache.has(file)) {
    const path = `${MAPS}assets/${file}.map`;
    cache.set(file, existsSync(path) ? new TraceMap(readFileSync(path, 'utf8')) : null);
  }
  return cache.get(file);
};
const out = input.replace(/\/assets\/([\w.-]+\.js):(\d+):(\d+)/g, (whole, file, line, column) => {
  const map = mapFor(file);
  if (!map) return `${whole} (no map)`;
  const pos = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 });
  return pos.source ? `${pos.source}:${pos.line}:${(pos.column ?? 0) + 1}${pos.name ? ` (${pos.name})` : ''}` : `${whole} (unmapped)`;
});
console.log(out);

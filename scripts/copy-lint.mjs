#!/usr/bin/env node
// copy-lint (V-U35): user-facing copy rules from docs/copy-style.md, checked on the AST so regex
// literals and comments never count. Only string literals, template text and JSX text are read.
//   - full-width 「！」 and 「您」 are blocked everywhere in src/
//   - half-width 「!」 is blocked only when it touches a Chinese character inside copy
//   - term rule: 验证/校验/审核/核验 are blocked in user UI (whitelist below; admin/ is not scanned)
// Escape hatch: `// copy-lint-ignore <reason>` (or {/* copy-lint-ignore <reason> */} in JSX) on the
// same line or the line above. The reason is mandatory; an empty reason is itself an error.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Paths under src/ that are data, not UI copy (guides, samples, fixtures). */
const SKIP_FILE = /(^|\/)(__tests__|test|tests)\/|\.test\.|\.spec\.|(^|\/)[^/]*(sample|fixture|seed|mock|guide-?data)[^/]*\.(js|jsx)$/i;

/** Allowed uses of the blocked terms; each documented in docs/copy-style.md. */
export const TERM_WHITELIST = [
  '验证邮箱', // account: verify e-mail address
  '验证码', // account: one-time code
  '邮箱未验证',
  '邮箱已验证',
  '未经法务审核' // Legal draft banner (privacy page), states legal review status literally
];
const TERM = /验证|校验|审核|核验/g;
/** Legal pages quote legal/regulatory processes literally (法务审核, 内容安全审核, 短信验证); term rule off there. */
const TERM_SKIP_FILE = /(^|\/)src\/components\/Legal\//;
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

function termHits(text) {
  let masked = text;
  for (const allowed of TERM_WHITELIST) masked = masked.split(allowed).join('\u0000'.repeat(allowed.length));
  return [...masked.matchAll(TERM)].map((m) => m[0]);
}

function checkText(text, { terms: checkTerms = true } = {}) {
  const problems = [];
  if (text.includes('！')) problems.push('全角「！」');
  if (text.includes('您')) problems.push('「您」→「你」');
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '!' && (CJK.test(text[i - 1] ?? '') || CJK.test(text[i + 1] ?? ''))) {
      problems.push('半角「!」紧挨中文');
      break;
    }
  }
  const terms = checkTerms ? termHits(text) : [];
  if (terms.length) problems.push(`术语「${[...new Set(terms)].join('/')}」→ 用「核对」或 v4 状态名`);
  return problems;
}

function ignoreState(lines, line) {
  for (const candidate of [lines[line - 1], lines[line - 2]]) {
    const m = /copy-lint-ignore(?:\s+([^*\n]*?))?\s*(?:\*\/\s*\}?)?\s*$/.exec(candidate ?? '');
    if (m) return (m[1] ?? '').trim() ? 'ignored' : 'missing-reason';
  }
  return 'none';
}

/** Lints one source text; returns [{ line, column, text, problems }]. Exported for tests. */
export function lintSource(code, filename = 'inline.jsx') {
  const checkTerms = !TERM_SKIP_FILE.test(filename.replace(/\\/g, '/'));
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true, sourceFilename: filename });
  const lines = code.split('\n');
  const findings = [];
  const seenIgnore = new Set();
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    let text = null;
    if (
      node.type === 'StringLiteral' &&
      !(parent?.type === 'ImportDeclaration' || parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportAllDeclaration') &&
      !(key === 'key' && (parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod'))
    )
      text = node.value;
    else if (node.type === 'TemplateElement') text = node.value.cooked ?? node.value.raw;
    else if (node.type === 'JSXText') text = node.value;
    if (text) {
      const problems = checkText(text, { terms: checkTerms });
      if (problems.length) {
        const line = node.loc.start.line;
        const state = ignoreState(lines, line);
        if (state === 'missing-reason' && !seenIgnore.has(line)) {
          seenIgnore.add(line);
          findings.push({ line, column: node.loc.start.column + 1, text: text.trim().slice(0, 60), problems: ['copy-lint-ignore 缺少理由'] });
        } else if (state === 'none') {
          findings.push({ line, column: node.loc.start.column + 1, text: text.trim().slice(0, 60), problems });
        }
      }
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === 'loc' || childKey === 'leadingComments' || childKey === 'trailingComments' || childKey === 'innerComments') continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, node, childKey));
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, node, childKey);
    }
  };
  visit(ast.program, null, null);
  return findings;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

export function lintTree(root = ROOT) {
  const files = walk(join(root, 'src')).filter((file) => !SKIP_FILE.test(relative(root, file)));
  const results = [];
  for (const file of files) for (const finding of lintSource(readFileSync(file, 'utf8'), file)) results.push({ file: relative(root, file), ...finding });
  return { files: files.length, results };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { files, results } = lintTree();
  for (const r of results) console.log(`${r.file}:${r.line}:${r.column}  ${r.problems.join('；')}  「${r.text}」`);
  console.log(`copy-lint: ${files} files, ${results.length} problem(s)`);
  process.exit(results.length ? 1 : 0);
}

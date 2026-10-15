import assert from 'node:assert/strict';
import test from 'node:test';
import { lintSource, lintTree } from '../../scripts/copy-lint.mjs';

const problems = (code, file) => lintSource(code, file).flatMap((f) => f.problems);

test('full-width ！ inside a regex literal is not copy', () => {
  assert.deepEqual(lintSource("const re = /[，。！？!]/g; const s = 'a'.replace(/(?!钱)!/, '');"), []);
});

test('您 in JSX text is reported', () => {
  const found = lintSource('export const A = () => <p>请您稍候</p>;');
  assert.equal(found.length, 1);
  assert.match(found[0].problems.join(), /您/);
});

test('full-width ！ in a string and half-width ! next to Chinese are reported; code ! is not', () => {
  assert.match(problems("const t = '好了！';").join(), /全角/);
  assert.match(problems('const t = `完成!`;').join(), /半角/);
  assert.deepEqual(problems("if (!ok && 'abc!' !== x) run('Hello!');"), []);
});

test('term rule with whitelist', () => {
  assert.match(problems("const t = '待验证';").join(), /术语/);
  assert.match(problems('const a = () => <span>提交审核</span>;').join(), /术语/);
  assert.deepEqual(problems("const t = '验证码发到邮箱了，去验证邮箱吧';"), []);
  assert.deepEqual(problems("const t = '内容安全审核';", '/x/src/components/Legal/PrivacyPage.jsx'), []);
});

test('copy-lint-ignore needs a reason', () => {
  assert.deepEqual(problems("const t = '您好'; // copy-lint-ignore 引用用户原话"), []);
  assert.deepEqual(problems("const t = '您好'; // copy-lint-ignore"), ['copy-lint-ignore 缺少理由']);
  assert.deepEqual(problems("// copy-lint-ignore 上一行说明理由\nconst t = '您好';"), []);
});

test('comments and imports are never linted', () => {
  assert.deepEqual(lintSource("// 您好！\n/* 待验证 */\nimport x from './您.js';"), []);
});

test('the current tree is clean', () => {
  const { files, results } = lintTree();
  assert.ok(files > 100);
  assert.deepEqual(results, []);
});

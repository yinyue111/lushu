import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHtmlBody, decodeHtmlEntities, detectCharset } from '../../server/import/html-text.mjs';

test('numeric entities: decimal, hex and astral code points (L7)', () => {
  assert.equal(decodeHtmlEntities('&#26477;&#24030;'), '杭州');
  assert.equal(decodeHtmlEntities('&#x676D;&#X5DDE;'), '杭州');
  assert.equal(decodeHtmlEntities('&#128512; &#x1F600;'), '😀 😀');
});

test('invalid code points become U+FFFD instead of throwing or producing lone surrogates', () => {
  assert.equal(decodeHtmlEntities('&#xD800;'), '\ufffd');
  assert.equal(decodeHtmlEntities('&#1114112;'), '\ufffd');
  assert.equal(decodeHtmlEntities('&#0;'), '\ufffd');
});

test('named entities decode in a single pass (no double decoding)', () => {
  assert.equal(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &apos;f&apos;'), 'a & b <c> "d" \'e\' \'f\'');
  assert.equal(decodeHtmlEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  assert.equal(decodeHtmlEntities('&unknown; & plain'), '&unknown; & plain');
  assert.equal(decodeHtmlEntities('&nbsp;&middot;&hellip;'), '\u00a0·…');
  assert.equal(decodeHtmlEntities(null), '');
});

const gbk = (text) => {
  // "杭州西湖" in GBK.
  if (text === '杭州西湖') return Buffer.from([0xba, 0xbc, 0xd6, 0xdd, 0xce, 0xf7, 0xba, 0xfe]);
  throw new Error('fixture');
};

test('charset from the Content-Type header', () => {
  const body = Buffer.concat([Buffer.from('<title>'), gbk('杭州西湖'), Buffer.from('</title>')]);
  assert.equal(detectCharset(body, 'text/html; charset=GBK'), 'gbk');
  assert.equal(decodeHtmlBody(body, 'text/html; charset=gb2312'), '<title>杭州西湖</title>');
});

test('charset from <meta> when the header has none', () => {
  const metaCharset = Buffer.concat([Buffer.from('<html><head><meta charset="gbk"><title>'), gbk('杭州西湖'), Buffer.from('</title>')]);
  assert.match(decodeHtmlBody(metaCharset, 'text/html'), /杭州西湖/);
  const httpEquiv = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">'), gbk('杭州西湖')]);
  assert.match(decodeHtmlBody(httpEquiv, ''), /杭州西湖/);
});

test('UTF-8 stays the default; BOM wins; unknown labels fall back to UTF-8', () => {
  assert.equal(decodeHtmlBody(Buffer.from('杭州'), 'text/html'), '杭州');
  assert.equal(detectCharset(Buffer.from([0xef, 0xbb, 0xbf, 0x41]), 'text/html; charset=gbk'), 'utf-8');
  assert.equal(detectCharset(Buffer.from('x'), 'text/html; charset=not-a-charset'), 'utf-8');
});

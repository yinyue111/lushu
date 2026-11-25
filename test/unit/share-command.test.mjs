import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanShareCommandForEditor,
  extractCleanUrls,
  hasActionableGuideInput,
  hasShareCommandWrapper,
  stripShareCommandBoilerplate
} from '../../src/lib/shareCommand.js';
import { extractUrls } from '../../server/import/source-page.mjs';

test('extractCleanUrls cleanly separates URLs from glued CJK text, brackets, and share boilerplate', () => {
  const xhs = '72 小王发布了一篇小红书笔记，快来看吧！ 😆 fJk89LmN0pQ 😆 http://xhslink.com/a/abc123XYZ，复制本条信息，打开【小红书】App查看精彩内容！';
  assert.deepEqual(extractCleanUrls(xhs), ['http://xhslink.com/a/abc123XYZ']);
  assert.deepEqual(extractUrls('看这篇 http://xhslink.com/m/9Xyz12【小红书】和 https://v.douyin.com/iYabc123/复制此链接'), [
    'http://xhslink.com/m/9Xyz12',
    'https://v.douyin.com/iYabc123/'
  ]);
  assert.deepEqual(extractCleanUrls('参考 (https://example.com/guide_(2026))。'), ['https://example.com/guide_(2026)']);
});

test('stripShareCommandBoilerplate removes Xiaohongshu & Douyin wrappers while keeping real titles and prose', () => {
  const pureBlockedXhs =
    '72 小王发布了一篇小红书笔记，快来看吧！ 😆 fJk89LmN0pQ 😆 http://xhslink.com/a/abc123XYZ，复制本条信息，打开【小红书】App查看精彩内容！';
  assert.equal(hasShareCommandWrapper(pureBlockedXhs), true);
  assert.equal(stripShareCommandBoilerplate(pureBlockedXhs), '');
  assert.equal(cleanShareCommandForEditor(pureBlockedXhs), 'http://xhslink.com/a/abc123XYZ');

  const titledXhs =
    '45 【杭州两天一夜西湖不走回头路攻略 | 小红书 - 你的生活指南】 😆 7xYzAbCdEf 😆 https://www.xiaohongshu.com/discovery/item/66a1b2c3 复制后打开【小红书】查看笔记！';
  assert.equal(stripShareCommandBoilerplate(titledXhs), '杭州两天一夜西湖不走回头路攻略');
  assert.equal(cleanShareCommandForEditor(titledXhs), '杭州两天一夜西湖不走回头路攻略\nhttps://www.xiaohongshu.com/discovery/item/66a1b2c3');

  const douyinCollage =
    '4.89 u@s.Rk 08/24 MwS:/ 杭州法喜寺到龙井村半日漫步路线 https://v.douyin.com/iYabc123/ 复制此链接，打开Douyin搜索，直接观看视频！\n\n7.12 复制打开抖音，看看【阿泽旅行的作品】南宋御街美食盘点 https://v.douyin.com/iNxyz89/ 长按复制此条消息，打开抖音搜索，查看TA的更多作品。';
  const cleanedForEditor = cleanShareCommandForEditor(douyinCollage);
  assert.match(cleanedForEditor, /杭州法喜寺到龙井村半日漫步路线/);
  assert.match(cleanedForEditor, /南宋御街美食盘点/);
  assert.doesNotMatch(cleanedForEditor, /复制此链接|长按复制|阿泽旅行的作品|u@s\.Rk/);
  assert.deepEqual(extractCleanUrls(cleanedForEditor), ['https://v.douyin.com/iYabc123/', 'https://v.douyin.com/iNxyz89/']);
});

test('hasActionableGuideInput rejects blocked share-command boilerplate without real content, allows screenshots or manual candidates', () => {
  const blockedShareCmd =
    '72 小王发布了一篇小红书笔记，快来看吧！ 😆 fJk89LmN0pQ 😆 http://xhslink.com/a/abc123XYZ，复制本条信息，打开【小红书】App查看精彩内容！\n\n来源 1｜小红书｜可信 28｜抓取失败\n标题：小红书 链接待补充\n可信信号：已识别链接来源\n风险提示：需登录\n链接：http://xhslink.com/a/abc123XYZ';
  assert.equal(
    hasActionableGuideInput({
      guide: blockedShareCmd,
      sources: [{ url: 'http://xhslink.com/a/abc123XYZ', status: 'unavailable', title: '登录后查看' }],
      candidates: [],
      ocrPlaces: []
    }),
    false
  );
  assert.equal(
    hasActionableGuideInput({
      guide: blockedShareCmd,
      sources: [{ url: 'http://xhslink.com/a/abc123XYZ', status: 'unavailable' }],
      candidates: [{ name: '法喜寺', included: true }],
      ocrPlaces: []
    }),
    true
  );
  assert.equal(
    hasActionableGuideInput({
      guide: blockedShareCmd,
      sources: [{ url: 'http://xhslink.com/a/abc123XYZ', status: 'unavailable' }],
      candidates: [],
      ocrPlaces: [{ name: '龙井村' }]
    }),
    true
  );
});

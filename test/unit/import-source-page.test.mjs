import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFetchError, detectUnavailablePage, MIN_SUBSTANTIVE_CHARS, substantiveContentChars } from '../../server/import/source-page.mjs';
import { importStatusLabel } from '../../src/components/Builder/builderModel.js';

test('a deleted 小红书 note (real 2026-10 page text) is detected as unavailable', () => {
  // Visible text of https://www.xiaohongshu.com/discovery/item/642d87f000000000130086c9 on 2026-10-09.
  const reason = detectUnavailablePage({
    title: '小红书 - 你访问的页面不见了',
    text: '小红书 - 你访问的页面不见了 网页版 创作中心 业务合作 发现 RED 直播 发布 通知 消息 © 2014-2026 行吟信息科技（上海）有限公司'
  });
  assert.equal(reason, '页面不见了');
  assert.ok(detectUnavailablePage({ title: '登录后查看更多精彩内容', text: '' }));
});

test('real guide pages are not flagged', () => {
  assert.equal(
    detectUnavailablePage({
      title: 'Global Travel Guide (@wang_hao541621) on X',
      description: '成都旅游攻略 DAY1：春熙路—IFS国金中心—大慈寺',
      text: 'x'.repeat(2000) + '已删除'
    }),
    ''
  );
  assert.equal(detectUnavailablePage({ title: '安福路在哪里-抖音', description: '安福路乌鲁木齐中路保姆级citywalk攻略！', text: '安福路 citywalk' }), '');
});

test('English network errors become Chinese reasons; Chinese messages pass through', () => {
  assert.match(describeFetchError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), /秒内没有响应/);
  assert.match(describeFetchError(new Error('Client network socket disconnected before secure TLS connection was established')), /无法连接/);
  assert.equal(describeFetchError(new Error('公开页面返回 HTTP 404')), '公开页面返回 HTTP 404');
});

test('import status is shown in Chinese, never the raw enum', () => {
  assert.equal(importStatusLabel('fetched'), '已读取公开内容');
  assert.equal(importStatusLabel('unavailable', 'too-little'), '内容太少，读不到攻略');
  assert.equal(importStatusLabel('unavailable'), '页面已删除或需登录');
  assert.equal(importStatusLabel('weird'), '状态待补充');
});

test('E2E 2026-10-09: candidates marked 必去 reach constraints.mustGo', async () => {
  const { mergeMustGoConstraint } = await import('../../src/components/Builder/builderModel.js');
  const candidates = [
    { name: '宽窄巷子', included: true, mustGo: true },
    { name: '春熙路', included: true, mustGo: false },
    { name: '武侯祠', included: true, mustGo: true },
    { name: '熊猫基地', included: false, mustGo: true }
  ];
  assert.equal(mergeMustGoConstraint('', candidates), '宽窄巷子、武侯祠');
  assert.equal(mergeMustGoConstraint('武侯祠、杜甫草堂', candidates), '武侯祠、杜甫草堂、宽窄巷子');
  assert.equal(mergeMustGoConstraint('', []), '');
});

test('E2E 2026-10-09: title-only / hashtag-only pages carry too little content to be a guide', () => {
  // 抖音 video page: app shell, empty description, our crawler UA echoed into the body.
  const douyinVideo = substantiveContentChars({
    platformId: 'douyin',
    title: '成都三天两晚怎么玩-抖音',
    description: '',
    text: '成都三天两晚怎么玩-抖音 登录 下载抖音 TrustedRoutebookBot/0.1 (+https://example.invalid/bot) 推荐 关注 直播'
  });
  assert.ok(douyinVideo < MIN_SUBSTANTIVE_CHARS, String(douyinVideo));
  // 抖音 shipin page: one short sentence plus hashtags.
  const douyinShipin = substantiveContentChars({
    platformId: 'douyin',
    title: '成都citywalk',
    description: '成都两天一夜citywalk路线来啦，收藏起来慢慢逛 #成都旅游 #成都citywalk #旅行攻略 #宽窄巷子 #春熙路',
    text: ''
  });
  assert.ok(douyinShipin < MIN_SUBSTANTIVE_CHARS, String(douyinShipin));
  // X post with a real day-by-day description (141 chars in the E2E) passes.
  const xPost = substantiveContentChars({
    platformId: 'x',
    title: 'Global Travel Guide on X',
    description:
      '成都旅游攻略 DAY1：春熙路—IFS国金中心—大慈寺—太古里，晚上去九眼桥酒吧街。DAY2：宽窄巷子—人民公园喝茶—武侯祠—锦里，晚上吃火锅。DAY3：熊猫基地早上去，下午杜甫草堂。',
    text: ''
  });
  assert.ok(xPost >= MIN_SUBSTANTIVE_CHARS, String(xPost));
  // A normal web article passes on its body even without a meta description.
  assert.ok(
    substantiveContentChars({
      platformId: 'web',
      title: '杭州攻略',
      description: '',
      text: '西湖一日游路线：断桥残雪、白堤、孤山、平湖秋月、苏堤春晓、花港观鱼、雷峰塔，傍晚在湖滨看音乐喷泉。'.repeat(2)
    }) >= MIN_SUBSTANTIVE_CHARS
  );
  // A generic page that only repeats its title and site chrome does not.
  assert.ok(
    substantiveContentChars({ platformId: 'web', title: '杭州旅游攻略大全', description: '', text: '杭州旅游攻略大全 首页 登录 注册 © 2026 ICP备12345678号' }) <
      MIN_SUBSTANTIVE_CHARS
  );
});

# 合规相关功能（代码侧）

本文只说明代码已经做了什么、怎么配置。是否满足法规要求由运营方与法务判断，见 `lushu-ui-audit/合规决策清单.md`。

## 定位授权
- `src/lib/locationConsent.js`：未在应用内弹窗同意前，`navigator.geolocation` 不会被调用（单测 `test/unit/location-consent.test.mjs`）。
- 同意记录只存在本机 localStorage，带政策版本号 `LOCATION_POLICY_VERSION`；版本变更后需重新同意。
- `/privacy` 页可撤回本机同意。

## 隐私说明草案
- `/privacy`（`src/components/Legal/PrivacyPage.jsx`）只写代码实际做的事；运营主体、保存期限、存储地、第三方名单等标为【待确认】，上线前必须由运营方补齐并经法务审核。

## AI 生成内容标识
- 显式：路书页、公开分享页标题区的「AI 生成 / AI 生成 · 经用户编辑」标签；城市示意图原有「AI 生成」角标。
- 隐式：`GET /api/share/:id` 的 `routebook.aigc`；分享落地页 HTML 中的 `<meta name="aigc" content="{…}">`。
- 规则在 `src/lib/aigc.js`，读时由已存数据推导，老路书无需迁移。

## 内容审核
- 范围：打卡的评论/踩坑/适合谁/排队/花费文字；提交发布的路书标题、摘要、站点名与备注。
- 流程：预过滤（内置手机号/站外联系方式/外链规则 + `MODERATION_KEYWORDS_FILE`）→ 可选境内内容安全服务 → 命中即进 `moderation-queue`（运营台「内容审核」）。命中内容在人工放行前不公开：打卡文字在公开回顾中隐藏，路书不出现在公开分享与公开列表。
- `MODERATION_PROVIDER=keyword|domestic|none`。`domestic` 适配器（`server/moderation/providers.mjs`）是一个通用契约的**桩**：`POST {text, scene}` → `{decision, labels}`，必须改写为所选服务商（如阿里云内容安全、腾讯云天御、网易易盾等）的真实接口后才能使用；未配置、超时或报错一律转人工。
- 关键词文件格式：每行一个，`block:词`、`review:词` 或直接写词（=review），`#` 为注释。命中词不会回显到接口。
- 已知范围外：发布后再次编辑公开路书目前不会自动复审（需运营在版本页复核）；评论区、社区等尚不存在的功能未覆盖。
- 注销账号时审核记录随 `profileId` 一并删除。

## 底图
- 生产环境（`npm start`）只接受 `TIANDITU_KEY`（天地图）或 `AMAP_TILE_KEY`（高德）底图；OSM 仅限开发。`ALLOW_OSM_BASEMAP_IN_PRODUCTION=true` 可强制放行（会告警，只用于非公开演示）。
- 高德瓦片代理是否符合高德使用条款，需要运营方与高德确认（见决策清单）。

## 模型
- 见 `docs/domestic-model-provider.md`。生产环境 `AI_PROVIDER_REGION` 不是 `domestic` 时启动告警。

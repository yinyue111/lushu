# 变更记录

本文件记录对客户端、运维或数据有影响的变化。未发布版本按分支累计。

## 未发布（next/plan）

### 运维 / 存储

- 账号加邮箱（迁移 `0009_account_email.sql`，schema v9，只新增列和 `auth_email_codes` 表，`phone_hash` 放开非空）：注册要邮箱和验证码，手机号改为选填；邮箱或手机号都能登录；忘了密码可用邮箱验证码重设，恢复码保留。新环境变量 `AUTH_EMAIL_HASH_SECRET`、`AUTH_EMAIL_ENC_KEY`、`MAIL_TRANSPORT`、`MAIL_FROM`、`MAIL_API_KEY`、`MAIL_API_URL`、`EMAIL_VERIFICATION_REQUIRED`、`EMAIL_CODE_RESEND_SECONDS`，见 `docs/deploy.md` 和 `docs/login-rollout.md`。
- 新接口：`POST /api/auth/register/code`、`/api/auth/reset-password/code`、`/api/auth/email/code`、`/api/auth/email`；`/api/auth/login` 接受 `identifier`（邮箱或手机号）；`DELETE /api/routebooks/:id`（所有者从账号里删除路书，追加带 `deletedAt` 的版本）。登录用户按主档案列路书时，包含账号认领过的所有设备档案。

- PostgreSQL schema 升级到 v6（迁移 `server/migrations/0006_event_row_entity_keys.sql`）：`event_rows` 新增 `entity_key` 列及索引，按实体取最新记录改为索引查询。加列迁移，旧行 `entity_key` 为 `NULL` 时仍能被正确读取；启动时分批回填，运行账号需要 `UPDATE (entity_key)` 权限（缺失时只告警）。
- 权威 PG schema 是 `server/migrations/`；根目录 `migrations/` 只是关系型设计稿和其回归测试，不要应用到生产库。
- 新增 `RATE_LIMIT_OPS_READ_MAX`（默认 120/窗口）：运营只读列表接口（审核队列、打卡、导入、审计）按客户端限流，在管理员鉴权之前计数。
- POI 目录只在可能解析 POI 的接口上做新鲜度检查；`/api/live`、`/api/ready`、`/api/health`、`/api/cities`、`/api/map-tiles/*` 和运营只读列表不再触发目录重载。
- Service Worker：只有构建产物里带内容哈希的文件走缓存优先；`/assets` 下的公共图片改为 stale-while-revalidate，最多缓存 60 张。
- CI：`actions/checkout@v5`、`actions/setup-node@v5`；PG 运行时回归读取标准 `PG*` 环境变量（修复 CI 上 TCP + 密码认证失败）。

### 接口 / 客户端可见变化

- **可信分只基于证据**：模型自评 `stop.score` 不再存储也不公开；新路书不再保存模型写的 validations/metrics；站点带来源（provenance）标签，`user-guide` 来源由服务器签名。
- 站点新增结构化 `costInfo`；经审核且未过期的价格以 `verifiedPrice` 在读取时附加（不落库）。营业时间核对需要完整的营业窗口和最晚入场时间才判“通过”，缺数据显示“未核验”。
- `DELETE /api/favorites`（软删除 + 所有者校验）；列表接口缺省 `limit` 不再被当成 0。
- 生成：相同请求在 `GENERATION_DEDUP_TTL_MS`（默认 10 分钟）内复用结果；已注册账号每 `GENERATION_QUOTA_WINDOW_MS`（默认 24 小时）限 `GENERATION_QUOTA_PER_PROFILE`（默认 30）次，超出返回 429 `GENERATION_QUOTA_EXCEEDED` + `Retry-After`。
- 地理编码：配置 `AMAP_GEOCODE_KEY` 时先用 AMap POI 搜索 + 确定性候选选择，站点记录 `coordinatePrecision`；到达半径按精度放宽 0/50/100/250 米。
- POI 去重：`/api/pois/resolve` 返回规范 `poiId`；被合并的 POI 名称/别名指向规范 POI。新增运营接口 `GET /api/ops/poi-duplicates`、`GET/POST /api/ops/poi-merges`。
- 内容审核：打卡 `POST` 响应带 `moderation.status`；命中预过滤的打卡文字在公开评价中隐藏（`textWithheld: true`）；命中的公开路书在运营通过前不出现在分享页和公开列表。新增 `GET /api/ops/moderation`、`POST /api/ops/moderation/:entityType/:entityId`。
- 定位：前端在首次调用定位前弹出授权说明，可在 `/privacy` 撤回；公开路书视图新增 `aigc` 字段，分享页 HTML 增加 `og:url`、`canonical`、`og:locale`、`<meta name="aigc">` 和 `<noscript>` 预渲染。
- 看板：`funnel.constraintSatisfactionRate` / `constraintSatisfaction`；`redirectRate: null`（`not-instrumented`）。
- Jev 影子试点（默认关闭）：`GET /api/ops/shadow-judgments`。

### 存储 / 迁移

- PostgreSQL schema 升级到 **v7**（`server/migrations/0007_poi_merges_moderation_shadow.sql`）：新增追加型流 `poi-merges`、`moderation-queue`、`shadow-judgments`，初始为空，不重置 parity；JSONL 对应 `poi-merges.jsonl`、`moderation-queue.jsonl`、`shadow-judgments.jsonl`，文件不存在时视为空。旧路书、旧打卡无需迁移。
- 待处理打卡照片改存 IndexedDB Blob；旧队列中的内联 data URL 仍可上传。

### 新环境变量

`AMAP_API_BASE_URL`、`GENERATION_DEDUP_TTL_MS`、`GENERATION_QUOTA_PER_PROFILE`、`GENERATION_QUOTA_WINDOW_MS`、`MODERATION_PROVIDER`、`MODERATION_KEYWORDS_FILE`、`MODERATION_API_URL`、`MODERATION_API_KEY`、`MODERATION_TIMEOUT_MS`、`ALLOW_OSM_BASEMAP_IN_PRODUCTION`、`AI_PROVIDER_REGION`、`JEV_SHADOW_ENABLED`、`TYPESAFE_API_KEY`、`JEV_API_URL`、`JEV_MODEL`、`JEV_SHADOW_TIMEOUT_MS`、`JEV_SHADOW_SAMPLE_RATE`、`JEV_SHADOW_MAX_IN_FLIGHT`。

**生产启动变化**：`NODE_ENV=production` 时底图必须是带 key 的天地图或高德，否则拒绝启动；临时可设 `ALLOW_OSM_BASEMAP_IN_PRODUCTION=true`（会告警）。

## 4ded5b3 — 本地可靠性与产品改进合入

以下是这个提交引入、**依赖旧行为的客户端需要适配**的变化：

- **新状态 `pending_review`**：车主（非管理员）执行发布后路书进入待审，不再直接变成 `published`，也不会立刻得到公开分享链接。客户端应展示「审核中」，不要假设发布后立即可分享。
- **不再返回 `editToken`**：车主读取路书的接口不再在响应里带 `editToken`，改为返回 `ownerAccessVerified: true|false`。编辑仍通过请求头 `x-routebook-edit-token`（或请求体 `editToken`）提交；令牌只由创建/保存类接口返回，读取接口不再回显，客户端需要在拿到时自行保存。
- **未核验道路不能公开发布**：同日相邻站点的道路段必须全部由服务器核验（带服务器签名的道路结果），否则发布被拒绝。管理员可以带 `allowUnverifiedRouting: true` 和至少 8 个字的 `routingOverrideReason` 强制发布，原因写入版本审计；来源未授权时不能用这个例外绕过。
- 审核状态变更必须带审计备注。
- 新 profile 路由：导出、注销、登出、恢复码。
- 环境变量改名：预留但未生效的 `DATABASE_POOL_*` 改为 `POSTGRES_POOL_MAX`、`POSTGRES_CONNECT_TIMEOUT_MS`、`POSTGRES_STATEMENT_TIMEOUT_MS`、`POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS`。新增 `STORAGE_BACKEND`、`BACKUP_ENCRYPTION_KEY`、`AMAP_ROUTING_KEY`、`ROUTING_TIMEOUT_MS`、`ROUTING_CONCURRENCY`、`AI_*_COST_PER_MILLION_TOKENS`、`AI_COST_CURRENCY`。

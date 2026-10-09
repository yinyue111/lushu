# 变更记录

本文件记录对客户端、运维或数据有影响的变化。未发布版本按分支累计。

## 未发布（next/plan）

### 运维 / 存储

- PostgreSQL schema 升级到 v6（迁移 `server/migrations/0006_event_row_entity_keys.sql`）：`event_rows` 新增 `entity_key` 列及索引，按实体取最新记录改为索引查询。加列迁移，旧行 `entity_key` 为 `NULL` 时仍能被正确读取；启动时分批回填，运行账号需要 `UPDATE (entity_key)` 权限（缺失时只告警）。
- 权威 PG schema 是 `server/migrations/`；根目录 `migrations/` 只是关系型设计稿和其回归测试，不要应用到生产库。
- 新增 `RATE_LIMIT_OPS_READ_MAX`（默认 120/窗口）：运营只读列表接口（审核队列、打卡、导入、审计）按客户端限流，在管理员鉴权之前计数。
- POI 目录只在可能解析 POI 的接口上做新鲜度检查；`/api/live`、`/api/ready`、`/api/health`、`/api/cities`、`/api/map-tiles/*` 和运营只读列表不再触发目录重载。
- Service Worker：只有构建产物里带内容哈希的文件走缓存优先；`/assets` 下的公共图片改为 stale-while-revalidate，最多缓存 60 张。
- CI：`actions/checkout@v5`、`actions/setup-node@v5`；PG 运行时回归读取标准 `PG*` 环境变量（修复 CI 上 TCP + 密码认证失败）。

## 4ded5b3 — 本地可靠性与产品改进合入

以下是这个提交引入、**依赖旧行为的客户端需要适配**的变化：

- **新状态 `pending_review`**：车主（非管理员）执行发布后路书进入待审，不再直接变成 `published`，也不会立刻得到公开分享链接。客户端应展示「审核中」，不要假设发布后立即可分享。
- **不再返回 `editToken`**：车主读取路书的接口不再在响应里带 `editToken`，改为返回 `ownerAccessVerified: true|false`。编辑仍通过请求头 `x-routebook-edit-token`（或请求体 `editToken`）提交；令牌只由创建/保存类接口返回，读取接口不再回显，客户端需要在拿到时自行保存。
- **未核验道路不能公开发布**：同日相邻站点的道路段必须全部由服务器核验（带服务器签名的道路结果），否则发布被拒绝。管理员可以带 `allowUnverifiedRouting: true` 和至少 8 个字的 `routingOverrideReason` 强制发布，原因写入版本审计；来源未授权时不能用这个例外绕过。
- 审核状态变更必须带审计备注。
- 新 profile 路由：导出、注销、登出、恢复码。
- 环境变量改名：预留但未生效的 `DATABASE_POOL_*` 改为 `POSTGRES_POOL_MAX`、`POSTGRES_CONNECT_TIMEOUT_MS`、`POSTGRES_STATEMENT_TIMEOUT_MS`、`POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS`。新增 `STORAGE_BACKEND`、`BACKUP_ENCRYPTION_KEY`、`AMAP_ROUTING_KEY`、`ROUTING_TIMEOUT_MS`、`ROUTING_CONCURRENCY`、`AI_*_COST_PER_MILLION_TOKENS`、`AI_COST_CURRENCY`。

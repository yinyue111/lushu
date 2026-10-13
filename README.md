# AI 可信路书（Lushu）

把分散在图文、短视频、公开链接和截图里的旅行攻略，转换为可编辑、可执行、可验证的地图路书，并通过真实打卡持续校准路线可信度。

## 核心闭环

`攻略导入 / OCR → POI 提取 → AI 生成路书 → 地图编辑 → 行中执行 → GPS / 照片打卡 → 可信分 → 回顾与分享`

当前内置杭州、上海、苏州 3 个城市的种子内容，包含 3 条精选路线和 16 个种子 POI。

## 已实现能力

- 文本、公开链接和截图 OCR 攻略导入
- 结构化 POI 提取与 AI 分日路书生成
- 地图路线编辑、路线校验和风险提示
- 行中模式、GPS 到达验证、照片与反馈打卡
- POI / 路线可信分与最小样本保护
- 路书保存、版本冲突处理、发布、分享与旅行回顾
- 创作者、收藏、目的地页和运营审核后台
- 身份绑定、离线打卡队列、幂等上传和审计记录
- 逐条 POI 证据/事实核验与审核备注；打卡排除/恢复/商业激励、来源授权撤回
- 高德真实道路几何与耗时，缺失或过期证据明确降级；公开发布前道路/来源双门禁
- 主动同意云同步、单次恢复码、资料导出/退出/注销；行程跨设备版本同步与冲突保留
- 生产 PWA 离线静态壳（不缓存账号 API 或照片）、加密备份与可验证恢复
- 实际 AI Token/重试/阶段耗时及可配置单价的费用估算；去重归因的商品曝光/点击漏斗

## 技术栈

- React 19 + Vite 7
- Node.js 22.23.3（见 `.nvmrc`；`package.json` engines `>=22.23.3 <23`，Dockerfile 和 CI 用同一版本）
- Leaflet
- 默认单进程 JSONL（索引/缓存）；可切换 PostgreSQL 权威存储（事务 CAS、跨实例锁）
- OpenAI-compatible Responses / Chat Completions 模型接口

## 本地启动

```bash
npm install
cp .env.example .env
npm run dev
```

默认地址：<http://127.0.0.1:5173/>

### 端口说明

| 命令 | 端口 | 说明 |
| --- | --- | --- |
| `npm run dev` | 5173（`PORT`） | 一体化开发服务：API + Vite 中间件（HMR 端口从 `VITE_HMR_PORT`=24679 起找空闲端口） |
| `npm run dev:frontend` | 5174 | 独立 Vite 前端，`/api` 代理到 `VITE_API_PROXY_TARGET`（默认 `http://127.0.0.1:5173`），需另开 `npm run dev` |
| `npm start` / `npm run preview` | 5173（`PORT`） | 生产模式，托管 `dist/`；`preview` 会先 build |

`npm start` 通过 `--production` 参数切换生产模式，Windows / macOS / Linux 通用，无需 `NODE_ENV=production` 前缀。

健康检查：

```bash
curl http://127.0.0.1:5173/api/live
curl http://127.0.0.1:5173/api/ready
curl http://127.0.0.1:5173/api/health
```

如需使用自有模型服务，请在 `.env` 中配置 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` 和 `OPENAI_WIRE_API`。`OPENAI_WIRE_API` 支持 `responses` 与 `chat_completions`；请按上游实际开放的协议选择。`.env` 已被 Git 忽略，不要提交真实密钥。全部可用环境变量及默认值见 [`.env.example`](.env.example)。

## 验证

```bash
npm run verify               # 语法检查 → ESLint → Prettier 格式检查 → 类型检查 → 生产构建 → node:test 单测/集成测试 → 各回归脚本
npm run test:postgres-schema # 需要 PostgreSQL（见下）
npm run test:postgres-storage # 临时数据库的迁移、校验、并发写、回滚导出
npm run test:postgres-runtime # 临时数据库的双实例 API、CAS 与账号删除回归
npm run smoke:api            # 需要真实模型密钥，会真正调用模型
```

`npm run verify` 依次执行：全部服务端脚本语法检查、ESLint（`eslint.config.js`，含 `react-hooks` 规则）、Prettier 格式检查（`.prettierrc.json`；`npm run format` 自动格式化）、JSDoc 类型检查（`tsc -p tsconfig.json`，`checkJs` + `noEmit`，非 strict）、生产构建（安全回归需要 `dist/`）、`node:test` 测试（`test/**/*.test.mjs`）、安全回归、身份迁移、离线打卡队列、核心产品链路、POI / 路书运营回归。

- `verify` 中的自动化测试使用临时数据目录和隔离模型配置（关闭端口或测试提供方），不会读取本机 `~/.codex` 或 shell 里的真实模型密钥（见 `scripts/lib/hermetic-env.mjs`）；`smoke:api` 是需要真实模型的独立命令。
- `npm run test:unit`（= `npm test`）只跑 `node:test` 测试；可传关键字过滤：`npm run test:unit -- coordinates`。
- `test:postgres-schema` 前置条件：PATH 中有 `psql`、`createdb`、`dropdb`，并通过标准 `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` 环境变量指向一个允许建库的 PostgreSQL（≥ 14）。脚本会创建并删除一个临时库。
- `smoke:api` 会调用真实模型；未配置模型时会立即失败并给出原因（`/api/health` 第一次返回 `ready: false` 即退出；服务启动等待上限 `SMOKE_STARTUP_TIMEOUT_MS`，默认 30 秒；如需继续轮询可设置 `SMOKE_NOT_READY_GRACE_MS`）。
- 可用 `SMOKE_OFFLINE=true node scripts/smoke-api.mjs` 在临时目录用本地模拟模型验收发布/分享/归档等完整 API 契约；它不会验证真实上游质量，也不允许指定现有 `SMOKE_BASE_URL`。
- CI：`.github/workflows/ci.yml` 在 push / PR 时运行 `npm ci`、`npm run verify`（含 lint、格式与类型检查）、PostgreSQL schema/存储/双实例回归和 `npm audit --omit=dev`。

## 生产边界

本次本地改动的保留/舍弃清单与验收边界见 [本地择取验收记录](docs/local-merge-acceptance-2026-10-09.md)。

- JSONL 使用独占运行写租约，适合本地演示和单进程内测。PostgreSQL 迁移必须停写、回填、一致性核对再切换，禁止双写或数据库失败后静默回退 JSONL。见下方存储说明。
- 接口契约变化（自 4ded5b3 起，详见 [CHANGELOG](CHANGELOG.md)）：用户发布操作现在是送审 `pending_review`，不直接获得公开链接；车主读取接口不再返回 `editToken`（改为 `ownerAccessVerified`）；同日道路段未全部核验的路书不能直接公开发布。管理员公开发布要求导入来源已授权、同日道路段全部核验；道路例外须二次确认并填写至少 8 字原因，记录在版本审计中。来源授权不可用道路例外绕过。
- 旧路书中没有服务器签名的道路结果不自动视为真实核验。配置 `AMAP_ROUTING_KEY` 后在运营台重新核验；未配置时仍可编辑和送审，不会伪造距离、耗时或道路几何。
- 未配置高德地理编码密钥时，低置信度模型坐标会保持模糊状态，不用于精确导航。
- 地图底图通过同源代理 `/api/map-tiles` 加载，按 `MAP_TILE_PROVIDERS` 顺序回退，并自动识别以 HTTP 200 返回的占位图（如 CARTO 的 “API KEY REQUIRED”）。不配置任何密钥时使用 OpenStreetMap 镜像（仅适合开发和演示）；生产环境请配置 `TIANDITU_KEY`（天地图服务端密钥，WGS-84 坐标，与路书坐标一致），或使用高德（`MAP_TILE_PROVIDERS=amap`，可选 `AMAP_TILE_KEY`，GCJ-02，前端会自动偏移标记，商用需高德授权）。当前底图信息见 `GET /api/map-tiles/config`。
- 公网部署必须配置独立的 `ROUTEBOOK_API_TOKEN`、`ROUTEBOOK_ADMIN_TOKEN` 和 `PROFILE_ID_SECRET`，并建议配置 `PUBLIC_BASE_URL`（分享页 og:image 的绝对地址）。
- 生产模式只从 `OPENAI_*` 环境变量读取模型配置，不再读取 `~/.codex`；如确需沿用，设置 `AI_RUNTIME_FROM_CODEX=true`。开发模式默认仍读取。
- 不要在公网环境启用 `ALLOW_LOCAL_API_BYPASS` 或 `ALLOW_LOCAL_ADMIN_BYPASS`：生产模式下若同时 `HOST` 不是回环地址，服务会拒绝启动（可用 `ALLOW_LOCAL_BYPASS_ON_PUBLIC_HOST=true` 强制）；开发模式下会打印告警。
- 生产模式端口被占用时直接退出（开发模式仍会自动尝试下一个端口）；收到 `SIGTERM` / `SIGINT` 会停止接收新请求，等待进行中的请求完成（最长 `SHUTDOWN_GRACE_MS`）后退出。
- 生产模式下 `/api/health` 对匿名请求只返回 `ready` 和通用提示；provider / model / baseUrl 等细节需带 `x-routebook-admin-token`（运营后台会自动带上）。
- 生产静态托管：`dist/` 文件按 mtime/size 缓存在内存，按 `Accept-Encoding` 返回 br / gzip，支持 ETag / 304；只有带 Vite 内容哈希的资源设为一年 immutable，其余静态文件缓存 1 小时，`index.html` 为 `no-cache`。前面有 CDN / 反代时仍建议由其负责压缩与缓存。
- 账号导出/注销仅接受本人凭据，不继承本机或管理员免鉴权。注销写入可重试墓碑、清理业务记录和照片；照片响应不再使用不可撤销的长期公共缓存。部署前仍需确定正式隐私告知、保存期限和备份删除政策。
- AI 费用只在实际 Token 用量完整且显式配置 `AI_INPUT_COST_PER_MILLION_TOKENS` / `AI_OUTPUT_COST_PER_MILLION_TOKENS` 时估算；币种由 `AI_COST_CURRENCY` 指定，不代表供应商账单。未采集的满意度/投诉显示不可用，不以零值代替。

### 存储切换与备份

当前真实数据不会自动迁移。先在预发布环境演练，并保持原 `PROFILE_ID_SECRET` 不变。配置 `DATABASE_URL` 或标准 `PG*` 环境变量后，在停止 JSONL 服务的维护窗口执行：

```bash
npm run postgres:migrate
npm run postgres:backfill -- --data-dir ./data          # 仅检查
npm run postgres:backfill -- --data-dir ./data --apply
npm run postgres:parity -- --data-dir ./data --mark-ready
```

核对成功后才将 `.env` 的 `STORAGE_BACKEND` 改为 `postgres` 并启动。

**哪套 schema 是权威的**：`server/migrations/`（`event_rows` 事件表，当前 schema v6）是唯一的运行时 schema，由 `npm run postgres:migrate` 和服务启动时的检查使用。仓库根目录的 `migrations/0001_content_routebook_foundation.sql` 是早期的关系型设计稿，只被 `npm run test:postgres-schema` 用来回归该设计，**不要**把它应用到生产库，也不能用它代替运行时迁移。

迁移 `0006_event_row_entity_keys` 为 `event_rows` 增加 `entity_key` 列和 `(stream, entity_key, ordinal desc)` 部分索引，按实体取最新一行改为索引 `LIMIT 1` 查询（含 profile 的 `registrationCredentialHash` 表达式索引）。该迁移是加列，不需要停服重建：旧行的 `entity_key` 为 `NULL`，查询会把这些行在内存中一起比对，结果与全表扫描一致；服务启动时会分批回填（运行账号需要对 `event_rows.entity_key` 的 `UPDATE` 权限，没有权限时只打印告警，功能不受影响，只是旧行仍走慢路径）。照片仍位于 `ROUTEBOOK_DATA_DIR/photos`，多实例必须共享该目录，并单独纳入备份。

配置强随机 `BACKUP_ENCRYPTION_KEY`（至少 16 UTF-8 字节，密钥与备份分开保管）后，可在服务停止时备份 JSONL 数据目录；数据库部署应先导出一致性快照到独立目录，并连同已停止写入的照片目录备份：

```bash
npm run backup:data -- --data-dir ./data --output ./backups/manual.trbk
npm run restore:data -- --input ./backups/manual.trbk   # 仅解密与校验
npm run restore:data -- --input ./backups/manual.trbk --data-dir ./restored-data --apply
```

恢复默认拒绝覆盖非空目录。不要为绕过运行中写租约而直接删除锁；先停服务，使用 `npm run source:lease -- --help` 查看检查和精确令牌恢复方式。备份文件、照片、租约及生成产物均已被 Git 忽略。

### PROFILE_ID_SECRET 迁移

`PROFILE_ID_SECRET` 用于派生绑定身份的稳定 profile ID（`u_<hmac>`）、profile token 哈希、导入来源签名和 POI 提交签名。旧版本在未设置它时会**静默复用** `ROUTEBOOK_ADMIN_TOKEN`（其次 `ROUTEBOOK_API_TOKEN`），导致轮换管理员令牌会让所有已有 profile token 失效。

当前版本保持同样的回退顺序（已有哈希不受影响），但启动时会打印 `DEPRECATED` 告警。迁移步骤：

1. 查看当前生效的回退来源（启动日志会写明是 `ROUTEBOOK_ADMIN_TOKEN` 还是 `ROUTEBOOK_API_TOKEN`）。
2. 设置 `PROFILE_ID_SECRET=<该令牌的当前值>` 并重启，告警消失，已有 profile ID / token 全部继续有效。
3. 之后即可独立轮换 `ROUTEBOOK_ADMIN_TOKEN` / `ROUTEBOOK_API_TOKEN`。**不要**更换 `PROFILE_ID_SECRET` 本身，否则已有 profile token 需要用户重新绑定。

全新部署直接设置一个随机的 `PROFILE_ID_SECRET` 即可。

身份断言（`PROFILE_IDENTITY_ASSERTION_SECRET` 签名的手机号 / 微信断言）中的 `nonce` 只能使用一次：重复提交返回 `409 IDENTITY_ASSERTION_REPLAYED`，已用 nonce 记录在 `identity-nonces.jsonl`（重启后仍生效）。登录后端每次需签发新的 nonce。开发模式未设置任何令牌时使用公开的默认值，仅适合本机。

## 目录

```text
src/            React 前端与浏览器端业务逻辑
server.mjs      服务入口（启动检查、HTTP 监听、开发模式 Vite、优雅退出）
server/         服务端模块
  config/       环境变量与启动安全检查
  lib/          纯工具函数
  storage/      JSONL 索引/缓存、PostgreSQL 运行时接口、租约与快照
  auth/         令牌、请求鉴权、画像与身份断言
  http/         响应/安全头、限流、路由器、静态与分享落地页、地图瓦片
  routes/       API 路由表（按领域拆分）
  routebooks/   路书规范化、版本、写操作、公开视图
  trust/        打卡规则、反馈聚合与可信分
  poi/          可信 POI 目录、纠错与知识
  geo/          坐标与地理编码
  import/       攻略导入与 SSRF 防护
  photos/       打卡照片（元数据剥离、EXIF 匹配）
  ai/           模型运行时与生成 / OCR
  analytics/    曝光、看板
  ops/          运营审核与审计投影
  routing/      道路几何、核验签名与公开发布门禁
  trips/        跨设备行程会话与版本冲突
  migrations/   PostgreSQL 运行时迁移
  content/      CMS 与商品配置
scripts/        回归、冒烟和结构检查（scripts/lib 为测试共用工具）
test/           node:test 单元 / 集成测试
migrations/     早期 PostgreSQL 关系模型设计（非运行时 schema）
public/assets/  本地演示素材
```

## 架构概览

- **前端**：React 19 单页应用，`src/App.jsx` 负责视图切换；`src/lib/` 为浏览器端业务逻辑（离线打卡队列、本地存储、可信度展示、坐标工具）。
- **服务端**：单进程 Node HTTP 服务，无框架。`/api/*` 由 `server/routes/` 的路由表处理（按路径段精确匹配，`:id` 不跨 `/`）；`/share/:id`、`/review/:id` 注入 og meta；其余请求在开发模式交给 Vite 中间件，生产模式托管 `dist/`。
- **存储**：`ROUTEBOOK_DATA_DIR` 下的追加式 JSONL，或 `STORAGE_BACKEND=postgres` 的权威事件/配置存储。运行时迁移在 `server/migrations/`；照片仍位于 `photos/`，启用多实例前需要共享照片存储与备份演练。
- **鉴权**：公开读 / profile token（`x-routebook-profile-id` + `x-routebook-profile-token`）/ 路书编辑令牌（`x-routebook-edit-token` 或请求体 `editToken`）/ 模型代理令牌（`x-routebook-token`）/ 运营管理员令牌（`x-routebook-admin-token`）。

## API 概览

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `/api/live`、`/api/ready`、`/api/health` | 公开 |
| GET | `/api/cities`、`/api/cms`、`/api/products`、`/api/poi-knowledge`、`/api/pois/resolve` | 公开（限流） |
| GET | `/api/routebooks/:id`、`/api/share/:id`、`/api/reviews/:id`、`/api/creators/:id` | 公开内容公开；草稿需 owner / 编辑令牌 / 管理员 |
| GET | `/api/routebooks?city=&status=published,featured&profileId=&limit=` | 仅公开状态时公开；`profileId` 需 profile token；其余需管理员 |
| POST | `/api/routebooks`、`/api/routebooks/:id/{publish,copy,variants}` | 编辑令牌 / profile token |
| POST | `/api/routebooks/:id/status`、`/api/pois/{validate,upsert}`、`/api/cms`、`/api/products`、`/api/poi-corrections/:id/status` | 管理员 |
| GET | `/api/dashboard`、`/api/logs`、`/api/imports`、`/api/pois`、`/api/poi-coverage`、`/api/routebooks/:id/versions` | 管理员 |
| GET | `/api/checkins`、`/api/clicks`、`/api/favorites`、`/api/product-analytics`、`/api/poi-corrections` | profile token（按 `profileId`）或管理员 |
| POST | `/api/profile`、`/api/checkins`、`/api/checkin-photos`、`/api/favorites`、`/api/reviews`、`/api/poi-corrections`、`/api/clicks`、`/api/exposures` | profile token（匿名写入有限制） |
| POST | `/api/generate-routebook`、`/api/ocr-guide`、`/api/import-guide` | 本机或 `x-routebook-token` |
| GET | `/api/checkin-photos/:id` | 本人 / 管理员；公开照片还须有同一路书的有效打卡见证 |
| GET | `/api/map-tiles/:z/:x/:y.png`、`/api/map-tiles/labels/:z/:x/:y.png`、`/api/map-tiles/config` | 公开（限流） |

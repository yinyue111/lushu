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

## 技术栈

- React 19 + Vite 7
- Node.js 20.19+
- Leaflet
- 默认 JSONL 本地存储；仓库包含 PostgreSQL 基础表结构迁移与回归检查
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
npm run verify               # 语法检查 → 生产构建 → node:test 单测/集成测试 → 各回归脚本
npm run test:postgres-schema # 需要 PostgreSQL（见下）
npm run smoke:api            # 需要真实模型密钥，会真正调用模型
```

`npm run verify` 依次执行：全部服务端脚本语法检查、生产构建（安全回归需要 `dist/`）、`node:test` 测试（`test/**/*.test.mjs`）、安全回归、身份迁移、离线打卡队列、核心产品链路、POI / 路书运营回归。

- 所有测试都使用隔离环境：临时数据目录、假的 `OPENAI_*`（指向关闭端口）、空的临时 `CODEX_HOME`，不会读取本机 `~/.codex` 或 shell 里的真实密钥（见 `scripts/lib/hermetic-env.mjs`）。
- `npm run test:unit`（= `npm test`）只跑 `node:test` 测试；可传关键字过滤：`npm run test:unit -- coordinates`。
- `test:postgres-schema` 前置条件：PATH 中有 `psql`、`createdb`、`dropdb`，并通过标准 `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` 环境变量指向一个允许建库的 PostgreSQL（≥ 14）。脚本会创建并删除一个临时库。
- `smoke:api` 会调用真实模型；未配置模型时会立即失败并给出原因。
- CI：`.github/workflows/ci.yml` 在 push / PR 时运行 `npm ci`、`npm run verify`、PostgreSQL schema 回归和 `npm audit --omit=dev`。

## 生产边界

- JSONL 适合本地演示和单进程内测；多实例生产环境应完成 PostgreSQL 适配、双写一致性和回滚验证后再切换。
- 未配置高德地理编码密钥时，低置信度模型坐标会保持模糊状态，不用于精确导航。
- 公网部署必须配置独立的 `ROUTEBOOK_API_TOKEN`、`ROUTEBOOK_ADMIN_TOKEN` 和 `PROFILE_ID_SECRET`。
- 不要在公网环境启用 `ALLOW_LOCAL_API_BYPASS` 或 `ALLOW_LOCAL_ADMIN_BYPASS`。
- 截图 OCR 与照片打卡涉及用户数据，部署前需补齐隐私告知、存储期限和删除机制。

## 目录

```text
src/            React 前端与浏览器端业务逻辑
server.mjs      服务入口（API、模型调用、可信分与本地存储）
scripts/        回归、冒烟和结构检查（scripts/lib 为测试共用工具）
test/           node:test 单元 / 集成测试
migrations/     PostgreSQL 基础迁移（尚未接入运行时）
public/assets/  本地演示素材
```

## 架构概览

- **前端**：React 19 单页应用，`src/App.jsx` 负责视图切换；`src/lib/` 为浏览器端业务逻辑（离线打卡队列、本地存储、可信度展示、坐标工具）。
- **服务端**：单进程 Node HTTP 服务，无框架。`/api/*` 由 API 路由处理；`/share/:id`、`/review/:id` 注入 og meta；其余请求在开发模式交给 Vite 中间件，生产模式托管 `dist/`。
- **存储**：`ROUTEBOOK_DATA_DIR` 下的追加式 JSONL（路书版本、打卡、点击、曝光、画像、纠错、回顾等），配置类为 JSON 文件，打卡照片存 `photos/`。多实例部署前需要接入 PostgreSQL。
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
| GET | `/api/checkin-photos/:id`、`/api/map-tiles/:z/:x/:y.png` | 公开（限流） |

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

健康检查：

```bash
curl http://127.0.0.1:5173/api/live
curl http://127.0.0.1:5173/api/ready
curl http://127.0.0.1:5173/api/health
```

如需使用自有模型服务，请在 `.env` 中配置 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` 和 `OPENAI_WIRE_API`。`OPENAI_WIRE_API` 支持 `responses` 与 `chat_completions`；请按上游实际开放的协议选择。`.env` 已被 Git 忽略，不要提交真实密钥。

## 验证

```bash
npm run verify
npm run test:postgres-schema
npm run smoke:api
```

`npm run verify` 会执行语法检查、安全回归、身份迁移、离线打卡队列、核心产品链路、POI / 路书运营回归及生产构建。

## 生产边界

- JSONL 适合本地演示和单进程内测；多实例生产环境应完成 PostgreSQL 适配、双写一致性和回滚验证后再切换。
- 未配置高德地理编码密钥时，低置信度模型坐标会保持模糊状态，不用于精确导航。
- 公网部署必须配置独立的 `ROUTEBOOK_API_TOKEN`、`ROUTEBOOK_ADMIN_TOKEN` 和 `PROFILE_ID_SECRET`。
- 不要在公网环境启用 `ALLOW_LOCAL_API_BYPASS` 或 `ALLOW_LOCAL_ADMIN_BYPASS`。
- 截图 OCR 与照片打卡涉及用户数据，部署前需补齐隐私告知、存储期限和删除机制。

## 目录

```text
src/            React 前端与浏览器端业务逻辑
server.mjs      API、模型调用、可信分与本地存储
scripts/        回归、冒烟和结构检查
migrations/     PostgreSQL 基础迁移
public/assets/  本地演示素材
```

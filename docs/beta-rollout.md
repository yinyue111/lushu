# 内测上线步骤（给 SRE）

回滚点：tag `pre-beta-rollback` = 现在线上的 `2e7e577`（schema 10）。
上线版本：`main`，提交号见「部署记录」。schema 11（多了 0011：funnel-events / client-errors 两个事件流）。

## 0. 部署记录（每一步都要填）
- 上线提交号（`git rev-parse HEAD`）：________
- 镜像 ID / 构建产物校验和：________　**只部署 CI 里测过的同一个产物，服务器上不要重新构建。**
- 旧镜像 ID（回滚用，**保留，不要删**）：________
- 数据库备份文件名和时间：________
- 环境变量改前 → 改后（逐项写，密钥只写「已设 / 未设」）：

| 变量 | 改前 | 改后 |
|---|---|---|
| REGISTRATION_MODE | | 不设或 `open` |
| ENRICH_ENABLED | | `true` |
| GENERATION_DAILY_LIMIT | | 例如 `300` |
| GENERATION_REGION | | `jzh`（只开江浙沪） |
| ALERT_WEBHOOK_URL | | 已设 / 未设（可选） |

## 1. 上线前
1. 备份数据库：`pg_dump -Fc -n trusted_routebook > lushu-$(date +%F-%H%M).dump`，确认文件大小合理，并能 `pg_restore -l` 列出内容。 这份 dump 含用户数据，隐私政策承诺备份最多保留一个月：上线验证完后，30 天内删除或纳入有 30 天上限的轮换（见 README「备份保留期」）。
2. 保留当前运行的镜像（回滚就用它）。
3. 确认新产物来自 CI 通过的提交号，和部署记录一致。

## 2. 环境变量（新增或要改的）
- `REGISTRATION_MODE`：不设或 `open`（不再需要邀请码）。
- `ENRICH_ENABLED=true`：联网补全，内测必须开；还要 `ENRICH_BASE_URL`、`ENRICH_API_KEY`（中继，要有 grok-4.7 + web_search 权限）。可选 `ENRICH_DAILY_BUDGET_USD`（默认 30）、`ENRICH_BUDGET_ALERT_RATIO`（默认 0.8）。
- `GENERATION_DAILY_LIMIT`：全站 24 小时生成上限（默认 300）。
- `GENERATION_REGION`：`jzh`（默认，江浙沪）或 `all`。
- `ALERT_WEBHOOK_URL`：可选；日上限、补全预算 80% 和 100%、前端错误激增时发 JSON，同类每小时一次。
- 高德：`AMAP_GEOCODE_KEY`（地点 / 换店搜索）必须有；道路规划 key `AMAP_ROUTING_KEY` 不设时用 `AMAP_GEOCODE_KEY`，需要确认这个 key 开通了路径规划服务。
- 完整说明见 `docs/deploy.md`、`docs/deploy.env.example`。

## 3. 上线顺序
迁移只增不删（0010 线上已经有了，这次只跑 0011：放宽事件流检查约束、版本号改成 11）。

1. 跑迁移：`node scripts/postgres-migrate.mjs`（用新产物里的脚本），确认版本号：
   `select schema_version from trusted_routebook.storage_state;` → 11
2. **马上**切到新产物并重启。
   - 注意：旧代码要求版本号**完全等于 10**。已经在跑的旧进程会继续工作（启动时检查过一次就缓存了），但**旧进程一旦重启就起不来**。所以第 1 步和第 2 步之间不要重启旧实例；多实例部署时迁移后尽快全部换成新版本。
3. 看启动日志：没有 `[startup] WARNING: ENRICH_ENABLED=false`；`/api/live` 返回 200。

## 4. 上线后冒烟测试（三条全部通过才算上线成功）
1. **新用户注册 + 生成杭州**：新邮箱注册，页面上没有邀请码输入框 → 生成一份杭州路书 → 能打开结果页。
2. **换店**：在这份路书里点某一站的「⋮ → 换一家店」，换成一个地图上搜得到的店 → 新店显示「价格待确认」「你手动添加」，不带旧店的价格、预约、风险；再换成一个搜不到的名字 → 显示「没搜到」，不出现假候选。手动改成地图上找不到的地点时，导航按钮是灰的、不能点。
3. **生成南京**：结果页黄色提示里有「这座城市暂无核实资料，地点本身也可能不准。」；生成朋友链接后，分享页上有「暂无核实资料 · 地点可能不准」。

另外看一眼：运营台「联网补全」页显示在运行、有今日花费 / 预算；「概览」有激活漏斗和信任行为一栏。

## 5. 回滚
1. 把代码切回 tag `pre-beta-rollback` 的旧镜像**之前**，先回退版本号（不删表、不删数据）：
   `psql -f server/migrations/down/0011_funnel_client_errors.down.sql`
   这只把版本号改回 10 并清掉 0011 的迁移记录；新加的事件流数据保留，旧代码不读它们。
2. 切回旧镜像，重启。
3. 跑冒烟测试第 1 条（旧版注册需要邀请码，属正常）。
4. 以后再上线：直接重跑 `postgres-migrate.mjs`，0011 会重新执行（可以重复跑）。
- 已在副本数据库上演练过：用旧 schema 10 的数据副本 → 新代码迁移到 11，能读旧数据 → 旧代码在 11 上拒绝启动（符合预期）→ 跑回退脚本 → 旧代码正常启动、能读数据，新事件行保留 → 再迁移回到 11。脚本：`product-review/round3/rollback-test.sh`（在审计目录）。
- 回滚数据库备份（`pg_restore`）只在数据坏了时才用；会丢掉上线后新写入的数据。

## 6. 第一周每天看
- 「待确认」打开率 = 点开「出发前要确认的事」的人 ÷ 打开路书的人（运营台概览 → 信任行为）。
- 隔天再打开率 = 隔天又打开同一份路书的人 ÷ 打开路书的人。
- 联网补全花费：运营台「联网补全」→ 今日花费 / 预算、近 7 天。实测每份路书约 $0.5，预算 $30 / 天大约够 60 份。
- 另外：激活漏斗（同一批人）、前端错误条数、告警。

## 7. 前端报错栈还原
构建时 source map 放在 `dist-sourcemaps/`，不在静态目录里，外网拿不到（`.map` 请求一律 404）。在服务器上：
`node scripts/symbolicate.mjs "<运营台里看到的报错栈>"`。部署时把 `dist-sourcemaps/` 跟产物一起保留。

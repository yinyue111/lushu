# 管理后台（第一期）

管理后台是一个**独立的前端入口**（`admin/`，由 `vite.admin.config.js` 构建到 `dist-admin/`），挂在 `/admin/`。
用户端包里不含任何后台代码或 `/api/admin` 名字（构建时 `scripts/check-bundle-leaks.mjs` 会检查）。

本文档：怎么开、怎么登录、权限、配置怎么生效、三个数的口径、迁移与回滚、网关建议、冒烟测试、E2E、二期占位，以及**和设计文档 / PRD 的差异与待定事项**。

> 本分支没有改 `docker-compose.prod.yml`、Caddy、镜像仓库或 Dockerfile。下面涉及部署的部分都是**建议**，需要运维确认后再改。

---

## 1. 开关与环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_ENABLED` | 开发 `true`，生产 `false` | 关时 `/admin/*` 和 `/api/admin/*` 都返回 404。 |
| `CONFIG_ENC_KEY` | 生产必须手动设置 | 加密后台里保存的密钥（AES-256-GCM）。不设时：可以改普通配置，**不能保存密钥**。换 key 后旧密钥无法解密，需要重新填。开发环境有一个只用于本地的派生值。 |
| `ADMIN_CONFIG_POLL_MS` | `5000` | 配置轮询间隔（PostgreSQL 还另有 LISTEN/NOTIFY 即时通知）。 |
| `APP_COMMIT` / `APP_BUILD_TIME` / `APP_IMAGE_DIGEST` / `APP_DEPLOY_TIME` | `unknown` | 系统信息页、`/api/health`（commit 前 7 位）、配置导出里显示。没注入就显示 `unknown`，不猜。建议 CI 构建镜像时注入。 |
| `ROUTEBOOK_ADMIN_TOKEN` | — | **只给脚本用**（X-Routebook-Admin-Token）。它打不开 `/api/admin/*`，也**不能改运行时配置**。浏览器里不再保存这个令牌：「旧运维工具」页手动输入，只存在当前页面内存里。 |

### 创建第一个账号

```bash
npm run admin:create -- --username root --role admin            # 开发
npm run admin:create -- --username root --role admin --production
```

命令只打印一次初始密码。首次登录时绑定动态码（TOTP），绑定后显示 8 个一次性备用码。之后在「后台账号」页里新建其他人。

## 2. 登录与安全

- 单独的后台账号（不是用户账号）。密码（scrypt）+ 动态码（RFC 6238，±1 个 30 秒窗口，同一窗口的码不能重复用）。
- 备用码 8 个，每个只能用一次。
- 连续输错 5 次锁 15 分钟（可配置）。
- 会话 Cookie：`__Host-lushu_admin`、HttpOnly、Secure、SameSite=Strict；闲置 30 分钟失效（可配置）。
- 所有写操作要带 `x-admin-csrf`。CSRF 令牌只在页面内存里，所以**刷新页面要重新登录**（不写 localStorage / sessionStorage）。
- 每个写操作都要填原因（至少 4 个字），写进审计表。审计表只增不改（PostgreSQL 有触发器拦 UPDATE/DELETE；JSONL 只追加）。
- 没权限的请求返回 403，同时记一条 `denied` 审计。
- `/admin/` 静态页的响应头：`cache-control: no-store`（HTML）、`x-robots-tag: noindex, nofollow`、`referrer-policy: no-referrer`、CSP `connect-src 'self'`、`frame-ancestors 'none'`。

## 3. 角色与权限（PRD 7.2）

| 能力 | 运营 operator | 管理员 admin |
| --- | :-: | :-: |
| 概览三个数、系统信息 | ✓ | ✓ |
| 纠错队列：查看、改回待确认、设为核实值（必填来源）、驳回、重跑核对 | ✓ | ✓ |
| 纠错：按地点（cacheKey）批量改回 | | ✓ |
| 用户：查找、封禁/解封、重置额度窗口、发恢复码到已验证邮箱 | ✓ | ✓ |
| 用户：改单人额度 | ✓（最多 20，可配置） | ✓ |
| 路书：查找、重跑核对、下架分享链接 | ✓ | ✓ |
| 配置：查看（密钥只显示状态） | ✓ | ✓ |
| 配置：修改、试跑、恢复版本、导出 | | ✓ |
| 邀请码 | | ✓ |
| 审计 | 只看自己 | 全部 |
| 后台账号管理、旧运维工具 | | ✓ |

权限表在 `server/admin/permissions.mjs`，前端只是把服务端会拒绝的入口隐藏掉。

## 4. 运行时配置

### 优先级

每次读取时取当前快照：**后台保存的值 > 环境变量 > 代码里的安全默认值**。没有在后台改过的项一直跟随环境变量。

- 快照整体校验：数据库里任何一项不合法，整份不采用，继续用上一份，并告警 `admin-config-invalid`。
- 启动时数据库连不上：用环境变量启动。运行中连不上：继续用最后一份好的快照，标记 stale，告警 `admin-config-stale`，这时后台不能保存。
- 传播：PostgreSQL 用 `LISTEN routebook_admin_config`（单独一条连接，不占连接池）+ 每 5 秒查一次最大版本号。实测两进程：NOTIFY 约 0.1 秒，仅靠轮询约 4.6 秒。JSONL 单写进程只靠轮询。
- 各进程当前的配置版本可以从 `/api/health` 的 `configVersion` 看到。

### 可配置项

模型（轻快/细品模式：服务商、接口地址、模型名、思考强度、超时，配置页是表单，原始 JSON 收在「高级」里）、备用模型顺序和「上游报错时改用备用模型」开关、模型单价（美元/百万 token，带来源和日期，**由管理员按账单填写；空着就是没有单价，不当 0、不估算**）、注册方式与邀请码、开放城市、首页推荐城市（只能从开放城市里选；默认 杭州/上海/苏州，已去掉 成都/北京/广州）、各种额度、失败是否扣额度（默认不扣）、每日花费上限、联网核对的各项、后台安全参数。密钥（两档模型 key、核对 key）只写不读。

### 备用模型（上游报错 / 超时）

- `model.fallbackOrder`（环境变量 `AI_MODEL_FALLBACK_ORDER`，如 `fast`）默认空 = 不切换，保持现状。
- 配了之后两种情况会改用备用模式：所选模式**没配好**；或所选模式的上游**报错**（403、5xx、连不上、超时、长时间没输出）。只切一次，不会来回试。开关 `model.fallbackOnUpstreamError` 默认开。
- 有备用时，整次生成的时限 = 所选模式的超时 + 备用模式的超时；所选模式自己仍只用自己的超时，备用那段时间不会被它吃掉。
- 用备用模型生成的路书在 `provider.fellBackFrom` 记下原模式，用户打开路书顶部显示「本次由备用模型生成：所选的「细品」模型当时不可用」；ai-logs 里这次记在实际运行的模式下，另带 `fellBackFrom`。
- 备用也失败：报所选模式原来的错误，失败页（细品）显示专门文案和「用轻快重试」按钮。上游失败默认不扣次数（`failuresConsumeQuota=false`）。

### 改模型的规则

1. 改了 `model.fast` / `model.deep` 或对应 key，保存前要用**同一份草稿**试跑成功一次（10 分钟内有效）。
2. 试跑每个管理员每小时 10 次（可配置）；记到 ai-logs，`purpose: admin_test`，计入当天花费但不算用户额度、不进成功率。
3. 试跑失败还要保存：只有管理员能勾「强制保存」，需要填原因，审计里记 `forcedWithoutTestRun`。
4. 关掉「两来源一致」需要二次确认。

### 版本、恢复、导出

每次保存生成一个新版本（`admin_config_versions`）。「恢复到 vN」会生成一个**新版本**，内容等于 vN，不改历史。导出格式：

```json
{
  "format": "lushu-runtime-config",
  "formatVersion": 1,
  "exportedAt": "…",
  "commit": "…",
  "imageDigest": "…",
  "version": 3,
  "createdAt": "…",
  "actor": "root",
  "note": "…",
  "overrides": { "generation.homeCities": ["苏州"] },
  "secrets": { "provider.fast.apiKey": { "redacted": true, "fingerprint": "sha256:1a2b3c4d" } }
}
```

密钥只导出指纹（明文 SHA-256 前 8 位），不导出明文或密文。

## 5. 概览三个数的口径

1. **生成成功率**：`ok / (ok + error)`，只算 `generate-routebook`；取消、去重命中、后台试跑都不算。按北京时间的「今天」和近 7 天，分档位。
2. **待确认占比**：按**站点**算。只看近 7 天内联网核对**已经跑完**的路书；一个站点只要有一个查过的字段（门票/开放时间）最后没补上，就算待确认。没查过的站点（如餐馆）不进分母。
3. **今日花费**：生成 + 局部调整 + 后台试跑（模型单价 × token）+ 联网核对当日花费。**没有单价的调用不按 0 算**：只要有一次没有单价，首屏写「至少 $X」，下面写「另有 N 次没有单价」（成功和失败的调用都算，取消和去重不算）。注意：生成按北京时间的天算，核对花费沿用核对模块自己的 UTC 日。

### 每日成本上限拦截

`cost.dailyLimitUsd`（`COST_DAILY_LIMIT_USD`）设了上限后，由 `cost.capMode`（`COST_CAP_MODE`）决定是否拦截：

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 只有轻快、细品当前用的模型**都有单价**，且今天没有「没有单价」的调用时才拦截；否则不拦截，概览写明原因（如「未生效：grok-x 没有单价」）。现在单价全空，所以**默认等于不拦截**。 |
| `on` | 按已知金额（下限）拦截，没有单价的调用不计。 |
| `off` | 只在概览显示，不拦截。 |

拦截时新的生成请求（轻快、细品都算）返回 429 `COST_CAP_REACHED`，已有路书不受影响。花费每 15 秒重新统计一次。概览「今日花费」卡片下面显示当前的拦截状态。

## 6. 迁移与回滚

迁移 `server/migrations/0012_admin_config.sql` 只加表、加列（`enrich_reports` 加 `status / resolved_by / resolved_at / source`），`schema_version` 11 → 12。已验证：全新库迁移、二次迁移跳过、`apply → down → re-apply`（数据保留）。

上线顺序：备份 → `npm run postgres:migrate` → 换新镜像。

**回滚顺序：先把镜像换回旧版本，再执行回滚 SQL**（`server/migrations/down/0012_admin_config.down.sql`）。旧版本要求 `schema_version` 完全等于 11，所以换回旧镜像后、执行回滚 SQL 前，旧进程会拒绝启动；两步要连着做。回滚 SQL 默认只把版本号改回 11，**不删表不删数据**，再次升级不丢东西；彻底删除的语句在文件里注释着。

JSONL 部署：后台数据在 `data/admin.jsonl`，无需迁移。

## 7. 部署建议（未改动，需运维确认）

### 7.0 上线路径（建议，按这个顺序）

1. **CI 构建镜像**：CI 跑 `npm ci && npm run verify`，再跑 `npm run test:e2e:admin`（Playwright + axe）。**Playwright 用例和 axe 必须全部通过（axe 违规 0）才能出镜像**；不通过不发布。
2. **按 digest 部署**：CI 推镜像后记下 `sha256:` digest，`docker-compose.prod.yml` 里用 `image: …@sha256:…` 引用，不用会被覆盖的 tag；同时把 `APP_COMMIT`、`APP_BUILD_TIME`、`APP_IMAGE_DIGEST` 注入，系统信息页才不会显示「未注入」。
3. **数据库**：备份 → `npm run postgres:migrate` → 换镜像（见第 6 节）。
4. **/admin 放在 Caddy basic auth 后面**（加 IP 白名单，见 7.2），应用里 `ADMIN_ENABLED=true`；应用自己的账号 + 动态码是第三层。
5. **冒烟**：`node scripts/smoke-prod.mjs …`（第 8 节），白名单机器上加 `--admin-reachable`。
6. 回滚：把 digest 换回上一版（数据库回滚见第 6 节）。

本分支**没有**改 Dockerfile、compose、CI 和 Caddy，以上需要运维照做并确认上线日期。

### 7.1 镜像

当前 Dockerfile 的运行层只复制了 `dist/`。要在生产开后台，需要在运行层加一行：

```dockerfile
COPY --from=build --chown=root:root /app/dist-admin ./dist-admin
```

（构建层的 `npm run build` 已经会同时构建两个入口。）不加这一行时，即使 `ADMIN_ENABLED=true`，`/admin/` 也只会返回「dist-admin 不存在」。

### 7.2 Caddy：给 /admin 加 IP 白名单 + Basic Auth

```caddyfile
example.com {
	@admin path /admin /admin/* /api/admin/*
	handle @admin {
		@outside not remote_ip 203.0.113.10/32 198.51.100.0/24
		respond @outside 404
		basic_auth {
			# caddy hash-password --plaintext '…'
			ops $2a$14$REPLACE_WITH_HASH
		}
		header -Server
		reverse_proxy app:3080
	}

	handle {
		reverse_proxy app:3080
	}
}
```

两层之外，应用自身还有账号 + 动态码。白名单外返回 404 而不是 403，不暴露后台存在。

### 7.3 可选：子域名

也可以挂到 `admin.example.com`：网关把整个子域名转发到应用，并只在这个子域名上放行 `/admin` 和 `/api/admin`，主域名上对这两个前缀直接 `respond 404`。优点是 Cookie 与主站完全隔离、白名单更好写；代价是多一张证书和一条 DNS。当前代码按路径 `/admin` 实现，换子域名不用改代码（`__Host-` Cookie 绑定在当前主机名上）。

## 8. 冒烟测试

```bash
node scripts/smoke-prod.mjs --base https://example.com --commit "$(git rev-parse --short HEAD)"
# 可选：--share-id <固定分享样例>  --generate（真实调一次轻快档，需要 SMOKE_ACCESS_CODE）
# 在白名单机器上运行时加 --admin-reachable
```

检查：首页 200 且有 root 节点；`/api/health` ok 且有 commit；（可选）生成一次；（可选）分享样例能打开；`/.env`、`/.git/config`、`/.git/HEAD`、`.js.map`、`/dist-sourcemaps/` 都是 404；白名单外 `/admin/` 和 `/api/admin/me` 是 401/403/404。

## 9. 测试

- 单元 / 集成：`npm run test:unit`（含 `admin-runtime-config`、`admin-console`、`admin-static`、`offline-banner`）。
- PostgreSQL：`test:postgres-schema`、`test:postgres-storage`、`test:postgres-runtime`（新增两进程配置传播：NOTIFY 和仅轮询两条路径）。
- E2E + 无障碍：`npm run build && npm run test:e2e:admin`。真服务器 + 真浏览器走完登录/绑定/备用码、纠错批量改回、用户、路书下架、配置预览/保存/城市列表 5 秒内生效、邀请码、试跑门槛、审计、系统信息、后台账号、运营只读，每页跑 axe（WCAG 2.1 AA）。需要 `playwright` 和 `axe-core`：目前**不是**仓库依赖，可以 `npm i -D playwright axe-core`，或设 `E2E_TOOLS_DIR` 指向已有的 node_modules。截图写到 `E2E_SCREENSHOT_DIR`（默认 `test-results/admin-e2e`）。
- 开发：`npm run dev` 起服务后，`/admin/` 读的是构建好的 `dist-admin/`；要热更新用 `npx vite -c vite.admin.config.js`（端口 5175，代理 `/api`）。

## 10. 二期：已核实地点库（占位）

第一期「设为核实值」时把结果按 cacheKey 存进 `admin_verified_facts`（值、来源链接、查询日期、核实人、到期时间，默认 90 天）。有效期内，同一地点的联网核对直接用人工值，用户端显示「人工核实 · 日期」。后台有一个只读占位页。二期计划：按城市浏览、到期提醒、批量复核、导入官方来源（范围待产品确认）。

## 11. 用户端改动

- 删除用户端里的 `/ops`、`/logs` 页面和对应懒加载，原面板搬到后台「旧运维工具」。
- 用户端不再在浏览器里存运营令牌。
- 用词统一为「核对」：「核对中」「已核对」「已反馈待复核」「人工核实」「待确认」，后台和用户端一致（后台的状态词集中在 `admin/src/terms.js`）。
- 来源说明按实际情况写：人工核实的值写「人工核实：运营人员按来源核对过」（可能只有 1 个来源）；自动核对按来源数写「N 个来源说法一致」或「只找到 1 个来源」，不再一律写「两个来源一致」。
- 报错可以写备注（选填）；提交后原位显示回执号，那条值**继续显示**并标「已反馈待复核」，直到运营核实 / 改回待确认 / 驳回。重复报同一条返回同一个回执。共享缓存里的这条值会被清掉，新路书不会再用它。
- 运营「设为核实值」按地点生效：同一地点（同一 cacheKey）的所有路书立刻改成人工核实值，同一地点其他未处理的报错一起标为已处理。
- 细品因上游失败时，失败页显示专门文案和「用轻快重试」；备用模型生成的路书顶部显示「本次由备用模型生成」。
- 路书页离线时顶部显示「离线查看，信息更新于<时间>」（取路书自己的最新时间戳，北京时间；没有时间戳就写「信息更新时间未知」，不编时间）。
- 用户端主包约 408 KB（改前约 411 KB），后台代码不在其中。

## 12. 与设计文档 / PRD 的差异

- 表名和主键：用 `admin_config_versions` / `admin_audit` / `admin_invite_codes` 和文本 id，没有用设计里的 `config_versions` / `admin_audit_log` / `invite_codes` 和 bigserial。
- `registration.mode`：环境变量没设时保持现在的 `open`，没有按设计默认成 `invite`。
- `model.fallbackOrder` 默认 `[]`（保持现状），设计写的是 `['fast']`；配了之后对上游报错 / 超时也生效（第 4 节）。
- `failuresConsumeQuota` 默认 `false`：**改变了现有行为**（以前失败也扣），这是按 PRD 来的。
- 试跑限流用 PRD 的每小时 10 次；设计里的每分钟/每天上限和 `ADMIN_TEST_DAILY_COST_CAP` 没做。
- 「N/N 个进程已生效」没做；各进程的版本号通过 `/api/health` 的 `configVersion` 看。
- 用户列表没显示每个用户的路书数。
- 旧接口 `/api/ops/users` 的 issue-recovery **默认不再返回恢复码**（403 `OPS_RECOVERY_PLAINTEXT_DISABLED`），设 `OPS_RECOVERY_CODE_PLAINTEXT=true` 才恢复旧行为；旧运维工具里的按钮已去掉。后台里的「发恢复码」只发到已验证邮箱，运营看不到码。
- 未设置注册方式时默认 `open`，概览顶部红框警告、系统信息写「开放（未设置，默认）」。
- 邀请码在创建用户前一刻才扣次数。
- `enrich.maxSearchesPerRun` 对应原来的 `ENRICH_MAX_SEARCHES_PER_ROUTEBOOK`；`maxStopsPerRun` 是新加的。
- 刷新后台页面需要重新登录（CSRF 只在内存里）。
- 静态服务对点开头的路径（`/.env`、`/.git/…`）和 `/dist-sourcemaps/` 直接 404，不再回退到首页 HTML。

## 13. 待定事项（需要负责人拍板）

1. Dockerfile 加 `COPY dist-admin`、Caddy 白名单/Basic Auth、`APP_*` 注入、CI 出镜像按 digest 部署：本分支只写了建议（7.0），没有改；需要定上线日期。
2. `playwright` / `axe-core` 是否加进 devDependencies（会改 lockfile），以及 E2E 是否进 CI。
3. 旧 issue-recovery：已加开关并默认关；是否彻底删掉这个分支。
4. 未设置时注册方式默认 `open` 还是 `invite`。
5. 模型单价由谁、按什么来源维护（目前全空：花费只显示下限，日上限 `auto` 模式不拦截）。
8. 是否给 `model.fallbackOrder` 设默认值（如细品失败改用轻快）；现在默认空。
6. 挂路径 `/admin` 还是子域名。
7. 「旧运维工具」各面板并入新页面的顺序和时间。

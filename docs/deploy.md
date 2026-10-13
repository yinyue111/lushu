# 生产部署（Docker Compose + 宿主机 Caddy）

目标环境：2 vCPU、约 1.4 GB 可用内存的单机；应用只监听 `127.0.0.1:3080`，由宿主机 Caddy 反代到 `https://lushu.aiwuq.cn`；存储用 PostgreSQL 16。

## 文件

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | 两阶段构建：`npm ci` + `vite build` + `npm prune --omit=dev`；运行镜像 `node:22-slim`，非 root（`node` 用户），只有 `/data` 可写，`HEALTHCHECK` 访问 `/api/live` |
| `docker-compose.prod.yml` | `db`（postgres:16，`pgdata` 卷）+ `app`（`127.0.0.1:3080:3080`，`env_file: .env`，`appdata` 卷挂到 `/data`）+ 一次性 `migrate`（profile `tools`） |
| `docs/deploy.env.example` | `.env` 模板，只有变量名，没有任何密钥 |

## 首次上线

```bash
cp docs/deploy.env.example .env && chmod 600 .env   # 填好密钥（见下方变量表）
# APP_IMAGE = CI 构建的镜像（.github/workflows/image.yml），按 digest 固定，写进 .env：
#   APP_IMAGE=ghcr.io/<owner>/lushu-app@sha256:<digest>
# 服务器上不构建镜像，也不用 latest。
docker compose -f docker-compose.prod.yml pull app
docker compose -f docker-compose.prod.yml up -d db
docker compose -f docker-compose.prod.yml run --rm migrate   # 建表 → 空数据回填 → 标记就绪
docker compose -f docker-compose.prod.yml up -d app
curl -fsS http://127.0.0.1:3080/api/ready                     # storage.ready=true 才算好
```

`migrate` 依次执行 `postgres-migrate`、`postgres-backfill --apply`、`postgres-parity --mark-ready`。全新空库时回填为 0 行，parity 一致后写入就绪标记；不做这一步，`/api/ready` 会一直是 503。升级版本：把 `.env` 里的 `APP_IMAGE` 换成新 digest（旧 digest 记进部署记录，用于回滚）→ `pull app` → `run --rm migrate`（迁移幂等；库已切换就绪时，回填和 parity 会打印 “already cut over; skipping” 并正常退出）+ `up -d app`。已有 JSONL 数据要迁入时，先把旧数据目录放进 `appdata` 卷，再跑 `migrate`（见 README「存储切换与备份」）。

## Caddy

```caddyfile
lushu.aiwuq.cn {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3080 {
		transport http {
			read_timeout 400s
			write_timeout 400s
		}
	}
}
```

Caddy 默认会追加 `X-Forwarded-For`。生成任务走异步长轮询（单次最长 15 秒），只有旧的同步接口需要长超时，上面的 400s 覆盖 `REQUEST_TIMEOUT_MS`（默认 390s）。

## 反代与 TRUST_PROXY

**需要。** 不开时，所有请求的来源都是反代那一跳，按 IP 的限流会把全体用户算成同一个人。

- compose 部署：compose 文件已设置 `TRUST_PROXY_HEADERS=true`。请求经 docker-proxy 进容器，来源是网桥网关 `172.31.80.1`（compose 里把子网固定为 `172.31.80.0/24`），所以 `TRUSTED_PROXY_CIDRS` 默认是 `172.31.80.1,127.0.0.1,::1`。如果这个子网和宿主机已有网络冲突，就同时改 compose 里的 `subnet`/`gateway` 和 `.env` 里的 `TRUSTED_PROXY_CIDRS`。
- 不用 Docker、直接 `npm start`：设 `HOST=127.0.0.1 PORT=3080 TRUST_PROXY_HEADERS=true`；`TRUSTED_PROXY_CIDRS` 的默认值 `127.0.0.1,::1` 正好是 Caddy。
- 服务从右往左读 `X-Forwarded-For`，跳过可信代理，所以客户端自己伪造的最左项不会生效。带转发链的请求一律不算“本机”，生产环境也默认关闭本机免鉴权。

## 内存（1.4 GB 可用）

| 进程 | 限制 | 实测 |
| --- | --- | --- |
| app（Node） | `NODE_OPTIONS=--max-old-space-size=384`，容器 `mem_limit: 640m` | 空载 RSS 约 80 MB（2026-10-09 预演） |
| db（PG 16） | `shared_buffers=96MB`、`max_connections=30`，`mem_limit: 384m` | — |
| 镜像构建（`vite build`） | 构建阶段 `--max-old-space-size=1024` | 构建进程树峰值约 570 MB |

两者合计上限约 1 GB，给宿主机和 Caddy 留了余量。构建时最好先停 app，或者在别的机器上构建好镜像再推过来。应用连接池默认 10（`POSTGRES_POOL_MAX`），单实例足够。

## 环境变量

“必填”指按本次上线决策必须设置；其余有安全默认值。密钥只放 `.env`（不进仓库），也不要贴进工单或日志。

### 必填

| 变量 | 本次取值 | 作用 |
| --- | --- | --- |
| `APP_IMAGE` | `ghcr.io/<owner>/lushu-app@sha256:…` | 必填。CI 镜像按 digest 固定；compose 不再 `build`，也不用 `latest`。同时作为 `APP_IMAGE_DIGEST` 传给应用 |
| `POSTGRES_PASSWORD` | 随机（仅字母数字） | db 初始化密码；compose 用它拼 `DATABASE_URL` |
| `PROFILE_ID_SECRET` | 随机 ≥32 位 | 用户身份与路书编辑凭证的 HMAC 密钥；生产缺失会拒绝启动；上线后不可更换 |
| `ROUTEBOOK_ADMIN_TOKEN` | 随机 | 运营后台令牌（请求头 `x-routebook-admin-token`） |
| `ROUTEBOOK_API_TOKEN` | 访问码 | 生成访问码：公网用户必须在「高级设置」填写才能生成 |
| `ALLOW_PUBLIC_MODEL_PROXY` | `true` | 允许带访问码的公网请求调用模型；不设则公网一律不能生成 |
| `OPENAI_BASE_URL` | `https://t.aiwuq.cn/v1` | 模型中转根地址（服务会拼 `/chat/completions`） |
| `OPENAI_MODEL` | `grok-4.7` | 模型 id |
| `OPENAI_WIRE_API` | `chat_completions` | 中转只支持 Chat Completions |
| `OPENAI_API_KEY` | 中转 key | 模型调用凭证 |
| `AI_PROVIDER` | `aiwuq` | 只用于日志和成本统计 |
| `AI_PROVIDER_REGION` | `overseas` | 只影响启动时的合规提醒（不阻止启动） |
| `MAP_TILE_PROVIDERS` | `amap` | 底图；生产环境不允许 OSM |
| `AMAP_TILE_KEY` | 高德 key | 高德底图瓦片；生产环境用高德底图时必填，否则拒绝启动 |
| `AMAP_GEOCODE_KEY` | 高德 Web 服务 key | 站点定位（POI 搜索/地理编码）；不填时坐标只是近似值 |
| `PUBLIC_BASE_URL` | `https://lushu.aiwuq.cn` | 分享页 og:url / og:image 的绝对地址 |
| `PUBLIC_PUBLISHING` | `disabled` | 关闭公开发布：所有路书只能私用或发朋友链接，用户和运营都不能公开上架（已公开的不受影响） |
| `IMPORTED_ROUTEBOOK_PUBLIC_POLICY` | `unlisted-only` | 导入（链接/截图）生成的路书永不公开；和上一项一起写上，双保险 |
| `GENERATION_QUOTA_PER_PROFILE` | `5` | 每个注册 profile 在窗口内最多生成 5 次（取消的不计） |
| `JEV_SHADOW_ENABLED` | `true` | 开启 Jev 影子评审（只记录、不影响用户） |
| `TYPESAFE_API_KEY` | 由 SRE 填写 | Jev 凭证；不填时影子评审自动不启用 |

compose 已在文件里固定：`NODE_ENV=production`、`HOST=0.0.0.0`（容器内）、`PORT=3080`、`ROUTEBOOK_DATA_DIR=/data`、`STORAGE_BACKEND=postgres`、`DATABASE_URL`、`TRUST_PROXY_HEADERS=true`、`TRUSTED_PROXY_CIDRS`。不用 compose 时，这些要自己设置，其中 `HOST=127.0.0.1`。

### 可选（默认即可）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `GENERATION_DAILY_LIMIT` | `300` | 全站每日生成上限（整本生成 + AI 局部调整，滚动 24 小时，所有用户合计）；超出返回 429 并在服务端日志告警。`0` = 不限 |
| `GENERATION_REGION` | `jzh` | 能生成的城市范围：`jzh`＝江浙沪（上海、江苏 13 市、浙江 11 市），`all`＝全国已支持城市。可信城市仍只有有已审核数据的那几座 |
| `GENERATION_QUOTA_WINDOW_MS` | `86400000` | 配额滚动窗口（24 小时） |
| `AI_TIMEOUT_MS` | `300000` | 一次生成的总时长上限（所有模型调用 + 定位 + 道路核验）；到点自动停止，报 MODEL_TIMEOUT。grok-4.7 单次调用实测 85–180 秒 |
| `AI_CALL_TIMEOUT_MS` | 同 `AI_TIMEOUT_MS` | 单次模型调用上限，且不会超过剩余的总时长 |
| `GENERATION_DEFAULT_MODE` | `fast` | 生成方式默认值：`fast`（轻快）或 `deep`（细品），用户可在「你想怎么玩？」里切换 |
| `AI_MODEL_FAST` | `gemini-3.8-flash-high` | 轻快用的模型（中继 t.aiwuq.cn 上的 id）。Gemini 的思考档位由后缀决定：`-low` / `-medium` / `-high`；不带后缀的 `gemini-3.8-flash` 在中继上暂无可用账号 |
| `AI_REASONING_EFFORT_FAST` / `_DEEP` | 空 / `xhigh` | 发给模型的 `reasoning_effort`（low / medium / high / xhigh；中继不认识的值会被静默忽略）。细品默认 xhigh：实测和 high 一样快，比不发参数（超过 200 秒）快得多。写 `none` 表示不发 |
| `AI_MODEL_DEEP` | 空＝`OPENAI_MODEL` | 细品用的模型（grok-4.7） |
| `AI_TIMEOUT_MS_FAST` / `_DEEP` | `min(120000, AI_TIMEOUT_MS)` / `AI_TIMEOUT_MS` | 每种方式一次生成的总时长上限 |
| `AI_MAX_OUTPUT_TOKENS_FAST` / `_DEEP` | `12000` / `12000` | 每种方式的输出上限（推理模型的思考也算） |
| `AI_STREAM` | `true` | 流式读取模型输出（SSE）；`false` 退回整包等待 |
| `AI_STREAM_IDLE_MS_FAST` / `_DEEP` | `30000` / `150000` | 流式时多久没有任何输出就停止（MODEL_STALLED），不用干等到总时长 |
| `GENERATION_QUOTA_DEEP_PER_PROFILE` | `0` | 细品在共享额度之内的额外上限（0＝不单独限制） |
| `REQUEST_TIMEOUT_MS` | `AI_TIMEOUT_MS + 90000` | 同步生成接口的 HTTP 请求超时 |
| `HEADERS_TIMEOUT_MS` / `SHUTDOWN_GRACE_MS` | `15000` / `10000` | 请求头超时；收到 SIGTERM 后的优雅退出等待时间 |
| `GEOCODE_TIMEOUT_MS` / `ROUTING_TIMEOUT_MS` | `5000` / `8000` | 高德定位 / 路线校验超时 |
| `AMAP_ROUTING_KEY` | 同 `AMAP_GEOCODE_KEY` | 路线校验单独用一把 key 时设置 |
| `AMAP_QPS` / `ROUTING_CONCURRENCY` | `3` / `3` | 高德调用节流 |
| `IMPORT_TIMEOUT_MS` | `12000` | 抓取导入链接的超时 |
| `GENERATION_MAX_ACTIVE_JOBS` | `2` | 每个客户端同时进行的生成任务数 |
| `GENERATION_DEDUP_TTL_MS` | `600000` | 相同请求 10 分钟内复用结果 |
| `AI_MAX_OUTPUT_TOKENS` / `_RETRY` | `6000` / `12000` | 输出 token 上限。第一次被截断才用 `_RETRY` 再调一次（剩余时间不够就不重试）；推理型模型的思考也算输出，常被截断的话把 `AI_MAX_OUTPUT_TOKENS` 直接调到 12000，省掉第二次调用 |
| `JEV_SHADOW_SAMPLE_RATE` | `1` | 影子评审抽样率（0–1） |
| `JEV_SHADOW_TIMEOUT_MS` | `800` | 单次 Jev 调用超时 |
| `JEV_SHADOW_MAX_IN_FLIGHT` | `8` | Jev 并发上限 |
| `JEV_API_URL` / `JEV_MODEL` | `https://api.typesafe.ai/v1/systemone` / `jev-latest` | 一般不改 |
| `RATE_LIMIT_*` | 见 `server/config/index.mjs` | 分桶限流（AI 桶 `RATE_LIMIT_MAX` 默认每分钟 12 次） |
| `POSTGRES_POOL_MAX` | `10` | 连接池大小 |
| `PROFILE_IDENTITY_ASSERTION_SECRET` | 空 | 外部登录断言签名；不接外部登录就不设 |
| `MODERATION_PROVIDER` / `MODERATION_API_URL` / `MODERATION_API_KEY` | `keyword` | 内容安全；本次上线只做关键词预过滤（启动时会提醒） |
| `AI_COST_CURRENCY` / `AI_INPUT_COST_PER_MILLION_TOKENS` / `AI_OUTPUT_COST_PER_MILLION_TOKENS` | 空 | 成本估算 |
| `BACKUP_ENCRYPTION_KEY` | 空 | `npm run backup:data` 加密备份时需要 |

防编造（两种方式都生效，无需配置）：提示词要求门店/分店名、门牌号、票价、人均价格、营业时间、电话、活动日期只能来自用户攻略、导入来源或运营已审核的 POI；生成后服务端再按规则抽取这些具体信息逐条核对，找不到出处的改成“地址待确认 / 价格待确认 / 营业时间待确认”等（站点名里的“（XX总店）”直接去掉），并在路书里加一条“具体信息待确认”提示。改写条数记在 AI 日志的 `observability.factGuard`（total / byKind / events）。行程里的时间段（stop.time）不算具体信息，不会被改。

### 账号（邮箱 / 手机号 + 密码）

默认 `AUTH_MODE=access-code`，行为和现在完全一样，账号接口返回 404。切换步骤和回滚见 [`docs/login-rollout.md`](./login-rollout.md)。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `AUTH_MODE` | `access-code` | `access-code`：只有访问码；`both`：登录或访问码都能生成（过渡期）；`login`：导入、生成、保存草稿、行程同步、打卡、收藏、纠错都要登录，访问码不再管用。回滚就是改回 `access-code` 并重启 |
| `REGISTRATION_MODE` | `open` | `open`（默认，内测不要邀请码）/ `invite`（注册要邀请码，可随时切回）/ `closed`（只能登录）。开放注册时防滥用靠人机校验、邮箱验证码、限流、生成配额和全站日预算 |
| `REGISTRATION_INVITE_CODE` | 同 `ROUTEBOOK_API_TOKEN` | 邀请码；不设时沿用现在的访问码，内测用户不用换 |
| `AUTH_PHONE_HASH_SECRET` | 无 | **秘密**。手机号 HMAC 密钥，≥32 位随机串，`AUTH_MODE` 不是 `access-code` 时缺失会拒绝启动。**必须离线备份**：丢失或更换后，所有账号都按手机号找不到 |
| `AUTH_EMAIL_HASH_SECRET` | 无 | **秘密**。邮箱 HMAC 密钥，≥32 位，必须离线备份；丢失后按邮箱找不到账号 |
| `AUTH_EMAIL_ENC_KEY` | 无 | **秘密**。邮箱加密密钥（AES-256-GCM），≥32 位，必须离线备份；丢失后读不出邮箱、发不了信 |
| `MAIL_TRANSPORT` | 生产 `disabled`，开发 `file` | `smtp`：用自己的邮件服务器发；`resend`：用 Resend 发；`log`：只记「已发给 ab***@x.com」；`file`：写到 `/data/mail-outbox`（测试用，生产启动会警告）；`disabled`：不发 |
| `MAIL_FROM` / `MAIL_API_KEY` / `MAIL_API_URL` | 空 / 空 / Resend | `resend` 时前两个必填，否则拒绝启动；`smtp` 时 `MAIL_FROM` 必填 |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | 空 / 按加密方式 587、465、25 | `smtp` 时主机必填。容器里的 `localhost` 是容器自己，同机邮件服务器请用域名或 `host.docker.internal` |
| `MAIL_SMTP_SECURE` | `starttls` | `starttls`：必须升级加密，对方不支持就不发；`tls`：465 直接加密；`none`：不加密，只允许 `localhost`；内网 IP（10/8、172.16/12、192.168/16、fc00::/7，如 Docker 网桥网关）还要设 `MAIL_SMTP_ALLOW_PLAINTEXT_PRIVATE=true`；公网地址和主机名拒绝启动 |
| `MAIL_SMTP_ALLOW_PLAINTEXT_PRIVATE` | `false` | 允许 `none` 发到内网 IP。生产宿主机 Postfix 中继需要它 |
| `MAIL_SMTP_USER` / `MAIL_SMTP_PASS` | 空 | **秘密**（密码）。不写进日志 |
| `MAIL_SMTP_TLS_VERIFY` | `true` | 校验邮件服务器证书。生产设 `false` 拒绝启动 |
| `MAIL_SMTP_CA_FILE` | 空 | 邮件服务器用自签或内部 CA 时，信任这个 PEM 文件；文件不存在拒绝启动 |
| `MAIL_SMTP_TIMEOUT_MS` | `15000` | 连接、握手、等待应答的超时 |
| `EMAIL_VERIFICATION_REQUIRED` | `true` | 注册必须填邮箱验证码。为 `true` 但发信没配（`disabled`/`log`）时生产拒绝启动；过渡期设 `false` |
| `EMAIL_CODE_RESEND_SECONDS` | `60` | 同一邮箱两次验证码的最短间隔 |
| `AUTH_SESSION_TTL_DAYS` / `AUTH_SESSION_MAX_DAYS` | `30` / `90` | 空闲过期天数 / 最长有效天数 |
| `AUTH_POW_DIFFICULTY` | `16` | 注册、找回密码、可疑登录前的人机检查强度（浏览器里算 0.1–1 秒） |
| `AUTH_SCRYPT_CONCURRENCY` | `2` | 同时计算的密码哈希数；每个约 32 MB，1.4 GB 机器保持 2 |
| `AUTH_PASSWORD_PEPPER` | 空 | 可选的密码哈希附加密钥；设了就不能改 |

说明：

- 登录 Cookie 是 `__Host-lushu_sid`（HttpOnly、Secure、SameSite=Lax）。必须走 HTTPS（Caddy 已满足）；本机 `http://localhost` 开发也能用（浏览器把 localhost 当安全来源）。
- 账号表在 PG 里：`auth_users`、`auth_sessions`、`auth_throttles`、`auth_profile_links`（迁移 0008）、`auth_email_codes` 和 `auth_users` 上的邮箱列（迁移 0009，只新增）。JSONL 后端写 `/data/accounts.jsonl`。备份 PG 时一起带上；`AUTH_PHONE_HASH_SECRET`、`AUTH_EMAIL_HASH_SECRET`、`AUTH_EMAIL_ENC_KEY` 单独离线保存。
- 邮箱只存 HMAC、AES-GCM 密文和打码地址；验证码只存 HMAC，15 分钟、一次性、每码最多试 5 次；每个邮箱每小时最多 5 封、每个网络地址每小时最多 20 封。
- 手机号只存 HMAC 和打码号码；密码用 scrypt（版本化参数）；恢复码只存摘要；日志里没有手机号、密码和会话 ID。
- 运营在后台「账号」页按完整邮箱、完整手机号或手机号后 4 位搜索，看到打码邮箱和是否已验证；停用/恢复、强制退出、补发一次性恢复码、单独设生成额度；每个操作都要写原因，记入 `ops-audits`。

生产环境不要设置：`ALLOW_LOCAL_API_BYPASS`、`ALLOW_LOCAL_ADMIN_BYPASS`、`ALLOW_OSM_BASEMAP_IN_PRODUCTION`、`AI_RUNTIME_FROM_CODEX`。

### 联网补全（门票 / 开放时间）

登录用户的路书保存后（两种生成方式都算），后台排队核对景点的门票（含“免费”）和开放时间。生成不等它，用户先拿到路书；站点下方先显示“正在核对门票和开放时间…”，核对完自动刷新（重新打开路书也会更新）。访客生成的路书不核对。

规则（不编造）：
- 只核对景点；餐馆的地址、电话、人均一律不补；攻略没写分店的连锁店永远不补。
- 来源：先查高德 POI（同名、3 公里内、唯一一家才算），再用 `ENRICH_MODEL`（默认 grok-4.7）通过中继 `/v1/responses` 的 web_search 联网搜索。搜索引用的页面由我们自己抓取核对，页面里离地点名不远处确实写着这个值才算。只抓公网地址（复用导入攻略的 SSRF 防护：DNS 固定、重定向复查、大小和时间上限），遵守 robots.txt，不抓 `ENRICH_BLOCKED_DOMAINS`（默认含大众点评、美团、小红书、携程、去哪儿等）。
- 两个独立来源一致才显示：高德 + 1 个网页，或 2 个不同网站的网页。“全天开放”等同于 00:00-24:00。来源冲突或只有一个来源，就保留“待确认”。
- 每条都记录值、来源（网址、标题、域名）、查询时间和核对方式；页面上显示为“免费 · 来自X等2个来源 · 查询于日期”，点开能看到链接，用户可以点“报告有误”。报错后这条立刻隐藏，共享缓存里的这一条也删掉，运营在「联网补全」页能看到。
- 路书正文不改：防编造检查后的“待确认”原样保存，补全结果单独存放。页面上某项核对到后，就只显示核对结果、隐藏原来那句“门票待确认 / 开放时间待确认”；用户报错后恢复原文。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ENRICH_ENABLED` | `false` | 打开联网补全。**内测配置必须设 `true`**（另需中继密钥，见下）；生产没开时启动日志会警告，运营台「联网补全」页显示没在运行的原因 |
| `ENRICH_MODEL` | `grok-4.7` | 联网搜索用的模型（需要中继 Responses 接口支持 web_search；gemini 的引用不是结构化字段，不用） |
| `ENRICH_BASE_URL` / `ENRICH_API_KEY` | 同 `OPENAI_BASE_URL` / `OPENAI_API_KEY` | 一般不用单独配 |
| `ENRICH_DAILY_BUDGET_USD` | `30` | 全站每天（UTC）联网搜索花费上限，超出后当天不再搜索，只保留待确认 |
| `ENRICH_MAX_SEARCHES_PER_ROUTEBOOK` | `12` | 每份路书最多搜索次数（每个景点一次；只有一个来源的项目再换个问法补搜一次） |
| `ENRICH_MAX_USD_PER_ROUTEBOOK` | `1.5` | 每份路书花费上限（按本份里最贵的一次搜索预估下一次，可能略超；中继没报花费时按 `ENRICH_ASSUMED_USD_PER_SEARCH`=0.1 计） |
| `ENRICH_CACHE_DAYS` | `7` | 同一城市 + 地点 + 字段的结果缓存天数（核对到的和确认核对不了的都缓存；因额度不够没查的不缓存） |
| `ENRICH_CONCURRENCY` | `2` | 同时核对的路书数 |
| `ENRICH_MAX_ATTEMPTS` / `ENRICH_RETRY_BASE_MS` | `4` / `60000` | 失败重试次数和退避（1、4、16 分钟…） |
| `ENRICH_LEASE_MS` | `600000` | 进程中途退出时，正在核对的任务过多久被重新捡起 |
| `ENRICH_POLL_MS` | `5000` | 队列轮询间隔 |
| `ENRICH_SEARCH_TIMEOUT_MS` / `ENRICH_PAGE_TIMEOUT_MS` / `ENRICH_PAGE_MAX_BYTES` | `180000` / `10000` / 2 MB | 单次搜索、单个页面的时间和大小上限 |
| `ENRICH_BLOCKED_DOMAINS` | 见上 | 逗号分隔，子域名一起屏蔽 |
| `ENRICH_ALLOW_PRIVATE_FETCH_FOR_TESTS` | 不设 | 只给自动化测试用；生产绝不要设置 |

高德用已有的 `AMAP_GEOCODE_KEY`；没配高德时只靠网页，规则不变（必须两个不同网站）。任务队列存在 PostgreSQL（迁移 0010，新增 `enrich_*` 表）或 JSONL（`enrichment.jsonl`），重启不丢。实测（旧额度）每份路书约 $0.2–0.35、补全约 3–4 分钟；新额度下会多搜一些，预计每份 $0.3–1、5 分钟左右（不阻塞用户）。

## 已知限制

- 每天 5 次的配额按 profile 计；登录后按账号的主 profile 计，运营可以给单个账号改额度。没有 profile 的匿名请求只受访问码和按 IP 的 AI 限流约束。
- 照片和 JSONL 日志存在 `appdata` 卷（`/data`）里，需要和 PG 一起备份。
- 本仓库所在的开发机没有 Docker。2026-10-09 只做了两项验证：用同样步骤离线构建了运行时文件，并在全新 PG 库上完成迁移、回填、就绪标记和生产模式启动；另外解析了 compose 的 YAML。第一次真正 `docker compose build` 后，请先检查健康状态再切流量。

## 告警（可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ALERT_WEBHOOK_URL` | 空 | 配了就在全站日生成上限触发、联网补全日预算用完、前端错误激增时 POST 一条 JSON（`{type,message,at,service}`），同类每小时最多一次；没配只写日志 |
| `ENRICH_BUDGET_ALERT_RATIO` | `0.8` | 联网补全当日花费到预算的这个比例时告警一次（每份路书实测约 $0.5） |
| `ALERT_CLIENT_ERRORS_PER_HOUR` | `30` | 前端错误激增的阈值（每进程近 1 小时条数） |

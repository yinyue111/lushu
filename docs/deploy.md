# 生产部署（Docker Compose + 宿主机 Caddy）

目标环境：2 vCPU、约 1.4 GB 可用内存的单机；应用只监听 `127.0.0.1:3080`，由宿主机 Caddy 反代到 `https://lushu.aiwuq.cn`；存储用 PostgreSQL 16。

## 文件

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | 构建阶段 `npm ci` + `vite build`；运行依赖单独 `npm ci --omit=dev`（不含 playwright/axe-core，不下载浏览器）；运行镜像 `node:22.23.3-slim`（和 `.nvmrc` 一致），非 root（`node` 用户），只有 `/data` 可写，`HEALTHCHECK` 访问 `/api/live` |
| `docker-compose.caddy.yml` | 可选 override：Caddy 容器固定 IP 接入 `lushu_backend`，app 切到 `PROXY_MODE=container`（见「Caddy 两种部署方式」）。默认不用 |
| `docker-compose.prod.yml` | `db`（postgres:16，`pgdata` 卷）+ `app`（`127.0.0.1:3080:3080`，`env_file: app.env`，`appdata` 卷挂到 `/data`）+ 一次性 `migrate`（profile `tools`） |
| `docs/deploy.compose.env.example` | `.env` 模板（compose 变量替换用）：`APP_IMAGE`、owner 密码、应用角色密码 |
| `docs/deploy.env.example` | `app.env` 模板（应用设置），只有变量名，没有任何密钥；不含数据库密码 |

## 首次上线

```bash
cp docs/deploy.compose.env.example .env && chmod 600 .env   # APP_IMAGE、两个数据库密码（见「数据库角色」）
cp docs/deploy.env.example app.env && chmod 600 app.env     # 应用设置（见下方变量表）
# APP_IMAGE = CI 构建的镜像（.github/workflows/image.yml），按 digest 固定：
#   APP_IMAGE=ghcr.io/<owner>/lushu-app@sha256:<digest>
# 服务器上不构建镜像，也不用 latest。
docker compose -f docker-compose.prod.yml pull app
docker compose -f docker-compose.prod.yml up -d db
docker compose -f docker-compose.prod.yml run --rm migrate   # owner：建表 → 建应用角色并授权 → 空数据回填 → 标记就绪
docker compose -f docker-compose.prod.yml up -d app          # 应用用 APP_DB_USER 连库
curl -fsS http://127.0.0.1:3080/api/ready                     # storage.ready=true 才算好
```

`migrate` 依次执行 `postgres-migrate`、`postgres-app-role`、`postgres-backfill --apply`、`postgres-parity --mark-ready`。全新空库时回填为 0 行，parity 一致后写入就绪标记；不做这一步，`/api/ready` 会一直是 503。升级版本：把 `.env` 里的 `APP_IMAGE` 换成新 digest（旧 digest 记进部署记录，用于回滚）→ `pull app` → **先** `up -d app`（新代码兼容上一版 schema）→ 观察 → `run --rm migrate`（迁移幂等；库已切换就绪时，回填和 parity 会打印 “already cut over; skipping” 并正常退出）。回滚：`APP_IMAGE` 换回旧 digest → `up -d app`。已有 JSONL 数据要迁入时，先把旧数据目录放进 `appdata` 卷，再跑 `migrate`（见 README「存储切换与备份」）。

## 数据库角色（owner 和应用分开）

两条连接，两个角色：

| 角色 | 谁用 | 连接 | 权限 |
| --- | --- | --- | --- |
| owner（`POSTGRES_USER`，postgres:16 镜像里是超级用户） | `db` 初始化、`migrate`、`db-roles` | `MIGRATION_DATABASE_URL` | 拥有所有表，建表、迁移 |
| 应用（`APP_DB_USER`，默认 `lushu_app`） | `app` | `DATABASE_URL` | 只有行级 `select/insert/update/delete`；`admin_audit` 只有 `select/insert`；不拥有任何表，所以不能 `TRUNCATE`、不能 `ALTER TABLE … DISABLE TRIGGER`、不能设 `session_replication_role` |

- **密码在哪生成、存在哪**：都在生产机部署目录里用 `openssl rand -hex 32` 生成，只写进部署目录下的 `.env`（`chmod 600`，属主为部署用户，不进仓库、不进 `app.env`、不贴工单）。`app.env` 里没有任何数据库密码，应用容器只拿到应用角色的连接串。密码另存一份到团队的密钥库（由运维决定用哪个）。
- **角色怎么建**：`scripts/postgres-app-role.mjs`（以 owner 身份连库，读 `APP_DB_USER` / `APP_DB_PASSWORD`）。幂等：角色不存在就建，存在就重设密码和权限。`migrate` 在迁移完成后、回填和校验之前立刻跑；脚本还会设 `ALTER DEFAULT PRIVILEGES`，以后 owner 新建的表和序列创建时就授权给应用角色（`admin_audit` 仍只有 select/insert），没有「新表已建、应用没权限」的窗口；只建角色不迁移用 `run --rm db-roles`。
- **已有库（现在线上：v11/v12，表都归超级用户 owner）第一次切换**：
  1. 生成 `APP_DB_PASSWORD`，写进 `.env`；把旧 `.env` 里的应用设置挪到 `app.env`，从 `app.env` 删掉 `POSTGRES_PASSWORD`。
  2. `docker compose -f docker-compose.prod.yml run --rm db-roles`（用新镜像，以 owner 建 `lushu_app` 并授权；不动表结构）。
  3. `up -d app`：应用改用 `lushu_app` 连库。再按上面「升级版本」的顺序迁移。
- 换应用角色密码：改 `.env` 里的 `APP_DB_PASSWORD` → `run --rm db-roles` → `up -d app`。
- 回归：`ROLE_TEST_OWNER_URL=postgres://owner:…@host:5432/postgres npm run test:postgres-app-role`——在超级用户 owner 建好的**已有 v12 库**上补建应用角色，验证行读写正常、审计表 truncate/update/delete/禁用触发器/replica 都被拒、服务能用应用角色启动。

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

## Caddy 两种部署方式（PROXY_MODE）

应用按「请求的上一跳地址」决定信不信 `X-Forwarded-For`。上一跳是谁取决于 Caddy 跑在哪，所以必须显式选模式。启动检查只能核对**配置之间**是否自洽（模式、`CADDY_IP`、信任列表、子网），**看不到 Caddy 实际跑在哪**：Caddy 在容器里、却没用 override（应用仍是 host 模式）时，应用照常启动，所有用户静默共用一个限流桶。这种情况只能靠下面的「运行时检测」（概览红框 + 告警）和 SRE 核对项第 3 步发现。

| | `PROXY_MODE=host`（默认，仓库推荐） | `PROXY_MODE=container` |
| --- | --- | --- |
| Caddy 在哪 | 宿主机进程，`reverse_proxy 127.0.0.1:3080`（上面的 Caddyfile） | 容器，接入 `lushu_backend`，固定 `ipv4_address`，`reverse_proxy app:3080`（`docs/Caddyfile.container.example`） |
| 启动命令 | `docker compose -f docker-compose.prod.yml …` | `docker compose -f docker-compose.prod.yml -f docker-compose.caddy.yml …` |
| 应用看到的来源 | 网关 `APP_NETWORK_GATEWAY`（docker-proxy 或 iptables MASQUERADE）；Caddy 自己看到真实客户端 | Caddy 容器 IP `CADDY_IP`（默认 `172.31.80.10`，`.env` 里改）；**Caddy 自己看到的来源**见下面「container 模式的前提」 |
| `app.env` 的 `TRUSTED_PROXY_CIDRS` | `172.31.80.1,127.0.0.1,::1` | `172.31.80.10,127.0.0.1,::1` |
| 启动检查 | 必须包含网关；非回环条目都在子网内；设了 `CADDY_IP` 拒绝启动 | `CADDY_IP` 必须是子网内单个地址且不是网关；信任列表必须包含它、只能有它和回环；**不能包含网关**（也就是不能写 `172.31.80.0/24`），否则宿主机上任何能连到 3080 的进程都能伪造 XFF |
| 127.0.0.1:3080 | 发布（Caddy 用） | 不发布（override 用 `ports: !reset []` 去掉，需要 Compose ≥ 2.24） |

- `PROXY_MODE` 不区分大小写（`container` / `CONTAINER` 都行），写成其他值一律拒绝启动（即使 `TRUST_PROXY_HEADERS=false`）。`CADDY_IP` 写 `172.31.80.10` 或 `172.31.80.10/32` 都可以（只接受单个地址）。
- `PROXY_MODE` / `CADDY_IP` 只由 override 文件设给 app；不用 override 时不设，即 host 模式。不要在 `app.env` 里写 `PROXY_MODE=container` 却不用 override（启动检查会因信任列表不匹配而拒绝，但这是配置错误）。
- `CADDY_IP` 必须是子网里没被占用的地址：compose 从 `.2` 起按启动顺序给 db/app 分配地址，所以默认选了 `.10`，别用 `.2`–`.9`。
- 两种模式都要求 Caddy 自己**覆盖**客户端带来的 `X-Forwarded-For`（Caddy 2 默认不信任上游 XFF、只追加真实对端，满足）。

### container 模式的前提（否则 Caddy 自己看到的就是网关）

Caddy 容器只有在**流量经 iptables DNAT 直接进容器**时才看到真实客户端。经 docker-proxy（userland 转发）进来的连接，Caddy 看到的来源是网关 `172.31.80.1`，于是这些用户在 Caddy 的 XFF 里都是同一个地址、共用一个限流桶。复测实测会走 docker-proxy 的有：

- **IPv6 客户端**：Docker 没开 IPv6 时，`:::80/:::443` 由 docker-proxy 用 IPv4 转给 Caddy。生产域名有 AAAA 记录 → 所有 IPv6 用户算成一个人。
- 宿主机回环（`127.0.0.1:80`、`[::1]:80`）和其他容器访问发布端口。
- dockerd `"iptables": false` 时：**全部**流量。

所以 container 模式必须满足：

1. `/etc/docker/daemon.json` **绝不设** `"iptables": false`（默认 true）。
2. IPv6 二选一：给 Docker 开 IPv6（`"ipv6": true`、`"ip6tables": true`，并给 `lushu_backend` 配 IPv6 子网，让 IPv6 也走 DNAT），**或者**删掉域名的 AAAA 记录（只对外提供 IPv4）。都做不到就用 host 模式（宿主机 Caddy 不受影响）。
3. 在 Caddy 访问日志里确认 `remote_ip` 是真实客户端地址，不是网关（示例 `docs/Caddyfile.container.example` 已开 `log`；`docker logs lushu-caddy-1 | grep -o '"remote_ip":"[^"]*"' | sort | uniq -c`）。

运行时检测的第二个信号（「疑似所有用户被识别成同一个地址」）就是为这种情况准备的。

### 第一次切换前 SRE 必须确认（两种模式都要做）

1. **Caddy 是不是容器**：`systemctl status caddy`、`pgrep -a caddy`、`docker ps --format '{{.Names}} {{.Image}}' | grep -i caddy`。宿主机进程 → host；容器 → container（并且要把它接入 `lushu_backend` 且固定 IP，现有 Caddy 容器如果在别的网络上，经宿主机端口转发进来时来源又会变成网关或别的地址，必须实测）。
2. **dockerd 配置**：`cat /etc/docker/daemon.json`（没有这个文件 = 默认）。看 `userland-proxy`（默认 true；复测里 true/false 两种情况来源都是网关）和 `iptables`（默认 true；**设成 false 的情况没测过**，来源可能不同，必须实测）、`ipv6`。
3. **（container 模式）Caddy 看到的来源**：见上面「container 模式的前提」第 3 条。
4. **应用实际看到的来源地址**（以这个为准，不要只看配置推断）：切流量后发几个请求，然后
   ```bash
   nsenter -t "$(docker inspect -f '{{.State.Pid}}' lushu-app-1)" -n ss -tn state established '( sport = :3080 )'
   ```
   `Peer Address` 一列应该是：host 模式 = `APP_NETWORK_GATEWAY`，container 模式 = `CADDY_IP`。不一致就**回滚**并改配置，不要上线：否则按 IP 的限流会把所有用户算成一个人（或者信任了不该信的地址）。也可以用两台不同出口的客户端各打一次公开接口超过限流，确认互不影响。

### 运行时检测（启动检查发现不了的情况）

启动检查只能对照配置；「Caddy 其实在容器里、却按 host 模式部署（没用 override）」这种情况配置本身是自洽的，只有看真实请求才知道。所以应用在运行时还会数：**带 `X-Forwarded-For` 或 `X-Forwarded-Proto`、但 TCP 对端不在 `TRUSTED_PROXY_CIDRS` 里**的请求（只在 `TRUST_PROXY_HEADERS=true` 时数）。

- 正确配置下这个数恒为 0：Caddy 的地址是受信任的，客户端也碰不到应用端口。
- 第一次出现时打一条日志 `[proxy] WARNING: request with forwarded headers from untrusted peer <对端地址> …`（只有对端地址，不记客户端 IP 和其他信息），之后每 10 分钟最多一条。
- 滚动 10 分钟内达到 `PROXY_MISCONFIG_THRESHOLD`（默认 `20`）：后台「概览」顶部出现红框「代理配置疑似有误，所有用户可能共用限流额度，请联系 SRE」（小字写对端地址和次数），`/api/admin/dashboard` 的 `proxyMisconfig.tripped=true`；配置了 `ALERT_WEBHOOK_URL` 时发告警 `proxy-misconfig`，情况持续时**每小时最多一次**。
- **第二个信号：大家被识别成同一个地址。** 来自受信任代理、带 `X-Forwarded-For` 的请求里，解析出的客户端地址如果 **≥90% 都是 `APP_NETWORK_GATEWAY`**，且窗口内样本 **≥`PROXY_SHARED_MIN_SAMPLE`（默认 20）**，概览显示「疑似所有用户被识别成同一个地址，可能共用限流额度，请联系 SRE」，并发告警 `proxy-shared-address`（和第一个信号的 `proxy-misconfig` 分开去重，各自每小时最多一次，互不压制）。只有客户端地址等于网关才算，所以流量小或真实用户多时不会误报；不带 XFF 的请求（如在宿主机上直接 curl）不计入样本；转发链里全是受信任地址的请求（如宿主机 Caddy 对本机回环请求带的 `X-Forwarded-For: 127.0.0.1`，解析会回退到对端也就是网关）也不计入，避免 host 模式误报。这条排除在 container 模式下同样生效：Caddy 对回环/内部客户端带的受信任 XFF 不计入样本，样本里只剩「有真实客户端地址」的请求，所以经 docker-proxy 变成网关的那部分占比会更高、信号 2 在 container 模式下更敏感。这是有意的（container 模式正是这个信号要防的场景）。
- **信号 2 的盲区**：阈值是 90%，只能发现「几乎所有人」共用一个地址。**部分共用**发现不了，例如有 AAAA 记录、只有 30% 用户走 IPv6（经 docker-proxy 变成网关）：这 30% 共用一个桶，ratio 只有 0.3，不会告警。所以 container 模式上线前，SRE 必须在预发环境确认 AAAA 记录的处理（开 Docker IPv6 + ip6tables，或去掉 AAAA），并用一个 IPv6 客户端实测 Caddy 日志里的 `remote_ip`，不能指望这个检测兜底。典型原因见「container 模式的前提」。
- 窗口长度 `PROXY_MISCONFIG_WINDOW_MS`（默认 `600000`，最小 1 分钟）。
- **只按进程计数，不跨进程汇总**：生产每个部署只跑一个 app 容器（一个 Node 进程），所以等于全站数。重启后清零；如果以后跑多个实例，每个实例各自判断（任何一个超阈值就会告警），概览只显示处理这次请求的那个实例的数字。
- 看到这个提示：按上面「第一次切换前 SRE 必须确认」第 3 步查对端地址，把 Caddy 的真实地址配进去（容器 Caddy 用 `docker-compose.caddy.yml` + `PROXY_MODE=container`）。注意能直连应用端口、自己带 `X-Forwarded-For` 的进程也会触发它；正常部署里应用端口只对 Caddy 开放，所以这本身也说明端口暴露有问题。

### 扩容到多个 app 实例之前（检查清单）

现在生产只跑一个 app 容器。改成多个实例（`--scale app=N`、多台机器）**之前**必须先处理：

- [ ] **运行时代理检测的计数只按进程**：每个实例各自计数，概览只显示接到这次请求的那个实例的数，流量被分摊后可能谁都到不了阈值（复测 `--scale app=2` 实测 15 + 15，两边都没到 20）。扩容前要先做跨进程汇总：计划用新迁移 `0013`（PG 里按分钟桶存计数，各实例累加、概览读汇总），**这个迁移还没写**。
- [ ] 按 IP 的限流桶同样是进程内的（`server/http/rate-limit.mjs`），多实例时每个实例各算一份，实际额度会变成 N 倍。
- [ ] **生成任务只在内存里**（`server/ai/generationJobs.mjs` 的 `jobs` / `keyIndex` 两个 `Map`，约 45–47 行）：任务在哪个实例创建，长轮询就必须打到同一个实例，否则查不到任务（404）、去重也失效。扩容前要么在 Caddy 上做会话粘滞（按 profile / cookie 固定实例），要么把任务状态挪到共享存储（PG）。
- [ ] **告警去重只按进程**（`server/ops/alerts.mjs` 第 3 行 `lastSent` 是进程内 `Map`）：N 个实例同时满足条件会各发一次，即每小时最多 N 条同类 webhook。
- [ ] **身份断言防重放（nonce）跨实例是成立的，前提是 `STORAGE_BACKEND=postgres`**（读代码的结论，没做多实例实测）：`server/auth/profiles.mjs` 的 `consumeIdentityAssertion` 先拿 PG advisory lock（`withStorageEntityLock` → `pg_advisory_lock`，跨进程），在锁里用 `findLatestByEntityKey` 查 PG 里是否已记录这个 nonce，没有才记录。`server/auth/nonce-store.mjs` 自己的内存 `Map` 只在启动时加载一次、之后不再刷新，**单靠它不跨实例**；起作用的是锁里的 PG 查询。JSONL 后端下锁和索引都是进程内的，多实例不安全（JSONL 本来也只支持单实例）。
- [ ] 重新确认 Caddy 的上游和信任列表（多个 app 地址，`TRUSTED_PROXY_CIDRS` 不变，仍然只信 Caddy 那一跳）。

## 反代与 TRUST_PROXY

**需要。** 不开时，所有请求的来源都是反代那一跳，按 IP 的限流会把全体用户算成同一个人。

- compose 部署：compose 文件已设置 `TRUST_PROXY_HEADERS=true`。请求经 docker-proxy 进容器，来源是网桥网关 `172.31.80.1`（compose 里把子网固定为 `172.31.80.0/24`），所以 `app.env` 里要有 `TRUSTED_PROXY_CIDRS=172.31.80.1,127.0.0.1,::1`（模板 `docs/deploy.env.example` 已写好）。compose 不再设置这个变量，只认 `app.env`；**旧部署切到新 compose 时务必把这一行加进 `app.env`**，否则应用只信任 `127.0.0.1,::1`，按 IP 限流会把所有人算成网关一个人。如果子网和宿主机已有网络冲突，见下面「网络（固定子网）」。
- **网络（固定子网）**：compose 把应用网络固定为 `lushu_backend`，子网 `${APP_NETWORK_SUBNET:-172.31.80.0/24}`、网关 `${APP_NETWORK_GATEWAY:-172.31.80.1}`，同样的值传给应用。Caddy 在宿主机上访问 `127.0.0.1:3080`，经 docker-proxy 进容器，应用看到的来源就是这个网关。启动时检查：生产且 `TRUST_PROXY_HEADERS=true` 时，`TRUSTED_PROXY_CIDRS` 为空、有无效条目、含 `0.0.0.0/0`、有落在固定子网之外的非回环条目、或没包含网关，**都拒绝启动**。
  - **172.31.80.1 的来历**：仓库里只有 2026-10-09 的提交 `3b3d974`（说明写「to match production」）和本文档的描述，**没有在生产机上实测记录**（`docker network inspect` 的输出、或应用日志里看到的来源地址）。所以这个值是否和现网一致**未确认**。
  - **第一次切换前 SRE 必须确认**：在生产机上执行 `docker network inspect lushu_backend --format '{{json .IPAM.Config}}'`（老网络名可能不同，用 `docker network ls` 找 compose 项目 `lushu` 的网络），确认子网/网关；再看应用日志或 `docker compose exec app node -e "…"` 确认请求来源确实是网关。和 `172.31.80.0/24` / `172.31.80.1` 不一致时，二选一：在 `.env` 里设 `APP_NETWORK_SUBNET` / `APP_NETWORK_GATEWAY` 为现网值并同步 `app.env` 的 `TRUSTED_PROXY_CIDRS`；或按下面重建网络。
  - **重建网络是必需的**：Docker 不会修改已存在网络的子网。现网如果不是固定子网（或名字不同），必须在维护窗口里 `docker compose -f docker-compose.prod.yml down`（不要加 `-v`，数据卷保留）→ 确认 `docker network rm lushu_backend` 已删除旧网络 → `up -d db` → `up -d app`，再用 `docker network inspect lushu_backend` 核对。重建期间站点不可用（约 1 分钟）。
  - 改子网时：只改 `.env` 里的 `APP_NETWORK_SUBNET` / `APP_NETWORK_GATEWAY` 和 `app.env` 里的 `TRUSTED_PROXY_CIDRS`，然后按上面重建网络；三者不一致应用会拒绝启动。
  - 同一个网关也是 `docs/login-rollout.md` 里 `MAIL_SMTP_HOST=172.31.80.1` 的前提，改子网要一起改。
- 不用 Docker、直接 `npm start`：设 `HOST=127.0.0.1 PORT=3080 TRUST_PROXY_HEADERS=true`；`TRUSTED_PROXY_CIDRS` 的默认值 `127.0.0.1,::1` 正好是 Caddy。
- 服务从右往左读 `X-Forwarded-For`，跳过可信代理，所以客户端自己伪造的最左项不会生效。带转发链的请求一律不算“本机”，生产环境也默认关闭本机免鉴权。

## 镜像 digest 检查（定位与限制）

- app 容器（`REQUIRE_PINNED_IMAGE=true`）和 `migrate` / `db-roles` 用同一条规则：`APP_IMAGE` 必须以 `@sha256:<64 位小写 hex>` 结尾。
- **它只检查配置的字符串**（compose 把 `APP_IMAGE` 原样传成 `APP_IMAGE_DIGEST`），**不检查容器实际运行的镜像**。compose 里 `image:` 和 `APP_IMAGE_DIGEST` 来自同一个变量，所以正常流程下两者一致；它防的是「误用 tag / latest 部署」，不防有人手动 `docker run -e APP_IMAGE_DIGEST=…假 digest…`，也不做签名校验。不走 compose 又不设 `REQUIRE_PINNED_IMAGE` 时完全不检查。
- **用 tag 部署时 app 会一直重启，这是设计如此（拒绝启动），不是崩溃**：`restart: unless-stopped` 下几秒内 RestartCount 就会涨到 5–6，日志是 `REQUIRE_PINNED_IMAGE=true but APP_IMAGE_DIGEST=… is not pinned by digest`。发布前先 `docker compose -f docker-compose.prod.yml config | grep image:` 核对，或先跑一次 `run --rm db-roles`（同样的检查，不通过立即退出）。

## TRUSTED_PROXY_CIDRS 的已知限制

- 只支持 IPv4 地址、IPv4 CIDR 和 `::1`；**IPv6 网段（如 `fd00::/8`）暂不支持**，写了会拒绝启动。现在的部署不需要 IPv6；以后给 `lushu_backend` 开 IPv6 时要先补这部分。

## 内存（1.4 GB 可用）

| 进程 | 限制 | 实测 |
| --- | --- | --- |
| app（Node） | `NODE_OPTIONS=--max-old-space-size=384`，容器 `mem_limit: 640m` | 空载 RSS 约 80 MB（2026-10-09 预演） |
| db（PG 16） | `shared_buffers=96MB`、`max_connections=30`，`mem_limit: 384m` | — |
| 镜像构建（`vite build`） | 构建阶段 `--max-old-space-size=1024` | 构建进程树峰值约 570 MB |

两者合计上限约 1 GB，给宿主机和 Caddy 留了余量。构建时最好先停 app，或者在别的机器上构建好镜像再推过来。应用连接池默认 10（`POSTGRES_POOL_MAX`），单实例足够。

## 环境变量

“必填”指按本次上线决策必须设置；其余有安全默认值。应用密钥只放 `app.env`，数据库密码和 `APP_IMAGE` 只放 `.env`（都不进仓库，chmod 600），也不要贴进工单或日志。

### 必填

| 变量 | 本次取值 | 作用 |
| --- | --- | --- |
| `REGISTRATION_MODE` | `open` | **生产显式写进 `app.env`**，不依赖代码默认值（模板已写）。本次内测决定开放注册；改 `invite` 前先建好邀请码，否则启动会打 WARNING |
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

compose 已在文件里固定：`NODE_ENV=production`、`HOST=0.0.0.0`（容器内）、`PORT=3080`、`ROUTEBOOK_DATA_DIR=/data`、`STORAGE_BACKEND=postgres`、`DATABASE_URL`、`TRUST_PROXY_HEADERS=true`（`TRUSTED_PROXY_CIDRS` 在 `app.env`）。不用 compose 时，这些要自己设置，其中 `HOST=127.0.0.1`。

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
| `REGISTRATION_INVITE_CODE` | 留空 | 邀请码；不设时只认后台创建的邀请码。**不再**沿用 `ROUTEBOOK_API_TOKEN`（访问码传得太广，不能兼当邀请码） |
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
| `ALERT_WEBHOOK_URL` | 空 | 配了就在全站日生成上限触发、联网补全日预算用完、前端错误激增、代理配置疑似有误（`proxy-misconfig` / `proxy-shared-address`，见「运行时检测」）时 POST 一条 JSON（`{type,message,at,service}`），同类每小时最多一次；没配只写日志 |
| `ENRICH_BUDGET_ALERT_RATIO` | `0.8` | 联网补全当日花费到预算的这个比例时告警一次（每份路书实测约 $0.5） |
| `ALERT_CLIENT_ERRORS_PER_HOUR` | `30` | 前端错误激增的阈值（每进程近 1 小时条数） |
| `PROXY_MISCONFIG_THRESHOLD` / `PROXY_MISCONFIG_WINDOW_MS` | `20` / `600000` | 带转发头但对端不受信任的请求，滚动窗口内达到这个数就在概览标红并告警（每进程计数） |
| `PROXY_SHARED_MIN_SAMPLE` | `20` | 第二个信号的最小样本：窗口内至少这么多经代理的请求，且 ≥90% 解析为网关才标红 |

# 账号登录上线手册（SRE）：邮箱 + 手机号

目标：从「访问码 + 设备档案」平稳切到「邮箱 / 手机号 + 密码登录」。注册要邮箱验证码，忘了密码用邮箱验证码重设（恢复码仍可用）。每一步都能用改一个环境变量回退。

## 0. 准备（一次性）

1. 生成并**离线备份** `AUTH_PHONE_HASH_SECRET`（≥32 位随机串，例如 `openssl rand -base64 48 | tr -d '/+=' | cut -c1-48`）。和 `PROFILE_ID_SECRET` 一样：上线后不能换；丢了所有账号都按手机号找不到。
2. 同样生成并离线备份 `AUTH_EMAIL_HASH_SECRET` 和 `AUTH_EMAIL_ENC_KEY`（各一个独立随机串，命令同上）。上线后都不能换。
3. 发信：优先用日本那台 AWS 机器上已有的邮件服务器（`MAIL_TRANSPORT=smtp`，见 2b），也可以用 Resend。不管哪种，都要给发件域名配 SPF、DKIM、DMARC；自己的服务器还要确认 AWS 已解除 25 端口出站限制、有反向解析（PTR），否则大概率进垃圾箱或被拒。没准备好也能先上线：`MAIL_TRANSPORT=disabled` + `EMAIL_VERIFICATION_REQUIRED=false`，注册时邮箱标「未验证」，之后用户在「我的 → 账号」补验证。
4. 决定邀请码：不设 `REGISTRATION_INVITE_CODE` 时沿用现在的访问码 `ROUTEBOOK_API_TOKEN`。
5. 备份：`pg_dump`（或 `npm run backup:data`）+ `appdata` 卷。

## 1. 发布新版本（行为不变）

`.env` 先加上（`AUTH_MODE` 保持默认）：

```
AUTH_MODE=access-code
REGISTRATION_MODE=invite
AUTH_PHONE_HASH_SECRET=<上一步生成的>
AUTH_EMAIL_HASH_SECRET=<上一步生成的>
AUTH_EMAIL_ENC_KEY=<上一步生成的>
MAIL_TRANSPORT=disabled
EMAIL_VERIFICATION_REQUIRED=false
```

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm migrate   # 应用 0008_accounts + 0009_account_email（只新增表和可空列，schema_version 7→9）
docker compose -f docker-compose.prod.yml up -d app
curl -fsS http://127.0.0.1:3080/api/ready
curl -fsS https://lushu.aiwuq.cn/api/auth/me      # {"mode":"access-code","account":null}
```

注意：新镜像要求 schema_version=9，**先跑 migrate 再起 app**，否则 app 会拒绝启动。

## 2. P1a：`AUTH_MODE=both`（登录和访问码并存）

```bash
sed -i 's/^AUTH_MODE=.*/AUTH_MODE=both/' .env && docker compose -f docker-compose.prod.yml up -d app
```

检查：
- 页头出现「登录」，注册需要邀请码；`/api/auth/config` 返回 `{"mode":"both","registration":"invite"}`。
- 用测试邮箱（可加手机号）注册 → 看到 6 个恢复码 → 「我的 → 账号」显示打码邮箱、「邮箱未验证」（发信打开前）。
- 老的纯手机号账号能照常用手机号登录，登录后提示「加个邮箱」，不会被锁。
- 老用户填访问码仍能生成。
- 运营后台「账号」页能搜到测试号（后 4 位）。
- 日志里搜不到测试手机号：`docker compose logs app | grep -c 1380000` 应为 0。

观察 3–7 天：注册数、`AUTH_LOCKED` 次数、登录失败率、内存（scrypt 并发 2，每个约 32 MB）。

## 2b. 打开邮件发信

### 生产现状：宿主机 Postfix 中继（推荐先用这个）

宿主机上的 Postfix 只对 Docker 网桥开放 25 端口，不加密、不认证，再用 `drumyinyue@gmail.com` 经 `smtp.gmail.com:587` 发出去。

```bash
# .env
MAIL_TRANSPORT=smtp
MAIL_SMTP_HOST=172.31.80.1           # Docker 网桥网关，必须写 IP（主机名不放行）
MAIL_SMTP_PORT=25
MAIL_SMTP_SECURE=none
MAIL_SMTP_ALLOW_PLAINTEXT_PRIVATE=true
# 不填 MAIL_SMTP_USER / MAIL_SMTP_PASS
MAIL_FROM=路书 <drumyinyue@gmail.com>
EMAIL_VERIFICATION_REQUIRED=true
docker compose -f docker-compose.prod.yml up -d app
```

注意：
- Gmail 会把发件人改写成登录的账号 `drumyinyue@gmail.com`，所以 `MAIL_FROM` 就填它；填别的地址也会被改掉，还可能被判成伪造。
- Gmail 有每日发信上限（普通账号约 500 封/天，Workspace 约 2000 封/天，超了要等 24 小时），超限后验证码发不出去，用户看到「邮件没发出去，稍后再试」。用户多了要换成自有域名 + 正规服务商（Resend 或自建带 DKIM 的服务器）。
- 先确认 Postfix 只监听网桥地址、只允许 Docker 网段中继，不能成为开放中继。
- 检查：`docker compose exec app node -e "require('net').connect(25,'172.31.80.1').on('connect',()=>{console.log('ok');process.exit()})"`，然后按下面清单收一封验证码；宿主机 `journalctl -u postfix` 能看到 `relay=smtp.gmail.com ... status=sent`。

### 用自己的邮件服务器（SMTP）

需要 SRE 提供：邮件服务器主机名、端口和加密方式（587 + STARTTLS 或 465 + TLS）、一个专用发信账号和密码、发件地址，以及证书是公共 CA 签的还是自签的（自签要给 CA 的 PEM）。

```bash
# .env
MAIL_TRANSPORT=smtp
MAIL_FROM=路书 <no-reply@mail.example.com>
MAIL_SMTP_HOST=mail.example.com      # 证书上的名字；同机部署也别填 localhost（那是容器自己）
MAIL_SMTP_SECURE=starttls            # 或 tls（465）
MAIL_SMTP_PORT=587
MAIL_SMTP_USER=lushu-noreply
MAIL_SMTP_PASS=<专用账号密码>
# MAIL_SMTP_CA_FILE=/run/secrets/mail-ca.pem   # 仅自签证书时，并在 compose 里挂载
EMAIL_VERIFICATION_REQUIRED=true
docker compose -f docker-compose.prod.yml up -d app
```

如果邮件服务器只监听宿主机本地端口，要么让它也监听 docker 网桥地址并在 compose 里加 `extra_hosts: ["host.docker.internal:host-gateway"]`，要么开放 587 给容器网段；不要为此关掉证书校验（生产会拒绝启动）。连不上时用户看到「邮件没发出去，稍后再试」，日志里是 `[mail] … failed via smtp: <错误类型>`，不含收件人原文和密码。

### 用 Resend

服务商准备好后：

```bash
# .env
MAIL_TRANSPORT=resend
MAIL_FROM=路书 <no-reply@mail.example.com>
MAIL_API_KEY=<服务商给的>
EMAIL_VERIFICATION_REQUIRED=true
docker compose -f docker-compose.prod.yml up -d app
```

检查：
- `/api/auth/config` 返回 `"emailVerificationRequired":true,"emailDelivery":true`。
- 用测试邮箱（QQ、163、Gmail 各一个）注册：1 分钟内收到验证码，不进垃圾箱；填码后注册成功。
- 「忘了密码 → 用邮箱验证码」能重设，旧设备被退出，邮箱收到「密码已重设」通知。
- 「我的 → 账号 → 换邮箱」：新邮箱收码，旧邮箱收到通知。
- 日志里搜不到测试邮箱原文和验证码：`docker compose logs app | grep -c '@qq.com'` 应为 0（`MAIL_TRANSPORT=log` 时只有打码地址）。
- 服务商后台看退信率、投诉率。

回退：`EMAIL_VERIFICATION_REQUIRED=false`（注册不再要码），或 `MAIL_TRANSPORT=disabled`（同时必须把前者设 false，否则拒绝启动）。

## 3. P1c：`AUTH_MODE=login`（只认登录）

提前在站内告知内测用户：访问码改作注册邀请码。

```bash
sed -i 's/^AUTH_MODE=.*/AUTH_MODE=login/' .env && docker compose -f docker-compose.prod.yml up -d app
```

检查：
- 未登录：能看首页、目的地、分享页、隐私说明；点「导入攻略」能填写，点「下一步」弹出登录。
- `/api/health` 未登录返回 `access: "needs-login"`；带访问码调用 `/api/generation-jobs` 返回 401 `LOGIN_REQUIRED`。
- 登录后生成正常；之前在本机做的草稿登录后自动归入账号，行中同步不再 403。

## 回滚

- 任何阶段：`AUTH_MODE=access-code` + `up -d app`。账号表保留不动，账号接口回到 404，访问码恢复原样；已登录用户的 Cookie 会被忽略。
- 回滚到旧镜像（1b2b450 等，只认 schema_version=7）：先停 app，再执行
  `docker compose -f docker-compose.prod.yml exec db psql -U lushu -d lushu -c "update trusted_routebook.storage_state set schema_version = 7 where singleton_id = 1;"`
  然后起旧镜像。0008/0009 的新表和新列对旧版无影响；以后再升级时重跑 migrate 即可（迁移幂等，会把版本改回 9）。
- 只回到「手机号版」（schema 8 的镜像）：同上把 schema_version 改成 8。注意：0009 放开了 `phone_hash` 非空约束，期间注册的「只有邮箱」账号在旧版里没法登录，回滚前先确认有没有这类账号：`select count(*) from trusted_routebook.auth_users where phone_hash is null and status <> 'deleted';`

## 常见运维操作

- 用户忘了密码：先让他用「忘了密码 → 用邮箱验证码」。没绑邮箱、恢复码也没了：核实本人后，在「账号」页点「补发恢复码」，写明核实方式。恢复码只显示一次，交给本人。
- 账号被盗：「停用」（立即退出所有设备）→ 核实后「补发恢复码」→「恢复」。
- 给内测用户加额度：「设生成额度」。
- 收不到验证码：先让用户看垃圾箱；同一邮箱每 60 秒最多一封、每小时最多 5 封，输错 10 次锁 30 分钟；去服务商后台查投递记录。
- 被锁：同一邮箱或手机号 5 次输错密码锁 15 分钟（之后翻倍，最长 24 小时）；可以等，或用恢复码重设（重设走独立计数）。

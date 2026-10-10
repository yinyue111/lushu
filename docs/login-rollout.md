# 账号登录上线手册（SRE）：邮箱 + 手机号

目标：从「访问码 + 设备档案」平稳切到「邮箱 / 手机号 + 密码登录」。注册要邮箱验证码，忘了密码用邮箱验证码重设（恢复码仍可用）。每一步都能用改一个环境变量回退。

## 0. 准备（一次性）

1. 生成并**离线备份** `AUTH_PHONE_HASH_SECRET`（≥32 位随机串，例如 `openssl rand -base64 48 | tr -d '/+=' | cut -c1-48`）。和 `PROFILE_ID_SECRET` 一样：上线后不能换；丢了所有账号都按手机号找不到。
2. 同样生成并离线备份 `AUTH_EMAIL_HASH_SECRET` 和 `AUTH_EMAIL_ENC_KEY`（各一个独立随机串，命令同上）。上线后都不能换。
3. 发信（需要产品负责人拍板服务商和发件域名）：开通服务商账号，给发件域名（如 `mail.<主域名>`）配 SPF、DKIM、DMARC，拿到 API key。没准备好也能先上线：`MAIL_TRANSPORT=disabled` + `EMAIL_VERIFICATION_REQUIRED=false`，注册时邮箱标「未验证」，之后用户在「我的 → 账号」补验证。
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

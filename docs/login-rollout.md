# 手机号登录上线手册（SRE）

目标：从「访问码 + 设备档案」平稳切到「手机号 + 密码登录」。每一步都能用改一个环境变量回退。

## 0. 准备（一次性）

1. 生成并**离线备份** `AUTH_PHONE_HASH_SECRET`（≥32 位随机串，例如 `openssl rand -base64 48 | tr -d '/+=' | cut -c1-48`）。和 `PROFILE_ID_SECRET` 一样：上线后不能换；丢了所有账号都按手机号找不到。
2. 决定邀请码：不设 `REGISTRATION_INVITE_CODE` 时沿用现在的访问码 `ROUTEBOOK_API_TOKEN`。
3. 备份：`pg_dump`（或 `npm run backup:data`）+ `appdata` 卷。

## 1. 发布新版本（行为不变）

`.env` 先加上（`AUTH_MODE` 保持默认）：

```
AUTH_MODE=access-code
REGISTRATION_MODE=invite
AUTH_PHONE_HASH_SECRET=<上一步生成的>
```

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm migrate   # 应用 0008_accounts（只新增 4 张表，schema_version 7→8）
docker compose -f docker-compose.prod.yml up -d app
curl -fsS http://127.0.0.1:3080/api/ready
curl -fsS https://lushu.aiwuq.cn/api/auth/me      # {"mode":"access-code","account":null}
```

注意：新镜像要求 schema_version=8，**先跑 migrate 再起 app**，否则 app 会拒绝启动。

## 2. P1a：`AUTH_MODE=both`（登录和访问码并存）

```bash
sed -i 's/^AUTH_MODE=.*/AUTH_MODE=both/' .env && docker compose -f docker-compose.prod.yml up -d app
```

检查：
- 页头出现「登录」，注册需要邀请码；`/api/auth/config` 返回 `{"mode":"both","registration":"invite"}`。
- 用测试手机号注册 → 看到 6 个恢复码 → 「我的 → 账号」显示打码手机号。
- 老用户填访问码仍能生成。
- 运营后台「账号」页能搜到测试号（后 4 位）。
- 日志里搜不到测试手机号：`docker compose logs app | grep -c 1380000` 应为 0。

观察 3–7 天：注册数、`AUTH_LOCKED` 次数、登录失败率、内存（scrypt 并发 2，每个约 32 MB）。

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
  然后起旧镜像。0008 的新表对旧版无影响；以后再升级时重跑 migrate 即可（迁移幂等，会把版本改回 8）。

## 常见运维操作

- 用户忘了密码、恢复码也没了：核实本人后，在「账号」页点「补发恢复码」，写明核实方式。恢复码只显示一次，交给本人。
- 账号被盗：「停用」（立即退出所有设备）→ 核实后「补发恢复码」→「恢复」。
- 给内测用户加额度：「设生成额度」。
- 被锁：手机号 5 次输错锁 15 分钟（之后翻倍，最长 24 小时）；可以等，或用恢复码重设（重设走独立计数）。

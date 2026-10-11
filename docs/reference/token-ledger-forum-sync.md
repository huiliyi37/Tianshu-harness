---
title: Token 消耗台账 · 论坛同步接口与接入交接
type: reference
status: active
date: 2026-10-11
tags: [token-ledger, forum, sync, api, integration]
---

# Token 消耗台账 · 论坛同步接口与接入交接

> 三段式架构的完整交接：**客户端（CLI/桌面端）→ 天枢 token-server → 论坛**。
> 客户端实现：`src/token-ledger/` + `src/server/token-ledger-routes.ts`；
> 中间层：`token-server/`（Cloudflare Worker + D1，附属服务，不进开源仓——其 API 契约见本文与 `token-server/README.md`）。

## 1. 架构与数据流

```
客户端 cache-log.jsonl（计费行，唯一事实源）
   │  字节游标增量折叠
   ▼
本地台账 ~/.rivet/token-ledger.json（day×model 累计）
   │  digest 判重，有变更才推
   ▼
POST {token-server}/v1/token-usage ── Bearer 用户同步密钥（论坛签发）
   │  D1 覆盖式 upsert（累计语义，重推/乱序/丢包不重复计数）
   ▼
论坛后端：签发/吊销密钥（admin API）· 拉取个人聚合与榜单 → 渲染展示
```

两条关键性质：

- **累计语义**：每次推送都是"截至目前全量"，论坛/token-server 只做 upsert，不需要去重表。
- **本地是权威**：推送失败不影响本地台账增长；端点恢复后下一趟自动补齐全部历史。

## 2. 用户侧配置（如何开启同步）

CLI 使用 `/usage` 查看全设备本地累计，`/usage connect` 在原生终端的遮蔽输入框配置论坛个人同步密钥；`/usage sync` 立即同步，`/usage auto on` 明确开启每 30 分钟上传，`/usage auto off` 关闭自动上传，`/usage disconnect` 清除密钥。远控兼容终端提供查询和同步命令，密钥需通过原生终端或 VS Code 的安全入口配置，不要粘贴到普通命令行。

VS Code 在设置抽屉的「Token 账本」中查看累计、设置个人同步密钥、开关自动同步及立即同步。密码输入在 VS Code 宿主中完成，网页界面只接收「已配置」状态。默认只记录本地数据；配置密钥不会自动开启上传。上传端点、密钥与自动上传开关只接受用户配置，仓库项目配置不能自行启用或改变上传目标。

正式服务探活地址为 `https://tianshuharness.com/token/health`。总 Token = 输入 + 输出；缓存读取已包含在输入中，不再重复相加。计价值按模型原始定价单位估算，可能混合币种，不是统一费用或账单。

用户在论坛个人页生成同步密钥（论坛后端调 token-server 签发），填入 `~/.rivet/config.json`：

```json
{
  "tokenLedger": {
    "deviceName": "小明的 MacBook",
    "forum": {
      "endpoint": "https://tianshuharness.com/token/v1/token-usage",
      "apiKey": "tsu_论坛签发的密钥",
      "autoSync": true,
      "intervalMinutes": 30
    }
  }
}
```

| 字段 | 缺省行为 |
|------|---------|
| `enabled` | 默认 `true`（本地台账始终累计；只是本地记录，不上传） |
| `deviceName` | 缺省 `os.hostname()`；展示用 |
| `forum.endpoint` | **缺省 = 不上传**。完整 POST URL，客户端不拼路径 |
| `forum.apiKey` | 配置了才带 `Authorization: Bearer` 头 |
| `forum.autoSync` | 默认 `false`；`true` 且 endpoint 已配时，会话内每 `intervalMinutes`（默认 30）推一趟，退出时冲刷最后一趟（3s 有界）。桌面端由 sidecar 进程承担间隔推送 |

环境变量覆盖（联调/多环境）：`RIVET_FORUM_API` 覆盖 endpoint，`RIVET_FORUM_TOKEN` 覆盖 apiKey。

## 3. 客户端 → token-server 契约

```
POST /v1/token-usage
Content-Type: application/json
Authorization: Bearer tsu_<用户同步密钥>
```

### 3.1 请求体 `TokenUsageSnapshot`

```json
{
  "version": 1,
  "deviceId": "3f6b2a1c-9e2d-4f7b-b8a1-0c5d6e7f8a9b",
  "deviceName": "小明的 MacBook",
  "sentAt": "2026-10-11T08:30:00.000Z",
  "totals": { "requests": 128, "input": 3456789, "output": 234567, "cacheRead": 2900000, "cacheCreate": 300000, "cost": 5.1234 },
  "days": [
    { "date": "2026-10-10", "model": "deepseek-flash", "provider": "deepseek",
      "requests": 100, "input": 3000000, "output": 200000, "cacheRead": 2500000, "cacheCreate": 300000, "cost": 4.5 }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `1` | 载荷版本；破坏性变更会递增 |
| `deviceId` | uuid | 安装级匿名 id（客户端持久化）。**upsert 主键**，不含用户身份 |
| `deviceName` | string | 展示名，用户可改 |
| `sentAt` | ISO 8601 | 客户端推送时间；token-server 用它做 stale 守卫（不前进的整包丢弃） |
| `totals` | object | 全量累计 = `days` 求和（客户端保证一致） |
| `days[]` | array | 逐日 × 模型明细，`date` 升序；同 (date, model, provider) 只出现一次 |
| `requests` | int | 计费请求数（主请求 + side_path + 中断重试行） |
| `input` | int | cache-**inclusive** 输入 tokens |
| `output` / `cacheRead` / `cacheCreate` | int | 输出 / 缓存命中 / 缓存创建 tokens |
| `cost` | number | 客户端按本地定价估算（DeepSeek 官方含峰谷）；**未定价模型计 0**。可能混合币种，不应直接显示单一货币符号，也不是账单 |
| `provider` | string? | 老数据行可能缺省 |

### 3.2 响应与客户端行为

| token-server 响应 | 客户端行为 |
|---------|-----------|
| 2xx `{ ok, stale, receivedAt }` | 确认；`stale:true` = 旧包被丢弃（仍算成功）。台账无新变化时客户端不再推 |
| 401 | 密钥无效/已吊销，不重试，回执记 `http_4xx`（用户需回论坛重新签发） |
| 其他 4xx | 载荷问题，不重试 |
| 429 / 5xx / 网络 / 超时(10s) | 瞬态：当场重试一次（1s 退避），失败等下趟定时推送 |

## 4. token-server → 论坛契约

论坛后端持有 `ADMIN_TOKEN`（wrangler secret），服务端对服务端调用：

| 路由 | 说明 |
|------|------|
| `POST /v1/admin/keys` | 签发密钥 `{ forumUserId, label? }` → 201 `{ keyId, key, prefix }`。**明文只返回这一次**，库存 sha256 |
| `GET /v1/admin/keys?forumUserId=` | 列密钥（prefix/时间/吊销态，不回明文） |
| `POST /v1/admin/keys/revoke` | 吊销 `{ keyId }`；吊销后客户端推送/自查立即 401 |
| `GET /v1/usage/leaderboard?days=30&limit=50` | 榜单：按论坛用户跨设备聚合，`totalTokens` 降序 |
| `GET /v1/admin/usage?forumUserId=&days=30` | 读单个用户的用量（响应与 `/v1/usage/me` 同构）——论坛个人页渲染的**正规通道**：用户 key 只在签发那一次露面，论坛不该留明文 |
| `GET /v1/usage/me?days=30` | 个人聚合（也可用用户自己的 `tsu_` key 直查）：窗口 totals + 逐日 + 各设备快照 |

论坛接入流程：

1. 用户在论坛个人页点「生成同步密钥」→ 论坛后端调 `POST /v1/admin/keys` → key 展示给用户一次
2. 用户填进 CLI 配置，客户端开始自动上报
3. 论坛渲染：个人页用 `GET /v1/admin/usage?forumUserId=`（论坛后端持 `ADMIN_TOKEN` 直读，与 `/v1/usage/me` 同构；用户自己带 key 时也可走 `/v1/usage/me`）；榜单页后端拉 `/v1/usage/leaderboard` join 论坛昵称/头像

> 备选路径：论坛也可以**自建接收端**绕开 token-server——客户端契约（§3）不变，按 deviceId upsert 即可。推荐走 token-server：密钥体系、stale 守卫、口径校验都已实现并有测试覆盖。

## 5. 本地调试（联调用）

公开 sidecar 暴露查询、同步与设置路由（`Authorization: Bearer <sidecar token>`）：

```bash
# 本地台账视图（窗口聚合 + 全量累计）
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/token-ledger/summary?days=30"
# 同步状态：deviceId / pending / 上次推送回执
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/token-ledger/status"
# 立即同步一次（联调主力；未配置 endpoint 返回 400 + 配置提示）
curl -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/token-ledger/sync"
```

token-server 本地起：`cd token-server && npm run db:init:local && npm run dev`，然后 `RIVET_FORUM_API=http://127.0.0.1:8787/v1/token-usage rivet` 即可看到真实上报。

`GET /token-ledger/settings` 返回不含密钥的配置；`PUT /token-ledger/settings` 接收局部更新，密钥仅写入、不回显，字段缺省时保留原值，传空字符串时清除密钥并关闭自动同步。两条路由均要求 sidecar 鉴权。

服务端必须返回 `2xx` 和 JSON `{ "ok": true, "stale": false }` 才确认上传摘要。HTML、无效 JSON、旧快照回执与网络错误保留待同步状态；请求不跟随重定向。

## 6. 边界与 FAQ

- **payload 里没有会话内容**：只有 token 计数与模型名，不含代码、prompt、文件路径。
- **升级与恢复**：保留 `token-ledger.json` 与 `token-ledger.json.identity.json`。身份文件保留设备 ID 和单调快照时间；账本缺失或损坏时，会沿用原设备 ID 从保留的计费日志恢复，损坏文件另行备份。日志已删除时须优先恢复完整账本备份，不能保证仅靠身份文件恢复全部用量。无法恢复原设备身份时拒绝重建并上传，避免新设备重复累计。请勿同时删除两份文件后重扫历史。
- **换 key**：同一账号更换同步密钥后，用原设备 ID 重传累计快照，历史只保留一份；不同账号接管已有设备会被服务端拒绝，不能通过重置设备 ID 绕过。
- **cost 口径**：按模型原始定价单位估算（官方 DeepSeek 峰谷）；可能混合币种，展示应去掉固定货币符号并说明不是统一费用。账单以平台为准。
- **version 演进**：新增字段只向后兼容地加；破坏性变更递增 `version`，token-server 对未知版本回 400（客户端停推留回执）。

# tianshu-imbridge

[![Release](https://img.shields.io/github/v/release/KhalilYamber/tianshu-imbridge)](https://github.com/KhalilYamber/tianshu-imbridge/releases)
[![License](https://img.shields.io/github/license/KhalilYamber/tianshu-imbridge)](LICENSE)

把手机 QQ 与微信接进天枢：消息直达，回复直回。每条对话线都在天枢桌面端以「原生会话」的形态存在——多轮上下文由服务端维护，可回看、可继续。

<details>
<summary>目录</summary>

- [特性](#特性)
- [工作方式](#工作方式)
- [安装](#安装)
- [配置](#配置)
- [命令](#命令)
- [交互转发](#交互转发)
- [工具](#工具)
- [安全须知](#安全须知)
- [已知限制](#已知限制)
- [开发](#开发)
- [致谢与许可](#致谢与许可)

</details>

## 特性

- **双通道**：QQ 与微信（iLink / ClawBot）各一条连接，独立启停、互不干扰
- **双向消息桥**：手机 IM ↔ 天枢，无中间转接
- **原生会话**：一条 IM 对话线 = 一个桌面端可见的天枢会话，多轮上下文由服务端维护
- **自动命名**：IM 建的会话由天枢自动起标题（和您在电脑上新建会话一样），不再拿消息原文当名字
- **命令层**：`/workspacelist`、`/workspace`、`/sessions`、`/session`、`/new`、`/history`、`/help`——本地处理、零模型调用、带首次使用提示
- **微信扫码绑定**：对天枢说一句「接入微信」，二维码自动落到桌面；命令行入口备用
- **双模式**：serve 环境自动走原生会话；TUI / 独立进程自动降级 headless
- **交互转发**：天枢的提问卡片与审批请求会转发到手机——回复编号 / 「批准·拒绝」即可作答
- **工具**：`im_status`、`im_send`、`weixin_bind_start`、`weixin_bind_status`
- **单依赖**：运行时仅 `@tencent-connect/qqbot-nodejs`（官方 SDK）；微信通道用 Node 内置 fetch 实现，不引入新依赖

## 工作方式

```mermaid
flowchart LR
  QQ["手机 QQ"] -->|消息| P["tianshu-imbridge<br/>（插件）"]
  WX["微信"] -->|消息| P
  P -->|"serve 可用"| S["天枢原生会话<br/>（桌面端可见）"]
  P -->|"serve 不可用"| H["headless 降级<br/>（客户端历史）"]
  S --> R["回复"]
  H --> R
  R --> QQ
  R --> WX
```

- **serve 原生会话（优先）**：插件运行在天枢 serve 进程内，每条对话线绑定一个原生会话——首条消息建会话，后续消息送入同一会话，回复经事件流收集
- **headless 降级（TUI / 独立进程）**：回退到单次调用 + 客户端历史注入（默认保留最近 8 条往来）

## 安装

前置要求：

- 天枢桌面端 **4.0.4+**（TPI 插件接口；3.x 的 `package.json.tianshu` 清单已被宿主拒绝）
- Node.js **>= 24.22.1**（4.0.4 运行时的安全版本门槛；天枢自带 `node-runtime/win-x64/tianshu-runtime.exe` 满足）
- 至少一条通道的接入资格：QQ 开放平台机器人（AppID 与 AppSecret），或微信的 ClawBot 入口（微信 → 我 → 设置 → 插件）

步骤：

1. 从 [Releases](https://github.com/KhalilYamber/tianshu-imbridge/releases) 下载最新版（或克隆本仓库），放入插件目录：`<RIVET_HOME>\plugins\tianshu-imbridge\`
2. 在插件目录安装依赖：`npm install --omit=dev`
3. 配置凭据（见下节，QQ 与微信各一份，配一条用一条）
4. 重启天枢桌面端

重启后插件自动连接已配置的通道。想确认状态：让天枢调一次 `im_status`。

## 配置

### QQ 通道

配置文件位置：`<RIVET_HOME>\imbridge\config.json`

```json
{
  "appId": "你的 AppID",
  "appSecret": "你的 AppSecret",
  "ownerUserOpenid": "你的 openid（必填，见安全须知）",
  "workspace": "（可选）QQ 会话默认进入的工作区绝对路径"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `appId` | 是 | QQ 开放平台机器人的 AppID |
| `appSecret` | 是 | 机器人的 AppSecret |
| `ownerUserOpenid` | **是** | 你的用户 openid，**唯一的入站授权依据**；不填则一律不响应（安全默认） |
| `workspace` | 否 | QQ 会话默认进入的工作区绝对路径；留空则由插件自动指派 |
| `enabled` | 否 | 设为 `false` 可临时停用 QQ 连接（默认启用） |

也支持环境变量（临时测试用）：`TIANSHU_IM_QQ_APPID` / `TIANSHU_IM_QQ_SECRET`（环境变量优先于配置文件）。

凭据永不写入源码、永不进日志；`im_status` 只显示脱敏后的 appId。

### 微信通道（iLink / ClawBot）

配置文件位置：`<RIVET_HOME>\imbridge\weixin.json`（与 QQ 的配置**分开存放**，改一处不牵动另一处）

```json
{
  "botToken": "扫码绑定后自动写入",
  "ownerUserId": "你的 user_id（必填，见安全须知）",
  "workspace": "（可选）微信会话默认进入的工作区绝对路径"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `botToken` | 是 | 扫码绑定拿到的 bot token；由 `tools/weixin-bind.mjs` 写入 |
| `ownerUserId` | **是** | 你的 user_id（形如 `xxx@im.wechat`），**唯一的入站授权依据**；不填则一律不响应 |
| `baseUrl` | 否 | 接入域名，默认 `https://ilinkai.weixin.qq.com`；登录响应会覆盖 |
| `workspace` | 否 | 微信会话默认进入的工作区绝对路径；留空则由插件自动指派 |
| `enabled` | 否 | 设为 `false` 可临时停用微信连接（默认启用） |

也支持环境变量：`TIANSHU_IM_WEIXIN_TOKEN` / `TIANSHU_IM_WEIXIN_OWNER`（优先于配置文件）。

**绑定（推荐：直接跟天枢说一句话）**

1. 在天枢会话里说一句「接入微信」/「绑定微信通道」——天枢会调用 `weixin_bind_start`：
   它把二维码**图片放到桌面**（文件名 `天枢-微信扫码.png`；桌面不可用时落到插件数据目录并在对话里说明），
   随即将「图片在哪、下一步做什么」交回对话，不会把那一轮对话卡住。
2. 用手机微信扫这张图（微信 → 我 → 设置 → 插件）。若微信提示要验证码，把码告诉天枢。
3. 再对天枢说一句「扫好了」——它调用 `weixin_bind_status` 查结果：
   成功则凭据写入 `weixin.json` 并**自动填上 `ownerUserId`**（仅当原本为空；已有 owner 不会被覆盖）。
4. 按提示**重启天枢**（插件在启动时加载），然后给这个微信发条消息即可。

**绑定（备用：命令行）**：`"<天枢的 node.exe>" tools/weixin-bind.mjs`（需 `RIVET_HOME`）。
它和上面走的是**同一份核心**（`lib/weixin/binder.mjs`），只是把交互放在终端里。
两条路都只写盘、只回掩码，凭据不会整段打印。

## 命令

在 QQ 或微信里直接发（两条通道走同一套命令层）。命令**由插件本地处理，不送给模型**（命中命令时对模型的调用次数为 0）。命令必须是消息的**第一个词**，命令词不分大小写；以斜杠开头的路径（如 `/home/user/x`）不会被误判成命令。**忘了有哪些命令？发 `/help` 即可。**

| 命令 | 别名 | 参数 | 作用 |
| --- | --- | --- | --- |
| `/workspacelist` | `/wsl`、`/workspaces` | 无 | 列出可选工作区；编号即 `/workspace` 的取值 |
| `/workspace` | `/ws` | `<编号或绝对路径>` | 切换工作区：在目标工作区预建会话并换绑，下一条消息进新会话 |
| `/sessions` | `/sessionlist` | `[工作区编号] [--limit N]` | 列出会话（标题 + 编号；默认 10 条，最多 30 条） |
| `/session` | — | `<编号或会话 ID>` | 把这条对话线绑定到指定会话 |
| `/new` | — | 无 | 在当前工作区开新会话并换绑；旧会话保留，可用 `/sessions` 找回 |
| `/history` | — | `[N]` | 回看当前绑定会话的最近 N 条消息（默认 3，上限 20） |
| `/help` | `/h` | `[命令名]` | 看命令说明；不带参数看全部 |

示例：

```
/workspacelist
/workspace 2
/sessions 2 --limit 5
/session 3
/new
/history 5
/help history
```

命令行为要点：

- **工作区枚举根** = 配置项 `workspace` 的父目录（隐藏项与非目录除外）；工作区以目录为准，没有额外的注册表
- `/sessions` 的编号与 `/session <编号>` 共用同一份清单与排序
- `/history` 的数量在插件本地校验（1..20，缺省 3）；非法值按默认处理并在正文里说明
- 第一次用到某条命令时，回执末尾附该命令的完整用法；此后只附一行提示
- 若运行环境没有 serve 通道（TUI / 独立进程），除 `/workspacelist` 外的命令会明确提示「降级模式」，不会静默失败

## 交互转发

天枢需要您做选择时，聊天侧会同步收到，离开电脑也能作答：

- **提问**（天枢的「选择题」）：问题与选项以编号列表转发到 QQ / 微信，回复编号（如 `1`）或直接文字作答即可；
- **审批**（敏感操作确认）：请求实时转发，回复「批准」或「拒绝」继续——回合在服务端原地等您，不再干等到超时。

作答只认您本人（通道各自的 owner 配置）；桥不会自动批准任何请求。若请求几秒内已在电脑端处理，聊天侧不会被打扰。

## 工具

| 工具 | 用途 |
| --- | --- |
| `im_status` | 报告运行模式（`serve-native` / `headless`）、两条通道的连接状态、会话映射数、收发统计、微信绑定进展 |
| `im_send` | 主动给 owner 发消息（完成通知等）；可指定 `channel`（`qq` / `weixin`），目标缺省取该通道的 owner |
| `weixin_bind_start` | 启动微信扫码绑定：二维码图片放桌面，后台等扫码；立刻返回图片位置与用户该做的步骤 |
| `weixin_bind_status` | 查绑定进展：扫了没、凭据写了没、下一步该做什么（通常是重启天枢） |

## 安全须知

- **`ownerUserOpenid`（QQ）/ `ownerUserId`（微信）是必填项，它决定谁能指挥你的天枢。** 插件与天枢同进程运行，手里握着一个完整的 agent（文件与命令工具）；未配置时插件的行为是**一律不响应**。配置之后，只有这个主人的消息会被受理：QQ 侧私聊与群聊一视同仁（`@ 机器人` 只管噪音、管不了身份，所以 bot 即便被拉进群，群友也无法指挥它）；微信侧按官方协议只支持私聊，群消息一律拒收。
- **同一个 bot 不要在多处同时连接**（例如与 DSH 侧的连接并存）：QQ 网关允许重复连接，但事件分发行为没有官方定义，同一条消息可能被两端同时处理。两边都要用的场景：申请第二个 bot。微信侧同理：iLink 的长轮询游标是单条链，两个进程同时消费会互相抢消息（协议里没有互踢机制，但也没有并发保证）。
- **`im_send` 的 `targetId` 目前不设白名单**：低频自用无碍；公开场景下建议自行收紧。
- 凭据只放 `<RIVET_HOME>\imbridge\`（QQ 的 `config.json`、微信的 `weixin.json`），不要提交到任何仓库。

## 已知限制

- QQ 群聊（`group:`）路径尚未实机验证
- **serve 模式的回合终结事件名未在 4.0.4 上实测**（隔离实例建会话被运行中的会话库独占挡住，返回 503）：已加 12 秒静默兜底，最坏表现为「回复慢十几秒」，而非等满 180 秒超时；若宿主仍发 `turn_complete`，该兜底不生效
- macOS 未实测：平台分支（路径处理、桌面探测、子进程调用）有测试覆盖，但无真机环境走查
- **微信通道**：扫码绑定与文本消息双向收发已于 2026-10-01 真机打通（Windows / 天枢桌面端）；首版**不处理媒体**（图片 / 语音 / 文件 / 视频），收到时会回一句人话说明，不静默丢弃
- 微信通道的**已见消息去重集有上限**（500 条，超出淘汰最旧的）：服务端游标保证正常情况下不重放，所以这是防御性上限而非已知漏洞；但如果服务端异常重放很久以前的消息，理论上存在被重复处理的窗口

## 开发

- 运行测试：`node --test`（当前 447 例；其中微信通道 119 例）。Windows 与 Linux（WSL）双平台全量通过；测试内的路径按「执行 node 的平台」自适应，不要硬编码某一平台的路径形态
- 插件契约：**TPI 1.0** —— `tianshu.plugin.json`（清单，宿主据此发现插件）+ `index.js`（`defineTianshuPlugin({ id, activate })` 入口）+ `tpi.js`（SDK 垫片，宿主外调用即抛错）。工具实现在 `impl.js`，常驻态（配置 / 连接 / 桥）在 `runtime.js`；`activate()` 幂等，重复调用不会重复建连
- 模块地图：`index.js`（TPI 入口，保持轻量）· `impl.js`（工具实现）· `runtime.js`（常驻态）· `lib/bridge.mjs`（消息桥）· `lib/serve-client.mjs`（原生会话通道）· `lib/command*.mjs`（命令层）· `lib/qq/`（QQ 连接与配置）· `lib/weixin/`（微信连接与配置）· `lib/data-dir.mjs`（两通道共用的数据目录）· `test/`（单元测试）· `tools/`（e2e、探针、扫码绑定与部署同步工具）
- 微信扫码绑定：`"<node>" tools/weixin-bind.mjs`（需 `RIVET_HOME` 指向天枢数据目录）
- 部署同步：`"<node>" tools/sync-deploy.mjs`（把开发位置同步到天枢插件目录并逐字节核对）
- 设计依据与实测记录：`docs/command-mapping.md`、`docs/prior-art-survey.md`
- 设计约束：入口保持轻量（顶层 import 链失败会导致插件被静默跳过）、凭据零泄漏、不硬编码个人路径、不引入新依赖（iLink 用内置 fetch 实现）

## 致谢与许可

- [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)：QQ 渠道设计参考（`lib/vendor/` 为其移植参考材料）
- @tencent-connect/qqbot-nodejs：腾讯 QQ 开放平台官方 Node.js SDK

本项目以 [MIT 许可](LICENSE) 发布；第三方组件声明见 THIRD_PARTY_NOTICES.md。

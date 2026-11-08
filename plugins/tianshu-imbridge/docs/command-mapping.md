# 命令对照表 · QQ 侧命令 ≫ 天枢端点

> 命令层的施工图：每条待实现命令依赖哪个端点、哪些字段、数据从哪来、有什么已知风险。
> 字段名与语义来自实测，原始输出见 `docs/research-notes/serve-endpoints-20260924.txt`（下称 **A**）
> 与 `docs/research-notes/serve-event-reconstruction-20260924.txt`（下称 **B**）。
> 无实测支撑的一律进 §四「未证项」，并在正文标注 `[未证]`。
> 本文件经独立 subagent 冷视角核查并据其意见修订（第一版被打回：枚举缺排除规则、游标结论证据不足、
> 关键端点缺席、字段清单漏项、窗口机制误判为「未知」）。

## 引用符号约定
- **A** = `docs/research-notes/serve-endpoints-20260924.txt`
- **B** = `docs/research-notes/serve-event-reconstruction-20260924.txt`
- **C** = `docs/research-notes/runserve-token.txt`（宿主运行时片段，含 `compactReplayRunsWithStats` 与 `maxEvents`）
- **D** = `<RIVET_HOME>\desktop\sessions\2026092356ddae79dff4\events.jsonl`
  （真实会话原始事件档，35287 条；§一.5 的窗口与残段数字全部出自它）

## 一、逐命令对照

### 1. `/workspacelist`（别名 `/wsl`、`/workspaces`）
- **端点**：无专用端点；`GET /sessions` 仅作交叉校验。
- **字段**：枚举根下的目录名（编号即序号）；校验用 `GET /sessions` → `sessions[].cwd`。
- **数据来源**：文件系统目录枚举。枚举根 = **插件配置项 `workspace` 的父目录**（插件自己的配置文件
  `<RIVET_HOME>/imbridge/config.json`；本机 `workspace=D:\path\to\bridge天枢默认` → 根 `D:\path\to`。
  注意宿主主配置 `<RIVET_HOME>/config.json` 里的 `workspace` 是空对象，不是这个值）。
- **排除规则**：只排除 **①点开头的隐藏项 ②非目录**。实测：裸枚举得 4 项，其中 `.rivet`
  （内含 `knowledge/`、`meridian.db`）被隐藏项规则挡掉；滤除后才是 3 项。
- **⚠️ 勘误（2026-09-24，实现期实盘发现）**：本表初稿曾要求「排除任何含 `.rivet/` 或 `meridian.db` 的目录」。
  按真实磁盘验证后**作废**——每个工作区内部都自带一份 `.rivet/`（各自有 knowledge/ 与 meridian.db），
  该规则会把 **3/3** 个真工作区全部误杀（实测可用数变成 0）。数据目录 `.rivet` 本身是隐藏项，第一条已覆盖。
  实现与回归用例：`lib/workspaces.mjs` 文件头注、`test/workspaces.test.mjs` 的
  「回归: 工作区内部自带的 .rivet/meridian.db 不得导致它被排除」。
- **风险**：天枢没有工作区注册表，目录即真理，排除规则一旦漏项就会让用户看见假工作区。
- **dsh-im 处置**：**借形**（命令名、别名划分、编号可读）；**必须重写**（它读 DSH 的工作区注册表，天枢没有这个东西）。

### 2. `/workspace <序号|绝对路径>`（别名 `/ws`）
- **端点**：`POST /sessions`（`{cwd, title}`）→ 201；**随后每条消息用 `POST /sessions/:id/prompt`（`{prompt}`）推进**（异步启动，回复须回读事件流）。`DELETE` 未实测，本次不使用。
- **字段**：`cwd`（目标工作区绝对路径）、`title`（沿用 `lib/bridge.mjs` 的 `sessionTitleFor`）。
- **数据来源**：序号 → 由上一条命令的枚举结果解析；也接受绝对路径直填。
- **风险（实测级）**：
  1. `POST /sessions` **完全不校验 cwd**：传 `cwd: 123` 静默回落 `runtime-default`（A:14），传不存在的目录照样 201
     且标 `workspaceSource: "explicit"`（A:15）。**目标目录必须由插件自己校验**，否则会给出一个永远不会出错的假成功。
  2. **「建会话后立刻 prompt 返回 400」——已按宿主源码复核，口径更新**（2026-09-29）。
     - 旧记录：B:6 括号自注「实测刚建完立刻 prompt 会撞上竞态，返回 400」（**单次观测**，无状态码上下文），
       该观测跑在 2026-09-24 14:58；当前 rivet-runtime 的构建时间是同日 16:46，**两者不是同一个宿主版本**。
     - 30 次分档复核（`docs/research-notes/prompt-race-recheck-20260924.md`，6 档 × 5 轮）**全部 200，未复现**。
     - 源码复核（2026-09-29 的运行时，`chunk-X2VRZHNQ.js:8144-8199`；该文件在当日运行时更新后已不存在，
       按函数名 `resolveAppPromptInput` / `looksLikeFilePath` 检索可重新定位）：`POST /sessions/:id/prompt` 只有四处返回 400——
       空 prompt、images 载荷、documents 载荷、以及 `trimmed.startsWith('/')` 且 `resolveAppPromptInput` 返回 null 时的
       `Unknown slash command`。前三条与插件的调用形态不相交；第四条被插件自己的命令层拦住
       （`lib/command.mjs` 的形状判定把单段 `/[A-Za-z]…` 全部本地处理，送出去的斜杠消息必然是多段或非字母开头，
       在宿主 `looksLikeFilePath`（`chunk-2MG6J2TE.js:17341`）那里一律判为路径放行）。
     - **并发走的不是 400**：宿主在 run 之前有 `await manager.waitForRunSettled(id)`（同文件 :8190），抢跑返回
       **409 `Session is already running`**（:8196）。
     - **结论：不加重试。** 400 的四条来源没有一条能靠等待化解，重试只会把确定性错误重放一遍。
       用户侧目前看到的是 `（天枢呼叫失败：prompt 失败（HTTP 400）: …）`；把 409 busy 与未知命令各说成人话的文案细化，留作后续小类，本轮未做。
     - 相邻风险（**未实测**，由上述两处代码推出）：`promptSession` 用整轮 180s 预算，而宿主会挂到上一轮结束；
       若超过 180s，客户端断开而宿主仍可能执行该 prompt，用户看到失败、重发即双发。
     `/workspace` 采用「预建会话 + 换绑」绕开这条最短路径（见 `lib/command-handlers.mjs` 的注释），以下两个就绪探测方式仍然不可用：
     - `GET /sessions/:id` **探不出就绪**——它任何时候都返回 200（会话 `status: idle` 时也给 200，A:59；只有不存在的会话才是 404，A:110）。
     - 「等该会话出现轮次启动类事件（`status: running` / `phase`）」**做不到**——没发 prompt 之前该会话根本没有任何事件
       （新建会话实测 `events=0` / `lastSeq=0`，A:80；首个事件就是 prompt 之后的 `user`），那是死等。
- **绑定语义**：切换 = 解除当前 QQ 对话线的旧绑定（`session-map.json`），下一条消息在目标工作区建新会话。
- **dsh-im 处置**：**借形**（参数形态「序号或绝对路径」、切换后的确认文案）；**必须重写**（天枢切换意味着换 cwd 重建会话，不是改一个绑定字段）。

### 3. `/sessions [工作区序号] [--limit N]`（别名 `/sessionlist`）
- **端点**：`GET /sessions`（可选 `?includeArchived=true`）。
- **字段（并集 17 个，A:21-38）**：`id`、`title`、`cwd`、`status`、`createdAt`、`updatedAt`、`lastSeq`、
  `contextTokens`、`contextWindow`、`model`、`domain`、`domainGlyph`、`domainAccent`、`pendingApprovals`、
  `workspaceSource`、`missionId`、`error`。
  - **可选字段**：`missionId`（A:32 实测 15 个对象里 12 个有）、`contextTokens`/`contextWindow`、`error`（A:29，1/15）。
    **取值前必须判空**。
  - **`error` 是失败会话唯一的可见信号**（如 "No usable API key…"），列表里建议按需提示。
- **数据来源**：一次拉全量，插件自己做工作区过滤与条数截断。
- **风险**：未见分页参数（15 条一次返回、无分页痕迹 `[未证]`），列表随会话数增长后的行为未知；输出长度须受 QQ 侧约束。
- **dsh-im 处置**：**借形**（列 ID 与标题、可按工作区限定与 `--limit`）；**必须重写**（它调 `harness.listWorkspaceSessions()`，天枢用 HTTP 列表自己过滤）。

### 4. `/session <序号|会话ID>`
- **端点**：`GET /sessions/:id` 校验目标 → 404 `{"error":"Session not found"}` 即无效（A:110）；
  **绑定生效后由 `POST /sessions/:id/prompt` 推进**（异步，回复回读事件流）。
- **字段**：写入 `session-map.json` 的值为 `id`。
- **数据来源**：序号 → 上一条命令的列表结果；也接受 session id 直填。
- **风险**：绑定到「存在但从没跑过」的会话是合法的（`lastSeq=0`）；绑定后下一条消息会推进该会话，语义要在文案里讲清。
- **dsh-im 处置**：**借形**（手动绑定的交互与提示语）；**必须重写**（它绑 DSH 会话体系，天枢绑 serve 会话 + 本地绑定表）。

### 5. `/history [N]`（默认 3，上限 20）
- **端点**：`GET /sessions/:id/events?since=0`。
- **字段**：事件对象 `{seq, ts, type, data}`。消费三类：
  1. `user` → `data.text`
  2. `text_delta` → `data.text`
  3. `queue_pending` → `data.text`（**别漏这一类**）
  其余类型一律忽略：`phase`、`hook_result`、`tool_result`、`tool_use`、`thinking_delta`、`status`、`goal_state`、
  `zen_phase`、`done`、`error`、`queue_status`、`steer_delivered`、`todo_state`、`resume_offer`、`model_switched`、`artifact`。
- **为什么必须消费 `queue_pending`（实测，别省）**：会话运行期间由桌面端或排队通道送入的用户输入，
  **文本只落在 `queue_pending.text` 里，不会产生 `user` 事件**。本窗口唯一一条这类输入即
  `31559 queue_pending {"text":"改造完之后呢，在QQ上给我发消息。因为我后面要离开电脑出门了。"}`
  配 `31620 queue_status {status:"steered"}`，而窗口内 2 条 `user` 事件（31146、34705）里**没有它**
  （整档 15 条 `user` 中亦无，D）。
  按「只认 user」实现，这条用户原话会静默消失，助手对它的回答还会被挂到上一条用户消息下面。
- **去重规则**：宿主会把部分排队输入以 `[排队跟进 — 上轮运行期间排队，请一并处理]` 前缀重发成 `user` 事件。
  因此若某条 `queue_pending.text` 的文本出现在某条 `user` 事件的文本中，**只算一次**。
- **回显前剥掉宿主注入前缀**：`user` 事件里混有宿主注入的伪消息（`[排队跟进 …]`、`[续跑] 上一轮执行被进程重启打断…`）。
  `/history` 是给用户看原话的，应剥掉这两个前缀；剥离后为空则跳过该条。
- **游标语义**：**排他** `seq > since`（有事件会话实测 `since=0/1/3/5` → 收到 5/4/2/0 条，逐条对上，A:104-107）。
  超界、负数、非数字、缺参数 → 200 且返回空，**不报错**；但这组只在**空会话**上量过（A:83-88，A:90 自注），
  非空会话上的行为 `[未证]`。
  **本命令固定用 `since=0`**（要的就是尾部窗口），所以命令层**不产生** `since`；真正要收口的是参数 `N` ——
  必须在插件本地校验为 1..5 的整数，缺省 3，非法值按缺省处理，**永不把用户输入透传成游标**。
  ⚠️ 与既有实现的对齐：`lib/serve-client.mjs` 的 `fetchEvents` 写作 `?since=${Number(since) || 0}`，
  非数字会被折成 0（`Number('abc')||0 === 0`），**但负数不会**（`Number(-1)||0 === -1`，会原样进 URL；
  服务端对负数返回空，A:86）。所以轮询路径上「安全透传」这件事根本不存在；
  好在那条路的游标由客户端自己算，且已有红队修复留下的 `seq > baseline` 过滤兜底，不会把历史重放进回复。
- **数据来源**：事件流 → 还原成「用户 / 助手」序列（可行性实测：受控两轮逐条对照 **4/4**，B:25）。
- **还原规则**：
  1. 消费顺序 = 事件 seq 升序；**以收到的首条 seq 为基线**，不得假设从 1 开始。
  2. 序号**不保证连续**（新会话 `1..43` 也有缺口，B:13），**不得用序号算术推断缺了多少条**。
  3. **窗口内的回合边界要辨真伪**（窗口起点常落在回合中间：实测起于 30444 的 `thinking_delta`，
     而窗口内首条 `user` 在 31146，中间 702 条事件）。
     **收尾判据**：段尾出现 `turn_complete` **且 `data.isFinal !== false`** —— 其**后面可以还跟着 `done`**
     （本例段尾是 31140 `phase` / 31144 `turn_complete{isFinal:true}` / 31145 `done{completed}`；
     若按「最后一条必须是 turn_complete」实现就判不出来）。**非 final 的 `turn_complete` 只算子回合边界，不算收尾**
     （同一段里有 4 条 `turn_complete`，其中 3 条 `isFinal:false`）。
     - **最老那一段（首个 `user` 之前）**：以 final 收尾 → 是一段**完整、但提问落在窗口之外**的回答
       （本例拼接 `text_delta` 得 **1126 字**成句回复，D）→ **保留**，加注「（此轮提问不在窗口内）」；
       **无 final 收尾 → 才丢弃**，并在文案里说明最老一轮不完整。
     - **以 `user` 开头的段，一律保留提问**，绝不因为「没有 final 收尾」就整段丢掉——那条用户原话是真的；
       助手文本不足时按「此轮被中断、不完整」标注即可。
       （反例提醒：`34704 done{status:"interrupted"}` 位于**窗口内的第二轮**，不是最老那段；若拿它当
       「无 final 收尾 → 丢弃」的样板，会连 31146 那条真实提问一起丢掉。）
- **窗口机制（已查明主体）**：接口给的是**读取期先合并、再定位出来的尾部**，不是全量。
  实测某会话元数据 `lastSeq=35287`，只返回 673 条、seq 起于 30444。机制见宿主运行时的
  `compactReplayRunsWithStats(existing.events, { keepOpenTail: true })`（证据档 C:12）
  与 `maxEvents` 默认 5000（C:7，环境变量 `RIVET_MAX_EVENTS`）。**注意别把它当成窗口模型**：本窗口原始事件只有
  4844 条（< 5000），5000 不是切在 30444 的原因，「起点为何落在 30444」仍属未证（§四.1）。本次按原始事件档复算吻合：
  `4844 - (thinking_delta 4002 - 40) - (text_delta 244 - 35) = 673` —— 即**相邻同类 delta 段被合并成单条事件**
  （合并保序，文本仍连续）。所以：**不要因为「没看到某条 text_delta」就断定文本丢了**，它是被并进了同段。
  仍未知的只剩「起点 30444 的选取规则」（见 §四）。
- **风险**：窗口不足 N 条时不能假装补全，要如实说明。
- **dsh-im 处置**：**借形**（参数形态 `[数量]`、默认 3；上限 20 为本实现自定，见 `lib/command.mjs` 的 `COMMAND_USAGE.history`）；
  **必须重写**（它直接读消息级存储，天枢要从事件流自己还原并处理窗口与合并）。

### 6. `/new`（原地开新会话）
- **端点**：`GET /sessions/:id`（读当前绑定会话的快照，取 `cwd`）→ `POST /sessions`（`{cwd}`，不传 `title`）预建 → 换绑。
- **数据来源**：cwd 取自**当前绑定会话**的快照（语义是「原地重开」，不换工作区）；无绑定、会话不存在（404）、
  快照读失败（5xx）与快照缺 `cwd` 四种情况一律只回绝，**绑定不动**。
- **与 `/workspace` 的关系**：复用同一套「预建会话 + 换绑」（绕开「建会话后立刻 prompt 撞 400」的竞态，见 §2），
  差别只在 cwd 来源：`/workspace` 来自用户指定的目标，`/new` 来自当前会话快照。旧会话不删——`/sessions` 挑编号、`/session` 绑回去。
- **不传 `title`**：与 `/workspace` 同一取舍，命名权留给宿主（见「一之二」）。
- **dsh-im 处置**：**新设**（dsh-im 没有对应命令；它切换工作区兼了开新会话的职责，没有「原地重开」的独立动作）。
- **实现与回归**：`lib/command-handlers.mjs` 的 `new` 处理器（文件内注释）；用例 `test/command-handlers.test.mjs` 的
  「/new：原地开新会话」组（9 例：正常换绑、桥下一条消息进新会话、四种失败路径、快照缺 cwd、降级模式）。

## 一之二、会话标题：谁起名（2026-09-30 实测）

**结论：起名权交给宿主，插件不抢。**

- 宿主机制：会话收到**第一条用户消息**时，若 `record.title` 仍为空，就用便宜模型生成一个 ≤40 字的
  概括性标题（提示词要求：跟随用户语言、去掉「帮我 / 请」这类客套、写名词短语而非整句）。失败即放弃
  （fail-open），桌面端退回显示会话 ID 前 8 位。起名前与写入前各检查一次「是否已有标题」，
  **已有标题绝不覆盖**。
- 插件因此**不再传 `title`**：以前传 `QQ: 前 30 字`，恰好命中「已有标题」，把宿主的自动命名永久堵死，
  桌面端会话列表里全是半截句子。
- **兜底**：宿主那条路是 fire-and-forget，可能慢或失败。插件在本会话第一条消息的回复投递完之后
  查一次标题（`ensureTitle`：先读后写，空则补 `QQ: …`），保证桌面端至少有个可读名。
  非首条消息不查，不给常规路径加开销。
- `/workspace` 预建的会话同样不传标题，命名由用户发出的第一条消息触发（该会话在首条消息之前
  只显示会话 ID；工作区信息在 `cwd` 字段里，不靠标题携带）。

> ⚠️ 引用宿主的行号请连同版本一起看：**2026-09-29 的运行时更新过一次，chunk 文件名会整体更换**。
> 本文里所有 `chunk-*.js` 引用都以写下时的运行时为准（见各条标注），换版后按函数名检索，别按文件名找。

## 二、工作区口径结论（含实测数字）

**结论：以「目录枚举」为准，用「会话 cwd 反推」做交叉校验；枚举必须带排除规则。**

| 口径 | 实测结果（本机 2026-09-24） |
| --- | --- |
| 目录枚举 `D:\path\to\*`（含隐藏） | 4 项：`.rivet`、`bridge天枢默认`、`coding`、`日常` |
| 同一枚举**滤除隐藏项后** | 3 项：`bridge天枢默认`、`coding`、`日常` |
| 会话记录 `cwd` 去重 | 同名 3 个（各带 1 / 3 / 8 个会话，合计 12 个会话） |
| 两者比对 | 滤除 `.rivet` 后：**互不多不少**（cwd 有目录无：无；目录有 cwd 无：无） |

**注意**：「互不多不少」这个结论**依赖排除规则**才成立。`.rivet` 就是反例——它是天枢自己的数据目录（含 `knowledge/`、`meridian.db`），
不是用户的工作区，但它确实躺在枚举根下。排除规则见 §一.1。

**为什么以枚举为准**：反推只能看见「已经有会话的」工作区，一个刚建好、还没用过的目录会被漏掉；而用户问「有哪些工作区」时，
他期待看到的是全部可选目录。

**与 dsh-im 的差异**：dsh-im 的 `/workspacelist` 读的是 DSH 的工作区注册表（DSH 里工作区是一等公民、有权威列表）；
天枢里工作区只是「会话记录的一个 `cwd` 字段 + 一个目录约定」，没有注册表。**同一件事，一边查表，一边数目录。**

## 三、dsh-im 差异处置逐条

| dsh-im 的东西 | 处置 | 理由 |
| --- | --- | --- |
| `/workspacelist`、`/workspace`、`/ws`、`/wsl`、`/workspaces` | 借形 + 必须重写 | 命令名与别名划分照用；实现依赖 DSH 工作区注册表与路径快照，天枢没有 |
| `/sessions`、`/sessionlist`、`/session` | 借形 + 必须重写 | 交互与提示语照用；实现调 `harness.listWorkspaceSessions()`，天枢用 HTTP 列表 |
| `/history [数量]` | 借形 + 必须重写 | 参数形态与上限照用（数字来源不可复核，见 §一.5）；实现须自己从事件流还原并处理窗口/合并/残段 |
| `/m` 可点击分页菜单（分页 6 项、15 分钟过期、一次性认领） | 弃用（本次） | 本次非目标；其交互约定值得将来借形。**这些数字同样源自未 vendor 的 dsh-im 源码，仓库内不可复核** |
| `/compact` | 弃用 | 天枢路由表里没有对应端点，无此能力可映射 |
| `/model` `/models` `/preset` `/steer` `/batch` `/send` `/cancel` `/status` `/version` | 弃用（本次） | 本次命令集之外的既有命令面，不在范围内 |
| `harness.ensureRunning()` 等宿主进程管理 | 弃用 | 天枢插件与 serve 同进程，不存在「管宿主机启停」 |
| `shared/state-store`、`shared/deferred-state`、`shared/harness-approval` 等 | 弃用 | 这些模块**根本没随 vendor 复制**，且与 DSH 状态体系耦合 |

**「只抄来外壳」的精确数字**：`lib/vendor/core-qq/` 与 `host-qq/` 引用了 **30 个** `../shared/*.mjs` 顶层模块，
外加 **4 个** `../shared/semantic/*.mjs`，另有 **7 处** `../../../../src/channels/shared/*.mjs` 引用
（多出 `image-input-settings-store`、`bot-workspace-store`、`default-workspace`、`agent-preset`、`model-setting` 等名字）。
**`lib/vendor/shared/` 目录不存在**——这一层一个字节都没搬进来。

## 四、未证项（不许含糊，单列在此）

1. **窗口起点 30444 的选取规则**：窗口大小本身已查明为「读取期压缩的尾部 + delta 段合并」（见 §一.5），
   但**起点为什么落在 30444** 未证（只测了一个会话，`keepOpenTail` 的具体边界行为未读透）。
2. **非空会话上的游标异常输入**：`since=abc`/`-1`/超界在**有事件**的会话上是否仍返回空，未测；
   这正是 `/history` 必须自己校验 N 的理由。
3. **无 `workspace` 配置时的枚举根兜底**：拟用「现有会话 cwd 的公共父目录」，未实测。
4. **`GET /sessions` 是否分页**：15 条一次返回，未见分页参数；会话数增长后的行为未验。
5. **`archived` 语义**：`includeArchived` 参数存在，但本次没造出 archived 会话，差异未量。
6. **群聊路径**：本次全部按 `c2c` 语义设计，`group:` 下的命令行为未验。
7. **`assistant` 消息的「实况」**：受控实验里 assistant 文本属**强预期**（模型按指令回复），非独立存档核对；
   user 侧才是逐字独立比对。
8. **`DELETE /sessions/:id`、`POST /sessions/:id/abort`**：路由存在但本次未测，不使用。
9. **读取期合并流与客户端精确游标的对齐关系**：服务端是「先对整会话做合并、再取尾部」，而客户端游标用的是原始
   `seq`。合并事件的 `seq` 是**段内代表值**，因此传精确 `since` 时合并边界与游标可能错位，粒度只保证到「段」。
   本轮只观测到「合并只作用于 delta 类、不跨类型」（`phase 220→220`、`hook_result 162→162`、`turn_complete 53→53`
   三类段数=条数），**没有**读透其内部次序。`/history` 用 `since=0` 不受影响，但轮询路径需知道这一点。

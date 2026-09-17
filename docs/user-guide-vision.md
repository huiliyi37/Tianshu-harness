# 识图能力用户手册（视觉通道）

> 天枢什么时候能真的「看见」图片、看不见时会怎样、桌面端与 TUI 分别怎么配。

---

## 三种状态

图片能不能进模型，取决于**主控模型**的能力和有没有配识图桥：

| 状态 | 条件 | 行为 |
|------|------|------|
| **直接看图** | 主控模型声明 `supportsVision` | 图片作为多模态消息追加到对话尾部，模型直接看 |
| **同 provider 自动桥**（默认） | 主控不支持 **+** 未配 `visionModel` **+** 同 provider 下有视觉档 | 自动启用该视觉档做桥，无需任何设置 |
| **桥接描述** | 主控不支持 **+** 配了 `agent.visionModel` | 图片先发给识图模型换成文字，只有描述进主对话 |
| **跨 provider 自动桥** | 主控不支持 **+** 未配 `visionModel` **+** 开了 `agent.visionAutoBridge` | 自动挑一个别家可用视觉模型做桥，行为同上 |
| **丢弃** | 以上都不成立 | 图片不发送 |

最后一种状态是**会明说的**：TUI 在消息气泡下方给出警告，截图工具的结果文字里也会写明"非视觉模型该附件会被自动丢弃，改用 `observe` / `extract` / `eval` 读 DOM"。早期版本静默丢弃，模型会凭"我截了图"断言渲染正常——截图是验证手段，能让模型声称验证过它没看见的东西，比没有这个工具更糟。

两级自动的边界：**同 provider 自动桥默认开**——主模型每轮都在向该 provider 发送完整对话，图片发给同一方不引入新的数据流向或计费主体；**跨 provider 自动桥默认关**，而且是有意关的：它会把你的图片发给一个你从未为此选择过的 provider，那是成本与隐私决定，不该由默认值代做。关着的时候天枢不会闷声不响——如果仓里确实有能看图的模型，状态里会点名它并告诉你怎么启用：

```
未配置 agent.visionModel；检测到可用视觉模型 minimax/MiniMax-M3，在 /config → 识图模型 选定它，
或设 agent.visionAutoBridge=true 让它自动选（会把图片发给该 provider）
```

## 哪些内置模型能直接看图

| Provider | 模型 |
|----------|------|
| `deepseek` | `deepseek-flash`（V4.1 线，原生多模态） |
| `glm` | `glm-5.3-flash`、`glm-5.2` |
| `minimax` | `MiniMax-M3` |
| `siliconflow` | `zai-org/GLM-5.2` |
| `codex` | `gpt-5.6-sol` |
| `ccswitch` | `glm-5.2`（别名 `cc-glm`） |

DeepSeek 当前默认档 `deepseek-flash` **原生支持识图**，配图即用、无需任何设置；`deepseek-v4-flash` 是纯文本档，但同 provider 下有 `deepseek-flash`，同 provider 自动桥会选中它——DeepSeek 用户配了 key 就能读图，两条路都不用手动配桥。

自定义 provider / 自己加的模型必须在那条 model 上手写 `"supportsVision": true`，否则天枢按纯文本模型对待。这个字段是**按模型**声明的，不是按 provider——同一个 provider 下文本模型和多模态模型混编是常态。

## 配识图桥

### 推荐：TUI `/vision`

在 TUI 输入 `/vision`，按以下步骤添加一个专用识图服务：

1. 输入视觉服务的 `https://...` endpoint 和专用 provider 名称；
2. 选择直接粘贴 API Key，或输入环境变量名；
3. 天枢从该 endpoint 的 `/models` 获取候选；
4. 只从刚返回的候选中选择一个模型；
5. 对所选模型发送一次测试图片。收到非空回答后才保存配置。

这个流程会新建或复用一个**仅用于识图桥**的 provider 和模型，不会改变默认 Provider、主控模型或普通模型选择器。粘贴的 key 只写入 `secrets.json`；环境变量方式只保存变量名，且变量必须对运行 TUI 的进程可见。

发现、图片验证或保存失败时，原有识图桥配置不会被替换。自定义 endpoint、聚合服务和未在内置列表中的模型也可以使用：只要 endpoint 返回该模型，仍会对它发送同样的图片验证。

### 已有 Provider 或高级配置

如果视觉 Provider 和模型已经配置好，可在 Settings、`/config` 或命令行直接选择桥接模型。手改配置时可使用：

```jsonc
{
  "agent": {
    "visionModel": {
      "provider": "minimax",
      "model": "MiniMax-M3",
      "prompt": "请详细描述这张图片…",  // 可选，描述提示词
      "maxTokens": 1024,                // 可选，描述的输出上限
      "fallback": {                     // 可选，主视觉模型 5xx/超时时自动切
        "provider": "glm",
        "model": "glm-5.2"
      }
    },
    // 跨 provider 自动桥：未配 visionModel 时自动挑别家可用视觉模型
    // （同 provider 有视觉档时已默认自动启用，无需此开关；默认 false）
    "visionAutoBridge": false
  }
}
```

手动选择的两个前提：该 provider 已配好 key，且目标模型声明了 `supportsVision`。`/vision` 会在图片验证成功后自动创建这两个配置项。

`fallback` 是**主备双桥**：主视觉模型报 5xx / 超时才切备用（同 `FallbackStreamClient` 机制）。备桥起不来（缺 key、模型不存在）不致命，只在日志里点名并降级为单桥。

### 同一张图反复追问：`ask_image`

配了桥（或主控本身多模态）之后，模型可以用 `ask_image` 就**同一张图**反复追问，不需要你重发：

```
ask_image { question: "逐字念出红色报错那一行", imageId: "img_2" }
```

- `imageId` 省略则用最近一张。图片 id 由天枢寄存时分配（`img_1`、`img_2`…），会出现在提示文本里。
- 寄存范围包括**你附的图**和 **agent 自己截的图**（`browser_debug` / `computer_use` 的截图），所以「截图 → 追问细节」是完整闭环。
- 主控多模态时直接把原图递回给主控看；text-only 时用你的问题定向问识图桥。
- 同一张图同一个问法重复问命中描述缓存，零额外调用。
- 寄存是**纯内存**的：不进对话历史、不落盘，按会话 LRU 上限（8 张 / 24MiB）淘汰。

### 描述提示词会自动分档

没显式配 `prompt` 时，天枢按随图文本挑模式：文本里出现报错、终端、代码、日志一类关键词 → **OCR 级逐字转写**（截图里关键常常就一行报错，泛泛描述会把它丢掉）；否则用通用结构化描述（文字内容 / 界面元素 / 可能意图三段）。显式配了 `prompt` 就永远用你的。

### 桌面端

**Settings → 集成 → 识图模型**适合从已有 Provider 中选择视觉模型。Provider / 模型下拉只列**已配置且声明支持图片输入**的组合；留空 = **自动**——同 Provider 下有视觉档会自动启用（不显式钉桥），并非关闭桥接。同一张卡里还有**备用识图模型**（主桥 5xx/超时时切）和**跨 Provider 自动选桥**开关（同 Provider 已自动，此开关只管别家）。需要添加新 endpoint、发现模型并进行真实图片验证时，使用 TUI `/vision`。

卡片顶部那一行是**当前会话的真实桥状态**（读 `GET /sessions/:id/vision-bridge`），不是"配置里有没有这个键"：显示「主控模型原生支持识图」/「同 Provider 视觉模型已自动启用」/「识图桥已生效（跨 Provider）」/「图片不会被看到（附原因）」。桥是建会话首轮才装配的运行时事实——没有打开会话时它会明说状态未知，而不是拿配置冒充运行时事实。

附图时如果这个会话的图片**不会被看到**，Composer 会在缩略图下方直接警告并给一个「去配置识图模型」按钮——不再默默收下一张没人看的图；欢迎页（建会话前）桥状态未装配，用主模型视觉能力 + 同 provider 视觉档 + 桥配置做近似判定，四项都指向「看不到」才警告。桥状态未知时不警告（假警告只会训练你忽略所有警告）。

### TUI

`/config` 打开设置面板 → 左栏选**识图模型** → `Enter` 选模型 → `S` 保存。这个面板适合从**已配置且声明 `supportsVision`** 的 provider/模型组合中选择；选第一项「（关闭）」清除显式配置——注意这不等于彻底没桥：同 provider 下有视觉档时自动桥仍会启用（要完全不带桥，得让该 provider 没有可用视觉档）。`prompt`、`maxTokens`、以及「跨 Provider 自动选桥」开关都在同一分类里改。要添加新的视觉 endpoint 并验证图片，请使用独立的 `/vision` 流程。面板写的是用户级 `~/.rivet/config.json`，**下次会话生效**（会话模型在首个请求前就钉住了，中途换会碎前缀缓存）。

`/settings`、`/setup` 是同一面板的别名。

### 手改配置文件

`~/.rivet/config.json`（全局）或项目根的 `.rivet-config.json`（只作用于本项目，优先级更高）。字段名两处相同。注意面板只写用户级——项目级文件里的同名字段优先级更高，会盖掉面板里看到的值。

## 图片从哪来

**用户附图**：TUI 里粘贴图片的**文件路径**（终端只能粘贴文本），或直接 `Ctrl+V` 读系统剪贴板里的图；桌面端用 Composer 的附件按钮或直接拖入。每条消息最多 4 张，单张解码后 10MB（TUI / 桌面端统一口径），超了会按长边 1568px 自动缩。

**agent 自己截的**：`browser_debug screenshot`（`frontend` / `full` preset）和 `computer_use screenshot`（`full` preset）。单张 PNG 超 3.5MB 不附图，只留文字说明——这时缩小视口重截，或用 `eval` 量 DOM。

`browser_debug` 需要 chromium（约 150MB，不随包分发）。两条入口都能装，各自独立可用：

- **CLI**：`rivet browser status` 查状态、`rivet browser install` 一键装（自动带国内镜像，`--no-mirror` 走官方源）。含 `browser_debug` 的 preset 下启动还会自动体检，缺失时在首屏给出安装入口。
- **桌面端**：Settings → 集成 → **浏览器（截图）**——就绪状态、一键安装（镜像 / 官方源两个按钮）、实时安装日志都在这张卡里。只装桌面端的用户不需要终端。

`playwright-core` 模块本身缺失时（打包残缺）两边都不会给安装按钮：那不是"浏览器没下载"，装浏览器解决不了。

每轮工具批次最多带**最近 2 张**截图进上下文：一批里连拍多张时，不让百万像素的 base64 灌满窗口。

## 成本与缓存

图片走对话**尾部追加**，不重写历史，所以不打断前缀缓存。

token 按分辨率估算（OpenAI 分块规则，实现在 `src/context/image-tokens.ts`），别按"每张固定"心算：

| 尺寸 | 估算 token |
|------|-----------|
| 1024×1024 | 765 |
| 1280×800（默认视口） | 1105 |
| 1280×4000（整页长图） | 1445 |

桥接路径下主历史里只留一份文字描述，识图模型自身的调用成本单独记在侧路（会话目录的 `cache-log.jsonl`）。

## 排查

桥配了却不生效时，先看 sidecar / 终端日志里的这一行，它会点名原因：

```
[vision] 识图桥未启用：<原因>（图片仍会被丢弃）
```

常见原因与对策：

| 原因 | 对策 |
|------|------|
| provider 不在已配置列表里 | 新 endpoint 推荐使用 `/vision` 发现并验证；已有普通 Provider 则用 `/connect`、`rivet config setup <provider>` 或桌面端 Settings → Providers 添加 |
| 模型不在该 provider 的 `models` 里 | 补一条 model，或换成上表里的模型 |
| 该模型没声明 `supportsVision` | 自定义模型手写 `"supportsVision": true` |
| **没有可用的 key** | 最常见：key 只存在环境变量里，而 GUI / Dock 启动的桌面端没继承到 shell profile。把 key 写进配置，或从终端启动。（`config.env` 那套只作用于命令执行，不改进程自身环境） |

桌面端**不用**去翻日志：识图卡顶部那一行就是同一份 `detail`（无活会话时会明说未知）。

**两端分开部署时配置互不打扰**：`agent.visionModel.fallback` 现在是"省略即保留"——桌面端保存主识图模型不会抹掉你手写的备用桥，TUI 面板也一样；要清掉备用桥就在界面里选「不设备用」（走显式清除）。旧行为是整体替换，任何不带该字段的写入都会吞掉它。

**如果某个内置模型的 `supportsVision` 看起来"丢了"**：旧版本在 UI 里编辑上下文窗口会连带抹掉这个字段。2026-07-29 起写入改为逐字段合并，且加载时会按预设补回缺失的 `supportsVision` / `tier` / `pricing`，不需要手动修配置文件。详见 [`docs/changelog/2026-07-29-vision-channel-honesty-and-test-entry-hardening.md`](changelog/2026-07-29-vision-channel-honesty-and-test-entry-hardening.md)。

## 相关文档

- [Provider 配置用户手册](user-guide-provider-config.md)
- [前端视觉验证闭环](changelog/2026-07-26-frontend-visual-verification-loop.md)（`browser_debug` 的截图 → 验证链路）

/**
 * 主题调色板定义层（语义 token → 具体颜色值）。
 *
 * 每套主题两轨：
 * - `truecolor`: hex 值，level >= 2 时使用（level 2 由 ansi.ts fg() 现场量化为 xterm-256）
 * - `fallback`: chalk 命名色，level <= 1 时使用（由 fg() 映射为基础 16 色 SGR）
 *
 * 元数据：
 * - `background`: 面向暗色还是亮色终端背景 —— auto 主题检测后按此挑选
 * - `description`: /theme picker 的单一事实来源（此前散落在 main.ts）
 *
 * 消费方通过 theme.ts 的 buildTheme/THEMES 获得 RivetTheme，不直接 import 本文件。
 */

/** 语义 token 集。值是 hex（truecolor 轨）或 chalk 命名色（fallback 轨）。 */
export interface ColorSet {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  pulseQuiet: string
  pulseActive: string
  pulseAlert: string
  /** bash/grep/glob 工具色，默认回退到 primary */
  toolShell?: string
  /** edit_file/write_file 工具色，默认回退到 secondary */
  toolEdit?: string
  /** run_tests 工具色，默认回退到 success */
  toolTest?: string
  /** delegate_task/delegate_batch 工具色，默认回退到 warning */
  toolDelegate?: string
}

/** buildTheme 的 overrides 形参（userColor 等非 ColorSet token）。 */
export interface ThemeOverrides {
  userColor?: string
  assistantColor?: string
  muted?: string
  systemColor?: string
  /** 正文行内代码色。缺省 = secondary——但 secondary 若在正文里大面积出现
   *  （cyberpunk 的品红粉就是），整屏会被染色，此时在此单独指定。 */
  inlineCode?: string
  /** 品牌词专用色（「天枢」字样、品牌星 ✦）。缺省 = primary。
   *  独立于 userColor：品牌色跟品牌走，不随「用户消息」语义色漂移。 */
  brandColor?: string
}

export interface ThemePaletteDef {
  truecolor: ColorSet
  fallback: ColorSet
  /** truecolor 轨的 overrides */
  overrides?: ThemeOverrides
  /** fallback 轨的 overrides */
  fallbackOverrides?: ThemeOverrides
  /** 面向的终端背景。auto 检测后按此选择默认主题。 */
  background: 'dark' | 'light'
  /** /theme picker 描述文案。 */
  description: string
  /** 语气档(2026-09,主题风格化):消费方(greeting 问候池 / guide 首启文案)
   *  统一读 theme.voice,缺省 = 'default' 中性。新主题标 voice 即全套生效。 */
  voice?: ThemeVoice
}

/** 语气档:default(中性)/ playful(粉彩活泼·星灵人设)/ tech(科技冷静·Nova 人设)。
 *  与 api/greeting.ts 的 GreetingVoice 同构(结构化兼容,无需转换)。 */
export type ThemeVoice = 'default' | 'playful' | 'tech'

// ── Pastel — soft, pleasant, 二次元-inspired ──────────────────────
// 2026-09 去紫重调(用户实锤:薰衣草紫 secondary + 正文随紫,整屏发紫怪)。
// secondary 薰衣草 #d4a5f5 → 樱花粉 #ffa8b5(R>B 非紫族);error 珊瑚
// #ff9aa2 → 草莓红 #ff6b81(与樱花粉拉开饱和/亮度,警示仍可辨);
// assistantColor 显式暖纸白——正文不再跟随 secondary。
const PASTEL: ThemePaletteDef = {
  background: 'dark',
  description: '二次元粉彩。薄荷 × 樱花粉——小天和你的糖果色终端。',
  voice: 'playful',
  truecolor: {
    primary: '#a8e6cf',   // mint green — search/grep/glob
    secondary: '#ffa8b5', // 樱花粉 — edit/write(原薰衣草紫,去紫)
    success: '#d0f0a8',   // 粉彩青柠 — 原为 #b5ead7，与 mint 主色同色相 158° 不可分（cr 1.06）
    warning: '#ffe0a3',   // 粉彩琥珀 — 原为 #ffdac1 蜜桃，与 error 珊瑚粉色相距仅 29°
    error: '#ff6b81',     // 草莓红 — 原珊瑚粉 #ff9aa2 与樱花粉 secondary 撞粉族,加深拉开
    dim: '#8585a0',       // soft gray — secondary info
    pulseQuiet: '#4a4a5a',
    pulseActive: '#a8e6cf',
    pulseAlert: '#ff6b81',
  },
  overrides: {
    assistantColor: '#f2e9e0', // 暖纸白正文(原随 secondary 变紫,去紫核心)
  },
  fallback: {
    primary: 'cyan', secondary: 'magenta', success: 'green', warning: 'yellow',
    error: 'red', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'cyan', pulseAlert: 'red',
  },
  fallbackOverrides: { assistantColor: 'white' },
}

// ── Cyberpunk — neon tech-noir, tuned for legibility on near-black ──
// Original maxed-out neons had two defects on dark terminals: electric purple
// failed WCAG AA and vibrated against black; primary cyan-green collided with
// success green. Fixed per dark-mode color rules (raise lightness, ease
// saturation, split the greens, lift purple to lavender, rose over pure red).
// 2026-09 去紫重调(用户实锤:薰衣草紫 secondary 整屏发紫怪):secondary
// lavender #c4a3ff → 霓虹品红粉 #ff5c8a;assistantColor 显式冷白。
// 2026-09 正文去红:markdown.ts 的行内代码改取 inlineCode(见 overrides),不再
// 直接吃 secondary——正文里文件名/函数名/命令出现频率极高,染成品红粉即整屏
// 发红。secondary 保留赛博粉红(工具卡/扫光尾/side-panel 标题等点缀位),
// inlineCode 单独取冰蓝 #7aa2f7(H221,离粉红 122°、离 primary 青 30°)。
const CYBERPUNK: ThemePaletteDef = {
  background: 'dark',
  description: '赛博朋克·霓虹夜城。电青 × 品红粉 synthwave——Nova 的终端夜之城。',
  voice: 'tech',
  truecolor: {
    primary: '#48c6e2',   // cyan-400 — desaturated cyan to avoid rgb halation
    secondary: '#ff5c8a', // 霓虹品红粉 — 工具卡/扫光尾/面板标题等点缀位
    success: '#4ade80',   // green-400
    warning: '#fbbf24',   // amber-400
    error: '#e27585',     // rose-400 — softened rose red
    dim: '#9494b8',
    pulseQuiet: '#2f3048',
    pulseActive: '#48c6e2',
    pulseAlert: '#e27585',
  },
  overrides: {
    assistantColor: '#e8eef6', // 冷白正文(原随 secondary 变紫,去紫核心)
    inlineCode: '#7aa2f7',     // 正文行内代码专用冰蓝——大面积出现,不吃粉红
  },
  fallback: {
    primary: 'cyan', secondary: 'magenta', success: 'green', warning: 'yellow',
    error: 'red', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'cyan', pulseAlert: 'red',
  },
  fallbackOverrides: { assistantColor: 'white', inlineCode: 'blue' },
}

// ── Observatory — 五色星辰（中国传统五色体系）──────────────────────
const OBSERVATORY: ThemePaletteDef = {
  background: 'dark',
  description: '五色星辰。传统五行配色体系，天玑星君玄灰底色。',
  truecolor: {
    primary: '#7c78f2',   // 靛蓝 — 天玑星君主色（原 #4f46e5 暗底仅 3.0:1，提亮至 ≥4.5:1）
    secondary: '#a78bfa', // 星云紫
    success: '#34d399',   // 验证翠
    warning: '#f59e0b',   // 星金黄
    error: '#f87171',     // 警报珊
    dim: '#8da0b8',       // 远星灰（深底 ≥4.5:1 提亮档）
    pulseQuiet: '#334155',
    pulseActive: '#7c78f2', // = primary（原 sky #38bdf8 出族；全仓惯例 pulseActive=primary）
    pulseAlert: '#f87171',
  },
  fallback: {
    primary: 'blue', secondary: 'magenta', success: 'green', warning: 'yellow',
    error: 'red', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'cyan', pulseAlert: 'red',
  },
}

// ── Midnight — GitHub Dark inspired ───────────────────────────────
const MIDNIGHT: ThemePaletteDef = {
  background: 'dark',
  description: 'GitHub 暗黑风格。极简中性灰度，高度清晰。',
  truecolor: {
    primary: '#58a6ff',   // accent blue
    secondary: '#b0b8c4', // medium gray
    success: '#3fb950',
    warning: '#d29922',
    error: '#f85149',
    dim: '#8b949e',
    pulseQuiet: '#3d4450',
    pulseActive: '#58a6ff',
    pulseAlert: '#f85149',
  },
  overrides: { userColor: '#e6edf3', assistantColor: '#e6edf3' },
  fallback: {
    primary: 'blue', secondary: 'white', success: 'green', warning: 'yellow',
    error: 'red', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'blue', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'white', assistantColor: 'white' },
}

// ── Starfield — 星空/星座（Rivet 星图美学）─────────────────────────
const STARFIELD: ThemePaletteDef = {
  background: 'dark',
  description: '星空星座。Rivet 原生星图美学，天蓝主星与星云紫辅色。',
  truecolor: {
    primary: '#8ab4ff',   // hot blue-white star (Vega/Rigel)
    secondary: '#c9a9ff', // nebula violet
    success: '#7ee7c7',   // aurora teal-green
    warning: '#ffd479',   // stellar gold
    error: '#ff8a9b',     // nova flare
    dim: '#959dbe',       // cosmic dust lane（提亮档）
    pulseQuiet: '#2b3052',
    pulseActive: '#8ab4ff',
    pulseAlert: '#ff8a9b',
  },
  overrides: { userColor: '#e8ecf8', assistantColor: '#c9a9ff', muted: '#aab4d4' },
  fallback: {
    primary: 'blue', secondary: 'magenta', success: 'cyan', warning: 'yellow',
    error: 'red', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'blue', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'white', assistantColor: 'magenta' },
}

// ── Tianshu — 玄夜墨色（95% 墨灰 + 星金 accent + 朱砂用户印）────────
const TIANSHU: ThemePaletteDef = {
  background: 'dark',
  description: '玄夜墨色。95% 墨灰，配以星金主色与朱砂用户印，沉稳低调。',
  truecolor: {
    primary: '#dfb282',   // 星金 accent
    secondary: '#a49ac7', // 墨紫灰
    success: '#75a399',   // 归航青
    warning: '#d1914a',   // 琥珀橙金 — 原 #c7a767 与 primary 星金 cr 仅 1.18 撞簇；橙化拉开
    error: '#bd5f7a',     // 茜草玫瑰 — 原朱砂赤 #c1655c 与用户朱砂印 #d86459 同色相 5°
                          // 不可分；玫瑰化把唯一的「红」还给用户印（暗底 4.6:1）
    dim: '#8a8fa0',       // 暗墨（深底 ≥4.5:1 提亮档）
    pulseQuiet: '#3a3d4a',
    pulseActive: '#dfb282',
    pulseAlert: '#d86459', // 朱砂印 (柔化提亮朱砂红，降低暗底光晕与眼睛干涩度)
    toolShell: '#a0a3b0',
    toolEdit: '#a49ac7',
    // toolTest/toolDelegate 不覆盖：回退 success/warning 全局惯例——原 toolTest #9c8a63
    // 卡其落在金簇里与 delegate/warning 不可分。
  },
  // userColor = 朱砂印 (the one warm point); assistantColor = 亮中性正文;
  // muted/systemColor = 元信息灰对齐。
  overrides: { userColor: '#d86459', assistantColor: '#d2d5dd', muted: '#adb2bf', systemColor: '#adb2bf' },
  fallback: {
    primary: 'yellowBright', secondary: 'magenta', success: 'cyan', warning: 'yellow',
    // error redBright 与 userColor red 分档——同 truecolor 轨朱砂印/茜草玫瑰的分离
    error: 'redBright', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'yellowBright', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'red', assistantColor: 'white' },
}

// ── Ziwei — 紫微北斗·墨夜 ──────────────────────────────────────────
const ZIWEI: ThemePaletteDef = {
  background: 'dark',
  description: '帝星紫微。朱砂红标记点缀帝星紫，富含中国星图古典美学韵味。',
  truecolor: {
    primary: '#c9b8ff',     // 紫微 — 帝星紫
    secondary: '#8ab4ff',   // 天枢蓝白
    success: '#7ee7c7',     // 归航青
    warning: '#ffd479',     // 星金
    error: '#ff8a9b',       // 荧惑赤
    dim: '#868ba8',         // 星尘灰（提亮档）
    pulseQuiet: '#3a3d4a',
    pulseActive: '#c9b8ff',
    pulseAlert: '#d4453a',  // 朱砂印
    toolShell: '#8ab4ff',
    toolEdit: '#c9b8ff',
    toolTest: '#7ee7c7',
    toolDelegate: '#ffd479',
  },
  overrides: { userColor: '#d4453a', assistantColor: '#c9b8ff', muted: '#9aa2b1' },
  fallback: {
    primary: 'magenta', secondary: 'blue', success: 'cyan', warning: 'yellow',
    // error redBright 更贴近荧惑赤 #ff8a9b 的亮粉，并与 userColor red（朱砂印）分档
    error: 'redBright', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'magenta', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'red', assistantColor: 'magenta', muted: 'white' },
}

// ── Claude — Claude Code TUI palette port（RGB 逐值移植）───────────
const CLAUDE: ThemePaletteDef = {
  background: 'dark',
  description: 'Claude Code 官方 TUI 经典调色盘移植。橘黄经典。',
  truecolor: {
    primary: '#d77757',   // brand orange rgb(215,119,87)
    secondary: '#af87ff', // autoAccept violet
    success: '#4eba65',
    warning: '#ffc107',
    error: '#ff6b80',
    dim: '#767676',       // subtle（深底 ≥4.5:1 提亮档）
    pulseQuiet: '#888888', // promptBorder
    pulseActive: '#d77757',
    pulseAlert: '#ff6b80',
  },
  // assistant body is neutral gray-white upstream (violet is a badge only)
  overrides: { userColor: '#d77757', assistantColor: '#d9d9d9', muted: '#999999' },
  fallback: {
    primary: 'redBright', secondary: 'magentaBright', success: 'greenBright',
    warning: 'yellowBright', error: 'redBright', dim: 'white',
    pulseQuiet: 'white', pulseActive: 'redBright', pulseAlert: 'redBright',
  },
  fallbackOverrides: { userColor: 'redBright', assistantColor: 'white' },
}

// ── Slate — 冷静板岩（专业/不疲劳）────────────────────────────────
const SLATE: ThemePaletteDef = {
  background: 'dark',
  description: '冷静板岩灰。单一冷静 Teal 主色，无彩色结构，低眩光长久不累。',
  truecolor: {
    primary: '#56b6c2',   // teal-cyan — 唯一 accent
    secondary: '#7aa2cf', // 钢蓝
    success: '#7fb88a',   // 鼠尾草绿
    warning: '#d6a35c',   // 暗琥珀
    error: '#e08891',     // 柔玫瑰
    dim: '#848d9c',       // 板岩灰（提亮档）
    pulseQuiet: '#39414f',
    pulseActive: '#56b6c2',
    pulseAlert: '#e08891',
    toolShell: '#7aa2cf',
    toolEdit: '#6fb3ab',
    toolTest: '#7fb88a',
    toolDelegate: '#d6a35c',
  },
  overrides: { userColor: '#e2e6ec', assistantColor: '#c4c9d2', muted: '#8b93a3' },
  fallback: {
    primary: 'cyan', secondary: 'blue', success: 'green', warning: 'yellow',
    error: 'red', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'cyan', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'white', assistantColor: 'white', muted: 'gray' },
}

// ── Dawn — 启明星（晨星青与地平金）─────────────────────────────────
const DAWN: ThemePaletteDef = {
  background: 'dark',
  description: '启明星晨曦调。青蓝边框、暖金标题、雾灰正文，贴近 Tianshu 启动画面。',
  truecolor: {
    primary: '#58d6f5',   // 启明星青蓝：边框 / 图腾 / 重点线
    secondary: '#d8a15c', // 地平金：标题
    success: '#7bbf98',   // 柔和晨曦绿
    warning: '#e5763a',   // 橘橙 — 原与 secondary 同值 #d8a15c（四 token 撞金），橘化分离
    error: '#e58e98',
    dim: '#8f9aaa',       // 雾灰：副标题 / 标签 / 辅助信息
    pulseQuiet: '#2b3340',
    pulseActive: '#58d6f5',
    pulseAlert: '#e58e98',
    // toolX 不覆盖：回退全局默认映射（shell=primary 青 / edit=secondary 金 /
    // test=success 绿 / delegate=warning 橙）——原四处覆盖把 shell/edit/delegate
    // 全锁进同一个金 #d8a15c，工具族色编码整个塌掉。
  },
  overrides: {
    userColor: '#ffb454', // 亮琥珀 — 原 #f59e0b 与标题金 cr 仅 1.07，提亮拉开
    assistantColor: '#dce3ea',
    muted: '#8f9aaa',
    systemColor: '#8f9aaa',
  },
  fallback: {
    primary: 'cyan',
    secondary: 'yellow',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    dim: 'gray',
    pulseQuiet: 'gray',
    pulseActive: 'cyan',
    pulseAlert: 'red',
  },
  fallbackOverrides: {
    userColor: 'yellowBright',
    assistantColor: 'white',
    muted: 'gray',
  },
}

// ── Antigravity 2.0 — Codex cool azure（对齐桌面端 tokens.css）─────
const ANTIGRAVITY: ThemePaletteDef = {
  background: 'dark',
  description: 'Codex 风格。天青色冷调 Accent，亮灰结构文本，现代而克制。',
  voice: 'tech',
  truecolor: {
    primary: '#5aa9ff',   // cool azure (desktop --accent)
    secondary: '#8ab4ff', // 浅天青
    success: '#43c463',   // desktop --success
    warning: '#e0a93a',   // desktop --warning
    error: '#f76b6b',     // desktop --error
    dim: '#9093a0',       // desktop --faint（提亮档）
    pulseQuiet: '#2a2a32', // desktop --border
    pulseActive: '#5aa9ff',
    pulseAlert: '#f76b6b',
    toolShell: '#7aa2cf',
    toolEdit: '#6fb3ab',
    toolTest: '#43c463',
    toolDelegate: '#e0a93a',
  },
  overrides: { userColor: '#d8e2ee', assistantColor: '#c4c9d2', muted: '#989aa6' }, // userColor 冷调近白——原天青 #38bdf8 与 primary cr 仅 1.15，发言冒充 accent
  fallback: {
    primary: 'blue', secondary: 'cyan', success: 'green', warning: 'yellow',
    error: 'red', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'blue', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'cyanBright', assistantColor: 'white', muted: 'gray' },
}

// ── Cobalt — 钴蓝·冷调中性（默认）──────────────────────────────────
// oklch 调和：中性灰阶统一色相 ~250°，状态色拽进与 azure 同一和谐色环。
// antigravity 的精炼继任者：同源冷 azure，语义色去糖果化、明度梯度更清晰。
const COBALT: ThemePaletteDef = {
  background: 'dark',
  description: '钴蓝·冷调中性 (默认风格)。oklch 调和，明度梯度清晰，视觉极度舒适。',
  truecolor: {
    primary: '#6ab8ff',   // 钴蓝 accent (--tui-accent)
    secondary: '#7dacbf', // 雾青灰
    success: '#58cbb4',   // 青绿 (--tui-ok)
    warning: '#d4b44c',   // 琥珀金
    error: '#ed7665',     // 珊瑚砖红 (--tui-err)
    dim: '#8693a0',       // 冷板岩灰
    pulseQuiet: '#30363d', // (--tui-border)
    pulseActive: '#6ab8ff',
    pulseAlert: '#ed7665',
    toolShell: '#5f97c5',
    toolEdit: '#65b9ca',
    toolTest: '#58cbb4',
    toolDelegate: '#d4b44c',
  },
  overrides: {
    userColor: '#fbbf24',
    assistantColor: '#c9cfd6',
    muted: '#9ca5b3',
    // 2026-09 inlineCode 独立(同 cyberpunk 模式):正文行内代码(文件名/命令/函数名
    // 高频出现)原吃 secondary 雾青灰,灰扑扑;取柔亮天青 #8ecae6(H195 S63 L74)——
    // L 高 S 中,守 cobalt「明度梯度清晰、视觉舒适」哲学,不引入高饱和艳色。
    inlineCode: '#8ecae6',
  },
  fallback: {
    primary: 'blue', secondary: 'cyan', success: 'green', warning: 'yellow',
    error: 'red', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'blue', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'yellowBright', assistantColor: 'white', muted: 'gray', inlineCode: 'cyanBright' },
}

// ── Graphite — 石墨·冰青（专业默认）─────────────────────────────────
// Apple 式专业终端美学：中性石墨灰阶承载内容，单一冰青 accent 只落在品牌星、
// 光标与关键动作上；语义色统一降饱和防 Neon 疲劳。层级靠字重与明度梯度，
// 不靠颜色数量——为长时间编码的低视觉疲劳而调。
const GRAPHITE: ThemePaletteDef = {
  background: 'dark',
  description: '石墨冰青 (专业默认)。中性灰阶 + 单一冰青 accent，低饱和语义色，长时间编码不疲劳。',
  truecolor: {
    primary: '#7cc4e8',   // 冰青 accent — 品牌星 / 光标 / 关键动作
    secondary: '#8b98ab', // 钢灰蓝 — 次级结构
    success: '#7fbf8e',   // 鼠尾草绿
    warning: '#d9b36c',   // 哑琥珀
    error: '#e07a6f',     // 软珊瑚红（非纯红防光晕）
    dim: '#828d9c',       // 结构灰（提亮档 >4.6:1 WCAG AA）
    pulseQuiet: '#2f3540',
    pulseActive: '#7cc4e8',
    pulseAlert: '#e07a6f',
    toolShell: '#7ba7c9',
    toolEdit: '#8b98ab',
    toolTest: '#7fbf8e',
    toolDelegate: '#d9b36c',
  },
  // userColor 暖金琥珀 / assistantColor 中性灰：靠 ▌贯穿导轨 + 专属亮彩与灰度区分说话人
  overrides: { userColor: '#e0aa53', assistantColor: '#c8cdd6', muted: '#9aa4b0', systemColor: '#8b95a1' },
  fallback: {
    primary: 'cyan', secondary: 'blue', success: 'green', warning: 'yellow',
    error: 'red', dim: 'gray', pulseQuiet: 'gray', pulseActive: 'cyan', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'yellowBright', assistantColor: 'white', muted: 'gray' },
}

// ── Gemini — Indigo, Purple & Mint Teal ───────────────────────────
const GEMINI: ThemePaletteDef = {
  background: 'dark',
  description: 'Gemini 风格。结合星云微光渐变 (冷靛蓝与星云紫) 与极光薄荷，极具科技美感。',
  voice: 'tech',
  truecolor: {
    primary: '#818cf8',      // Gemini Indigo
    secondary: '#c084fc',    // Nebula Violet
    success: '#34d399',      // Aurora Mint
    warning: '#fbbf24',      // Stellar Amber
    error: '#f43f5e',        // Cosmic Rose
    dim: '#8b8ea9',          // Nebula Gray（提亮档）
    pulseQuiet: '#2a2b3d',
    pulseActive: '#818cf8',
    pulseAlert: '#f43f5e',
    toolShell: '#7dd3fc',
    toolEdit: '#c084fc',
    toolTest: '#34d399',
    toolDelegate: '#fbbf24',
  },
  overrides: { userColor: '#e0e7ff', assistantColor: '#c4c9d2', muted: '#9497a6' },
  fallback: {
    primary: 'blueBright', secondary: 'magentaBright', success: 'cyanBright',
    warning: 'yellowBright', error: 'redBright', dim: 'gray',
    pulseQuiet: 'gray', pulseActive: 'blueBright', pulseAlert: 'redBright',
  },
  fallbackOverrides: { userColor: 'white', assistantColor: 'white', muted: 'gray' },
}

// ── Paper — 亮色默认（白/浅灰终端背景）─────────────────────────────
// 亮背景配色纪律与暗色相反：全部加深降亮。语义色取 600-700 档（深到能在
// 白底上站住），dim/muted 用中深灰（亮背景下浅灰不可读——这是暗色主题
// 直接套用会翻车的第一现场）。accent 靛蓝与 cobalt 的钴蓝同族，跨主题
// 切换视觉记忆连续。
const PAPER: ThemePaletteDef = {
  background: 'light',
  description: '纸白亮色。面向白底/浅色终端，全语义色加深降亮，靛蓝 accent。',
  truecolor: {
    primary: '#1d4ed8',   // 深靛蓝 accent — 白底 7.5:1
    secondary: '#0e7490', // 深青 — 结构头
    success: '#15803d',   // 深绿
    warning: '#a16207',   // 深琥珀（亮背景下黄色系必须压到 700 档才可读）
    error: '#b91c1c',     // 深红
    dim: '#6b7280',       // 中灰 — 分隔/快捷键（白底 4.6:1）
    pulseQuiet: '#d1d5db', // 浅边框灰 — quiet pulse
    pulseActive: '#1d4ed8',
    pulseAlert: '#b91c1c',
    toolShell: '#1e6091',  // 深钢蓝
    toolEdit: '#0e7490',   // 深青
    toolTest: '#15803d',   // 深绿
    toolDelegate: '#a16207',
  },
  // userColor/assistantColor 深灰近黑正文；muted 中深灰。
  overrides: { userColor: '#1f2937', assistantColor: '#374151', muted: '#4b5563', systemColor: '#4b5563' },
  fallback: {
    // 亮背景 16 色：避开 white/gray（白底不可见），用暗色系命名色。
    primary: 'blue', secondary: 'cyan', success: 'green', warning: 'yellow',
    error: 'red', dim: 'black', pulseQuiet: 'black', pulseActive: 'blue', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'black', assistantColor: 'black', muted: 'black' },
}

// ── Light-ANSI — 亮色 16 色纯净版 ──────────────────────────────────
// 不带 truecolor 私货：truecolor 轨直接复用终端 ANSI 语义近似值（深色系），
// 主要价值在 fallback 轨——让用户在任何亮背景终端用终端自己的 palette。
const LIGHT_ANSI: ThemePaletteDef = {
  background: 'light',
  description: '亮色 ANSI。16 色纯净版，跟随终端自身配色方案，亮背景友好。',
  truecolor: {
    primary: '#0550ae',
    secondary: '#8250df', // 亮色系紫 — 原 #116329 与 success 同值，edit 工具冒充测试通过
    success: '#116329',
    warning: '#7d4e00',
    error: '#a40e26',
    dim: '#57606a',
    pulseQuiet: '#d0d7de',
    pulseActive: '#0550ae',
    pulseAlert: '#a40e26',
  },
  overrides: { userColor: '#24292f', assistantColor: '#24292f', muted: '#57606a', systemColor: '#57606a' },
  fallback: {
    primary: 'blue', secondary: 'magenta', success: 'green', warning: 'yellow',
    error: 'red', dim: 'black', pulseQuiet: 'black', pulseActive: 'blue', pulseAlert: 'red',
  },
  fallbackOverrides: { userColor: 'black', assistantColor: 'black', muted: 'black' },
}

export const THEME_PALETTES = {
  pastel: PASTEL,
  cyberpunk: CYBERPUNK,
  observatory: OBSERVATORY,
  midnight: MIDNIGHT,
  starfield: STARFIELD,
  tianshu: TIANSHU,
  claude: CLAUDE,
  ziwei: ZIWEI,
  slate: SLATE,
  dawn: DAWN,
  antigravity: ANTIGRAVITY,
  cobalt: COBALT,
  graphite: GRAPHITE,
  gemini: GEMINI,
  paper: PAPER,
  'light-ansi': LIGHT_ANSI,
} as const

export type ThemeName = keyof typeof THEME_PALETTES

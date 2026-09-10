/**
 * R7 定稿渲染器 —「定盘星」:输入框上方 = 身份块 + 进入提示区。
 *
 * 设计规格:.rivet/plans/欢迎页重设计-v2-定盘星-对标gemini-codex-claude.md(R7)。
 * 范围边界(R7 拍板):本渲染器只产出输入框上方内容;输入框以下(状态栏/活信息)
 * 归 app.ts 既有底部 chrome,本文件零涉及。
 *
 * 全妆形态(fresh,cols≥44,rows≥阈值;shadow 58 列 6 行字标 → 14 行,pixel 41 列 5 行 → 12 行):
 *   ''
 *   ##### ##### .###. #...# .#### #...# #...#
 *   ..#.. ..#.. #...# ##..# #.... #...# #...#  ✦ 天枢 · v3.6.0
 *   ..#.. ..#.. ##### #.#.# .###. ##### #...#
 *   ..#.. ..#.. #...# #..## ....# #...# #...#
 *   ..#.. ..#.. #...# #...# ####. #...# .###.
 *      把星辰带给每一位开发者 · Models as partners, not tools.  ← 使命行
 *   ────────────────────────✦─────────────────────────    ← 基准线(唯一全幅元素)
 *   ''
 *   ✧ /domain 查看星域描述与切换 · 不同星域工程能力不同
 *   ✧ /team /scout 协同——并行施工 · 只读侦察
 *   ⏜ /handoff 满60%交接新会话 · 中途切 /model /domain 碎缓存   ← P2 收拢:handoff 与缓存提示合并
 *   ''
 *   guide(首启引导版,P1-1):上块替换为 一句话定位 + 示例×3 + 操作提示(共 5 行,总 16 行);
 *   问候语(settle,main.ts)经 commitStatic 追加在欢迎页块正下方,不进本渲染器。
 *
 * compact(恢复会话 / cols<44 / rows<17)单行:
 *   ✦ 天枢 · model ◎eff · ~/dir · ↑续N轮(#id) · v3.6.0
 *
 * 设计纪律:
 * - **内容栏**:除基准线外,右端预算以 bodyW = min(cols,72) 为界,宽终端多出的列全是留白;
 * - **单一 accent**:chroma 只在 brandColor(品牌星/词标/「/handoff」)与 effort 徽章;
 * - **字形宽度**:✦ ✧ ⏜ ∙ 均为 Ambiguous 安全档(各终端恒 1 列);全部产出行按
 *   ambiguous=2 的上界兜底截断,CJK 终端绝不折行;
 * - **星域个性**:基准线横线取 separator 档(thin─/thick━/dots┄),与输入框线框同源;
 * - **整行省略**:使命行装不下整行消失,绝不腰斩 slogan;
 * - **渐变**:「天枢」在 brandColor 为 hex 时做同色相微渐变(首字向白混 45%),非彩虹;
 *   fallback 轨命名色自动回退纯色 bold。
 */

import { homedir } from 'node:os'
import { color } from '../engine/ansi.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { boxCharsFor } from '../box-chars.js'
import { useAsciiBorders } from '../term-caps.js'
import type { RivetTheme, ThemeVoice } from '../theme.js'

export interface FormatWelcomeInput {
  modelName: string
  cwd: string
  sessionId: string
  priorMsgCount: number
  columns: number
  /** Ephemeral per-session numeric id (e.g. 7281)。compact 行优先展示。 */
  numericId?: number
  /** 折叠为单行极简版(用于非首次启动/恢复会话)。 */
  compact?: boolean
  /** 终端可视高度(行)。低于 FULL_MIN_ROWS 降级 compact。 */
  rows?: number
  /** 版本号(安装根 package.json),无则不显示。 */
  version?: string | null
  /** 权限模式(compact 行不再展示,保留入参兼容)。 */
  approvalMode?: string
  /** 推理 effort 档位(compact 行徽章)。 */
  reasoningEffort?: string
  /** 星域线框风格(thin/thick/dots/kimi),基准线横线与其同源。 */
  separator?: string
  /** 字标风格:shadow=ANSI Shadow 立体字 RIVET(默认)/ pixel=点阵 TIANSHU。
   *  亦可经 RIVET_WELCOME_LOGO 环境变量切换。 */
  logoStyle?: string
  /** 首启引导版(P1-1):提示区替换为「一句话定位 + 可直接照抄的示例 + 基础操作」。
   *  仅全妆形态生效(窄/矮/compact 自然回落,不残留半套引导);由调用方按
   *  welcome-guide 哨兵判定传入。 */
  guide?: boolean
}

/** 全妆固定开销(呼吸空行×3 + 使命行 + 基准线 + 提醒行×3);总行数 = 此值 + 字标行数。 */
const FULL_FIXED_ROWS = 8
/** 输入框 + 底部 chrome 余量(与 app.ts 既有预留一致口径)。 */
const RESERVED_ROWS = 5
/** 身份块下限列数:低于此值单行更诚实。 */
const MIN_COLS = 44
/** 内容栏上限:除基准线外一切行右端预算(宽终端多出的列全是留白)。 */
const CONTENT_MAX = 72
/** 基准线亮星落点:全幅的 38%(构图黄金比左倾)。 */
const STAR_AT = 0.38
/** 字标与右侧品牌段「✦ 天枢 · vN」的间隔列数(R11:2 → 6,离太近)。 */
const TAG_GAP = 6

const WIDE = { ambiguousAsWide: true }

// ── 文案(定稿,见规格 §五)──────────────────────────────────────────
const MISSION_ZH = '把星辰带给每一位开发者'
const MISSION_EN = 'Models as partners, not tools.'
const HINT_DOMAIN_CMD = '/domain'
const HINT_DOMAIN_DESC = '查看星域描述与切换 · 不同星域工程能力不同'
const HINT_DOMAIN_SHORT = '星域描述与切换'
const HINT_HANDOFF = '满60%交接新会话'
const HINT_CACHE_A = '中途切'
const HINT_CACHE_CMDS = '/model /domain'
const HINT_CACHE_B = '碎缓存'
const HINT_COLLAB_CMDS = '/team /scout'
const HINT_COLLAB_DESC = '协同——并行施工 · 只读侦察'
const HINT_COLLAB_SHORT_CMDS = '/team /scout'
const HINT_COLLAB_SHORT_DESC = '协同多代理'
const WORDMARK_PINYIN = 'T I Ā N S H Ū'

// ── guide 首启引导版文案(P1-1,见设计文档 §P1-1)────────────────────
/** 一句话定位(full/short/tiny 三档,档位链降级——任一档都保留「直接说你要做什么」动词)。 */
const GUIDE_INTRO = '终端里的 AI 工程师 —— 直接说你要做什么，我来干活'
const GUIDE_INTRO_SHORT = '终端里的 AI 工程师 —— 直接说你要做什么'
const GUIDE_INTRO_TINY = '直接说你要做什么，我来干活'
/** 可直接照抄的示例输入(@ 文件引用是天枢核心能力,值得在首屏教学)。 */
const GUIDE_EXAMPLES = ['看看这个项目的结构', '帮我跑一下测试，把失败的修掉', '@src/main.ts 这段代码在做什么'] as const
/** 基础操作提示(full/short 两档)。/theme 提示放在此处——默认主题之外的换肤入口
 *  要能被首启用户看见。宽度实测：full 含前缀 58 列起、short 35 列起（比原 short
 *  的 36 列还短一格，故窄终端不会因此丢提示）。 */
const GUIDE_HINT = '直接开始 · Tab 补全路径 · / 浏览全部命令 · /theme 换肤'
const GUIDE_HINT_SHORT = '直接开始 · / 命令 · /theme 换肤'
/** guide intro 角色台词(2026-09,voice 角色化):playful=星灵小天 / tech=Nova 助手。
 *  与问候语语气池同源同 voice——主题风格化完整打包。缺省回落 GUIDE_INTRO 中性链。 */
const GUIDE_INTRO_VOICE: Partial<Record<ThemeVoice, string>> = {
  playful: '嗨！我是小天，你的终端星灵——想做什么直接说',
  tech: 'Nova 在线。目标已就绪——直接下达任务',
}

/** 5×5 点阵字模(TIANSHU / RIVET 通用字形库)。 */
const BLOCK_FONT: Record<string, string[]> = {
  T: ['#####', '..#..', '..#..', '..#..', '..#..'],
  I: ['#####', '..#..', '..#..', '..#..', '#####'],
  A: ['.###.', '#...#', '#####', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  S: ['.####', '#....', '.###.', '....#', '####.'],
  H: ['#...#', '#...#', '#####', '#...#', '#...#'],
  U: ['#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '####.', '#..#.', '#...#'],
  V: ['#...#', '#...#', '#...#', '.#.#.', '..#..'],
  E: ['#####', '#....', '####.', '#....', '#####'],
}

/** ANSI Shadow 立体字(TIANSHU 拼写):双线自带阴影的 3D 艺术字,58 列 × 6 行。
 *  字形来源:figlet「ANSI Shadow」字体(终端社区公共字形);宽栏专属。 */
const SHADOW_FONT: Record<string, string[]> = {
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  I: ['██╗ ', '██║ ', '██║ ', '██║ ', '██║ ', '╚═╝ '],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  H: ['██╗  ██╗', '██║  ██║', '███████║', '██║  ██║', '██║  ██║', '╚═╝  ╚═╝'],
  U: ['██╗   ██╗', '██║   ██║', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
}
/** 立体字最窄栖身列数(58):低于此自动换点阵小字标。 */
const SHADOW_MIN_COLS = 58

export type LogoStyle = 'shadow' | 'pixel'
const DEFAULT_LOGO_STYLE: LogoStyle = 'shadow'

interface LogoSpec { word: string; font: Record<string, string[]>; cols: number; rows: number; /** 字形间分隔(shadow 自带尾随空格故为 '',点阵补一个空格) */ gap: string }

/**
 * 字标方案:默认恒为 shadow 立体字 TIANSHU(R21 用户实锤:# 点阵降级被终端用户
 * 视为「坏掉了」——品牌艺术字是发布物的脸面,不参与 ASCII 降级;█ ╔ ═ 属
 * CP437 血统块/框线字符,现代终端覆盖率极高,ZCode 同类艺术字亦无条件输出,
 * 唯一小例外见 logoRows 的品牌段星形降级)。pixel 点阵有两个来源:
 * 显式 style='pixel',或窄屏(cols<SHADOW_MIN_COLS=58)自动降档——
 * R21 注释「仅显式选择」与此不符已修正;cols 由字模拼接行宽动态量测。
 */
function logoSpec(style: LogoStyle): LogoSpec {
  const measured = (word: string, font: Record<string, string[]>, gap: string): LogoSpec => {
    const glyphRows = [...word].map(ch => font[ch] ?? [])
    const rowCount = glyphRows[0]?.length ?? 0
    const joined: string[] = []
    for (let r = 0; r < rowCount; r++) joined.push(glyphRows.map(g => g[r] ?? '').join(gap))
    return { word, font, cols: Math.max(...joined.map(j => displayWidth(j))), rows: rowCount, gap }
  }
  return style === 'pixel'
    ? measured('TIANSHU', BLOCK_FONT, ' ')
    : measured('TIANSHU', SHADOW_FONT, '')
}

/** 字标风格解析:显式入参 > RIVET_WELCOME_LOGO 环境变量 > 默认 shadow;
 *  cols 不足以容纳立体字时强制 pixel(auto 降档,显式 pixel 不受影响)。 */
function resolveLogoSpec(explicit: string | undefined, cols: number): { spec: LogoSpec; style: LogoStyle } {
  let style = resolveLogoStyle(explicit)
  if (style === 'shadow' && cols < SHADOW_MIN_COLS) style = 'pixel' /* 窄屏自动降档保留 */
  return { spec: logoSpec(style), style }
}

/** 字标风格解析:显式入参 > RIVET_WELCOME_LOGO 环境变量 > 默认 shadow。 */
function resolveLogoStyle(explicit?: string): LogoStyle {
  const raw = explicit ?? process.env['RIVET_WELCOME_LOGO']
  return raw === 'pixel' || raw === 'tianshu' ? 'pixel' : DEFAULT_LOGO_STYLE
}

const bodyW = (cols: number): number => Math.min(cols, CONTENT_MAX)

/** ambiguous=2 上界截断(兜底口径:宁可右边留白,不可 CJK 终端折行)。 */
function truncateWide(text: string, maxWidth: number): string {
  const ellW = displayWidth('…', WIDE)
  return displayWidth(text, WIDE) > maxWidth
    ? `${truncateToDisplayWidth(text, Math.max(0, maxWidth - ellW), WIDE)}…`
    : text
}

/** home 下的 cwd 缩写。 */
function tildify(cwd: string): string {
  const home = homedir()
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

// ── 颜色小件 ─────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)
  if (!m) return null
  return [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16)]
}

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`

/**
 * 品牌词同色相微渐变(移植 kimi-code gradient-text 思路,收敛为单字档):
 * 首字符向白混 45%,其余原色——光落在星上的观感,不是彩虹。
 * brandColor 非 hex(fallback 轨命名色)时整体回退纯色 bold。
 */
function brandWord(text: string, brandColor: string): string {
  const rgb = hexToRgb(brandColor)
  if (!rgb) return color(text, brandColor, { bold: true })
  const chars = [...text]
  return chars.map((ch, i) => {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0
    const lift = (1 - t) * 0.45
    const mixed = toHex(rgb[0] + (255 - rgb[0]) * lift, rgb[1] + (255 - rgb[1]) * lift, rgb[2] + (255 - rgb[2]) * lift)
    return color(ch, mixed, { bold: true })
  }).join('')
}

function effortBadge(effort: string | undefined, theme: RivetTheme): string {
  if (!effort) return ''
  const short = effort === 'medium' ? 'med' : effort
  const c = effort === 'max' || effort === 'auto' ? theme.secondary
    : effort === 'high' ? theme.primary
    : effort === 'off' ? theme.dim
    : theme.muted
  return color(`◎${short}`, c)
}

// ── 区块渲染 ─────────────────────────────────────────────────────────

/**
 * 块字符大字标:星金单色;第 2 行右侧并挂「✦ 天枢 · vN」原生词标
 * (内容栏放得下才挂,字标独立成立)。ASCII 终端字模本就是 # 空格,无需降级。
 */
function logoRows(theme: RivetTheme, cols: number, version?: string | null, spec?: LogoSpec, degradeTinySymbols = false): string[] {
  spec = spec ?? logoSpec(resolveLogoStyle(undefined))
  const glyphs = [...spec.word].map(ch => spec.font[ch]!)
  const rows: string[] = []
  /* R24 双层豁免落地:艺术字母恒 Unicode(# 字标点阵事故教训);品牌段的小星形
     单独跟随 tiny-symbol 降级——✦(U+2726 钉饰区)覆盖率弱于 █ ╔,纯 ASCII
     终端会豆腐,退为 '*' 后仍是「星压轨道」的视觉语义。 */
  const star = degradeTinySymbols ? '*' : '✦'
  const brandSeg = version
    ? `${color(star, theme.brandColor, { bold: true })} ${brandWord('天枢', theme.brandColor)}${color(' · ', theme.dim)}${color(`v${version}`, theme.dim)}`
    : `${color(star, theme.brandColor, { bold: true })} ${brandWord('天枢', theme.brandColor)}`
  for (let r = 0; r < spec.rows; r++) {
    const line = glyphs.map(g => g[r]!).join(spec.gap)
    if (r === 1 && spec.cols + TAG_GAP + displayWidth(brandSeg, WIDE) <= cols) {
      rows.push(`${color(line, theme.brandColor, { bold: true })}${' '.repeat(TAG_GAP)}${brandSeg}`)
    } else {
      rows.push(color(line, theme.brandColor, { bold: true }))
    }
  }
  return rows
}

/** 保留导出给测试与潜在调用方:小词标(进入提示区/compact 之外的窄用场景预留)。 */
export function smallWordmark(theme: RivetTheme, ascii: boolean): string {
  const star = ascii ? '*' : '✦'
  return `${color(star, theme.brandColor, { bold: true })}  ${brandWord('天枢', theme.brandColor)}  ${color(WORDMARK_PINYIN, theme.muted)}`
}

/** 使命行(静态终态):整行装不下就整体消失,绝不腰斩 slogan。
 *  宽度按 ambiguous=2 上界判定(CJK 终端不折行)。R11 澄清:此行不做字距扩张——
 *  「离太近」指的是字标与右侧品牌段,见 logoRows 的 TAG_GAP。 */
function missionLine(theme: RivetTheme, cols: number): string | null {
  const plain = `   ${MISSION_ZH} · ${MISSION_EN}`
  if (displayWidth(plain) <= bodyW(cols) && displayWidth(plain, WIDE) <= cols) {
    return `${'   '}${color(MISSION_ZH, theme.muted)}${color(' · ', theme.dim)}${color(MISSION_EN, theme.dim)}`
  }
  return null
}

/** 使命行定位针(供调用方在 welcomeLines 中找到需播放扫光的行)。 */
export function isMissionLine(line: string): boolean {
  return line.replace(/\x1B\[[0-9;]*m/g, '').includes(MISSION_ZH)
}

export interface MissionShimmer { final: string; frames: string[] }

/** 扫光帧间休眠(调用方参考值,毫秒)。 */
export const MISSION_SHIMMER_FRAME_MS = 16

/**
 * 使命行「星光扫过」:光带从左到右行进一次(~8 帧 ≈ 130ms,「闪一下」而非「闪半天」),
 *  末帧=静态终态,零跳变。调用方应以阻塞式微休眠播放(见 main.ts sleepSync),
 *  禁用 setTimeout——异步让出会给启动期其他任务插队输出的机会,正是「一卡一卡」的来源。
 * - 色彩纪律:扫过段 = primary bold(瞬态 chroma,与 effort 徽章同级的受控位),扫过即回 muted/dim;
 * - kira 变体(候选 3,voice=playful):光带头 1 字符白闪(#fff)——「✨ 星点划过+彩尾」,
 *   非彩虹;仍是单一瞬态 accent(白+主色同带),扫过即回底;
 * - neon 变体(voice=tech 通式,2026-09):光带头=primary、尾迹=该主题 secondary 的
 *   双色霓虹扫线。通式非 cyberpunk 专属——各 tech 主题尾色随自身 secondary:
 *   cyberpunk=品红粉(synthwave 日落)/ gemini=星云紫/ antigravity=天青(近似头色,
 *   双色弱化接近单色,可接受)。审查 #6 核验:描述不得锁死单一主题实例;若某主题
 *   不需要渐变尾,后续可加 palette 级扫光档位开关(本期不引入,扩散面可控)。
 * - ASCII / 窄屏(使命行不存在)→ null,调用方直接写静态行;
 * - 帧由调用方播放(\r\x1B[2K + 帧 + MISSION_SHIMMER_FRAME_MS 休眠),RIVET_WELCOME_ANIM=0 时应跳过。
 */
export function missionShimmer(theme: RivetTheme, cols: number): MissionShimmer | null {
  const finalLine = missionLine(theme, cols)
  if (!finalLine) return null
  const cells: { ch: string; base: string }[] = []
  for (const ch of `   ${MISSION_ZH} · `) cells.push({ ch, base: ch === ' ' || ch === '·' ? theme.dim : theme.muted })
  for (const ch of MISSION_EN) cells.push({ ch, base: theme.dim })
  const WIN = 4
  const kira = theme.voice === 'playful'
  const neon = theme.voice === 'tech'
  const frameCount = Math.min(10, Math.max(6, Math.ceil(cells.length / 6)))
  const step = (cells.length + WIN) / frameCount
  const frames: string[] = []
  for (let f = 0; f < frameCount; f++) {
    const head = Math.round(f * step)
    const rendered = cells.map((c, i) => {
      const d = head - i
      if (d >= 0 && d < WIN && c.ch !== ' ') {
        if (kira && d === 0) return color(c.ch, '#ffffff', { bold: true })
        // neon(tech 通式):头部 primary、尾迹该主题 secondary——双色霓虹渐变扫线
        if (neon && d > 0) return color(c.ch, theme.secondary, { bold: true })
        return color(c.ch, theme.primary, { bold: true })
      }
      return color(c.ch, c.base)
    }).join('')
    frames.push(rendered)
  }
  frames.push(finalLine)
  return { final: finalLine, frames }
}

/** 基准线:唯一全幅元素,✦ 压在 ⌊cols×0.38⌋;横线取星域 separator 档。 */
function datumLine(theme: RivetTheme, ascii: boolean, cols: number, separator?: string): string {
  const h = ascii ? '-' : boxCharsFor(separator ?? 'thin').h
  const star = ascii ? '*' : '✦'
  const k = Math.max(1, Math.floor(cols * STAR_AT))
  const rest = Math.max(0, cols - k - displayWidth(star, WIDE))
  return color(h.repeat(k), theme.muted, { bold: true })
    + color(star, theme.brandColor, { bold: true })
    + color(h.repeat(rest), theme.muted, { bold: true })
}

/** 进入提示区:新会话一次性短提醒(竖排,规格 §三 中层)。
 *  P2 收拢(2026-09):4→3 行——/handoff 与缓存成本提示同属「会话成本管理」主题,
 *  合并为一行(full ≥58 列 / short 恒 44+ 放得下),省出的行位让给问候语 settle。 */
function entryHintLines(theme: RivetTheme, ascii: boolean, cols: number): string[] {
  const handoff = ascii ? '-' : '⏜'
  const note = ascii ? '.' : '✧'
  /* /domain 置首(R12):查看星域描述与切换;全版 ≥52 列,中栏短版,再窄省略 */
  const domainFull = `${color(note, theme.secondary)} ${color(HINT_DOMAIN_CMD, theme.brandColor)} ${color(HINT_DOMAIN_DESC, theme.muted)}`
  const domainShort = `${color(note, theme.secondary)} ${color(HINT_DOMAIN_CMD, theme.brandColor)} ${color(HINT_DOMAIN_SHORT, theme.muted)}`
  const domainPlainW = (t: string) => displayWidth(t.replace(/\x1B\[[0-9;]*m/g, ''), WIDE)
  /* 协同曝光(2026-08-28):/team /scout /council 是多代理能力的三条入口,
   *  新用户首屏可见;与 domain 行同规则——全版/短版/过窄省略。 */
  const collabFull = `${color(note, theme.secondary)} ${color(HINT_COLLAB_CMDS, theme.brandColor)} ${color(HINT_COLLAB_DESC, theme.muted)}`
  const collabShort = `${color(note, theme.secondary)} ${color(HINT_COLLAB_SHORT_CMDS, theme.brandColor)} ${color(HINT_COLLAB_SHORT_DESC, theme.muted)}`
  /* 合并行:P2 收拢。full 用原 handoff/cache 文案逐字拼接;中栏短版去
   *  「新会话/中途切/满60%」保命令 token;着色沿用原两行结构
   *  (⏜ secondary · /handoff brandColor · 命令 token secondary)。 */
  const mergedFull = `${color(handoff, theme.secondary)} ${color('/handoff', theme.brandColor)} ${color(HINT_HANDOFF, theme.muted)}${color(' · ', theme.dim)}${color(HINT_CACHE_A, theme.muted)} ${color(HINT_CACHE_CMDS, theme.secondary)} ${color(HINT_CACHE_B, theme.muted)}`
  const mergedShort = `${color(handoff, theme.secondary)} ${color('/handoff', theme.brandColor)} ${color('交接', theme.muted)}${color(' · ', theme.dim)}${color(HINT_CACHE_CMDS, theme.secondary)} ${color(HINT_CACHE_B, theme.muted)}`
  const lines: string[] = []
  if (domainPlainW(domainFull) <= cols) lines.push(domainFull)
  else if (domainPlainW(domainShort) <= cols) lines.push(domainShort)
  if (domainPlainW(collabFull) <= cols) lines.push(collabFull)
  else if (domainPlainW(collabShort) <= cols) lines.push(collabShort)
  if (domainPlainW(mergedFull) <= cols) lines.push(mergedFull)
  else if (domainPlainW(mergedShort) <= cols) lines.push(mergedShort)
  return lines
}

/** 首启引导块(P1-1):一句话定位 + 可直接照抄的示例 ×3 + 基础操作提示。
 *  仅调用方判定首启(guide=true)且全妆形态时替换 entryHintLines;档位链
 *  整行(含 glyph 前缀)装不下降档、再装不下省略——与 entryHint 同构,
 *  CJK 终端绝不折行。
 *
 *  voice 角色化(2026-09,主题风格化):theme.voice=playful/tech 时 intro 换
 *  角色台词(星灵小天 / Nova 助手)——「换主题=换伙伴」;窄档回落中性链。 */
function guideLines(theme: RivetTheme, ascii: boolean, cols: number): string[] {
  const star = ascii ? '*' : '✦'
  const enter = ascii ? '-' : '⏎'
  const lines: string[] = []
  /* 档位判定必须计入「  glyph 」前缀——此前只测文本宽,44 列下 hint full
   *  档(文本 41)选中后整行 46 折行(瑶光反证抓到)。 */
  const glyphW = (glyph: string, text: string): number => displayWidth(`  ${glyph} ${text}`, WIDE)
  const voiceIntro = theme.voice !== 'default' ? GUIDE_INTRO_VOICE[theme.voice] : undefined
  const intro = voiceIntro && glyphW(star, voiceIntro) <= cols ? voiceIntro
    : glyphW(star, GUIDE_INTRO) <= cols ? GUIDE_INTRO
    : glyphW(star, GUIDE_INTRO_SHORT) <= cols ? GUIDE_INTRO_SHORT
    : glyphW(star, GUIDE_INTRO_TINY) <= cols ? GUIDE_INTRO_TINY
    : null
  if (intro) lines.push(`  ${color(star, theme.secondary)} ${color(intro, theme.muted)}`)
  for (const ex of GUIDE_EXAMPLES) {
    if (displayWidth(`  · ${ex}`, WIDE) <= cols) lines.push(`  ${color('·', theme.dim)} ${color(ex, theme.muted)}`)
  }
  const hint = glyphW(enter, GUIDE_HINT) <= cols ? GUIDE_HINT
    : glyphW(enter, GUIDE_HINT_SHORT) <= cols ? GUIDE_HINT_SHORT
    : null
  if (hint) lines.push(`  ${color(enter, theme.secondary)} ${color(hint, theme.dim)}`)
  return lines
}

/** compact 单行:✦ 天枢 · model ◎eff · ~/dir · ↑续N(#id) · v3.6.0(贪心装填,超宽截断)。 */
function compactLine(input: FormatWelcomeInput, theme: RivetTheme, ascii: boolean): string {
  const star = ascii ? '*' : '✦'
  const sep = color(' · ', theme.dim)
  const out: string[] = [color(`${star} 天枢`, theme.brandColor, { bold: true })]
  const resume = input.priorMsgCount > 0
  const eff = effortBadge(input.reasoningEffort, theme)
  const modelPart = eff ? `${color(input.modelName, theme.secondary)} ${eff}` : color(input.modelName, theme.secondary)
  const items: string[] = []
  if (resume) {
    items.push(color(`↑续${input.priorMsgCount}轮`, theme.secondary), modelPart)
  } else {
    items.push(modelPart, color(tildify(input.cwd), theme.muted))
    items.push(input.numericId ? color(`#${input.numericId}`, theme.dim) : color(input.sessionId.slice(0, 8), theme.dim))
  }
  if (input.version) items.push(color(`v${input.version}`, theme.dim))
  let acc = displayWidth('✦ 天枢', WIDE)
  for (const item of items) {
    const need = displayWidth(' · ', WIDE) + displayWidth(item, WIDE)
    if (acc + need > input.columns) break
    acc += need
    out.push(sep, item)
  }
  return truncateWide(out.join(''), input.columns)
}

// ── 入口 ─────────────────────────────────────────────────────────────

export function formatWelcome(input: FormatWelcomeInput, theme: RivetTheme): string[] {
  const cols = input.columns > 0 ? input.columns : 80
  const ascii = useAsciiBorders()
  const { spec: logoSpecResolved } = resolveLogoSpec(input.logoStyle, cols)
  const logoRowCount = logoSpecResolved.rows

  const compactLine0 = (): string[] => [compactLine(input, theme, ascii)]

  if (input.compact) return compactLine0()
  const rows = input.rows && input.rows > 0 ? input.rows : Number.POSITIVE_INFINITY
  /* guide 引导块比提示区多 1 行内容,全妆门槛相应 +1——矮屏宁退单行不画半套引导。 */
  const guideExtra = input.guide ? 1 : 0
  if (rows < logoRowCount + FULL_FIXED_ROWS + RESERVED_ROWS + guideExtra) return compactLine0()
  if (cols < MIN_COLS) return compactLine0()

  const mission = missionLine(theme, cols)
  return [
    '',
    ...logoRows(theme, cols, input.version, logoSpecResolved, ascii),
    ...(mission ? [mission] : []),
    datumLine(theme, ascii, cols, input.separator),
    '',
    ...(input.guide ? guideLines(theme, ascii, cols) : entryHintLines(theme, ascii, cols)),
    '',
  ]
}

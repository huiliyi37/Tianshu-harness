/**
 * Cockpit 文案表 —— TUI 侧唯一的 i18n 落点。
 *
 * 为什么只覆盖 cockpit：TUI 其余部分不参与切换，而 cockpit 是运行时仪表盘、
 * 术语密集（cache / doom / verify / lift），中英切换的价值最高；且它的原稿本就
 * 中英混搭（面板名英文、状态词中文），统一成一整套语言是净改善。
 * 本模块是纯查表 + 纯函数：无 IO、无状态、无时钟。
 *
 * 语言解析（resolveCockpitLang）：
 *   RIVET_LANG 环境变量（zh / en，大小写不敏感，接受 zh-CN / en-US 等前缀）
 *   > 默认 'zh'（本项目中文用户为主）。
 */

import type { Panel } from './types.js'
import { PANEL_LABELS } from './types.js'

export type CockpitLang = 'zh' | 'en'

export interface CockpitText {
  panels: Record<Panel, string>
  frame: {
    title: string
    /** summary 视图的 footer */
    footerAll: string
    /** 聚焦视图的 footer，{label} 会被替换为当前面板名 */
    footerFocus: string
  }
  safety: { doom: string }
  verify: { read: string; mod: string }
  context: { rounds: string; brokenRounds: string }
  model: { cache: string; reasoning: string; prewarm: string; speculative: string; domain: string }
  mcp: { tools: string; connected: string }
  trace: { events: string }
  advisory: {
    rendered: string
    dropped: string
    adopted: string
    ignored: string
    heldOut: string
    pending: string
    silenced: string
    liftReason: string
    habituationReason: string
    streak: string
    adoptRate: string
    /** per-key 行的三个计数后缀（中文单字 / 英文缩写） */
    sent: string
    adoptedShort: string
    ignoredShort: string
    statusLane: string
  }
}

const ZH: CockpitText = {
  panels: {
    summary: '概览',
    trace: '轨迹',
    verify: '验证',
    context: '上下文',
    safety: '安全',
    model: '模型',
    mcp: 'MCP',
    advisory: '提醒',
  },
  frame: {
    title: '运行时仪表盘',
    footerAll: '←/→ 切换面板   ·   q 关闭',
    footerFocus: '{label}   ·   ←/→ 切换面板   ·   /cockpit summary 看全部   ·   q 关闭',
  },
  safety: { doom: '空转' },
  verify: { read: '读', mod: '改' },
  context: { rounds: '回合', brokenRounds: '破裂回合' },
  model: {
    cache: '缓存',
    reasoning: '推理',
    prewarm: '预热',
    speculative: '投机预读 (hits/enqueued)',
    domain: '星域',
  },
  mcp: { tools: '工具', connected: '已连' },
  trace: { events: '事件' },
  advisory: {
    rendered: '渲染',
    dropped: '丢弃',
    adopted: '采纳',
    ignored: '忽略',
    heldOut: '挂起',
    pending: '待观察',
    silenced: '静音',
    liftReason: '增益',
    habituationReason: '习惯',
    streak: '连忽',
    adoptRate: '采纳',
    sent: '投',
    adoptedShort: '纳',
    ignoredShort: '忽',
    statusLane: 'status 通道',
  },
}

const EN: CockpitText = {
  // 英文面板名沿用既有常量，避免双源定义
  panels: PANEL_LABELS,
  frame: {
    title: 'Runtime Dashboard',
    footerAll: '←/→ panels   ·   q close',
    footerFocus: '{label}   ·   ←/→ panels   ·   /cockpit summary for all   ·   q close',
  },
  safety: { doom: 'doom' },
  verify: { read: 'read', mod: 'mod' },
  context: { rounds: 'rounds', brokenRounds: 'broken rounds' },
  model: {
    cache: 'cache',
    reasoning: 'reasoning',
    prewarm: 'prewarm',
    speculative: 'speculative prewarm (hits/enqueued)',
    domain: 'domain',
  },
  mcp: { tools: 'tools', connected: 'connected' },
  trace: { events: 'events' },
  advisory: {
    rendered: 'rendered',
    dropped: 'dropped',
    adopted: 'adopted',
    ignored: 'ignored',
    heldOut: 'heldOut',
    pending: 'pending',
    silenced: 'silenced',
    liftReason: 'lift',
    habituationReason: 'hab',
    streak: 'streak',
    adoptRate: 'adopt',
    sent: ' sent',
    adoptedShort: ' adopted',
    ignoredShort: ' ignored',
    statusLane: 'status lane',
  },
}

/**
 * 解析本次渲染使用的语言。接受 'zh' / 'en' 及其地区前缀形式（zh-CN、en-US），
 * 大小写不敏感；未设置或无法识别时回退 'zh'。
 */
export function resolveCockpitLang(env: NodeJS.ProcessEnv = process.env): CockpitLang {
  const raw = env.RIVET_LANG
  if (!raw) return 'zh'
  const norm = raw.trim().toLowerCase()
  if (norm.startsWith('en')) return 'en'
  if (norm.startsWith('zh')) return 'zh'
  return 'zh'
}

export function cockpitText(lang: CockpitLang): CockpitText {
  return lang === 'en' ? EN : ZH
}

/** 面板名（rail 与 footer 共用；zh 走本表，en 与 types.ts 的 PANEL_LABELS 同源）。 */
export function panelLabel(panel: Panel, lang: CockpitLang): string {
  return cockpitText(lang).panels[panel]
}

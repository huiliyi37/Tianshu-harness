import { isFilesystemMetadata } from '../utils/file-metadata.js'
/**
 * log-locations.ts — 日志落点的单一事实源。
 *
 * 存在理由：会话/缓存/六维日志分散在三棵树（`<数据根>/sessions`、
 * `<数据根>/desktop`、`<项目>/.rivet`），键还各不相同（cwd slug 取 sha256 前 6 位、
 * memory 取前 12 位、桌面按 session id）。在此之前用户想找自己的日志只能读源码——
 * `/doctor` 一个数据路径都不打印，唯一的路径文档在内部目录且已过时。
 *
 * 本模块只负责「算出路径 + 说清门控与回收」，不做渲染决策之外的任何 IO 副作用。
 * `/logs` 斜杠命令、`rivet logs` CLI、桌面 Settings → Storage 三个入口都渲染它，
 * 避免第四份各自漂移的路径清单。
 *
 * 门控与回收字段是照代码核过的事实，不是设计意图——改了写入逻辑请同步这里，
 * 否则用户会按错的说明去找空文件。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { rivetHome, defaultRivetHome, sessionsDir, desktopDir, desktopSessionsDir, memoryDir, projectSlug } from '../config/paths.js'

export type LogKind = 'file' | 'dir'

/** 落点分组。渲染层按此排序分节，顺序即排查优先级。 */
export type LogGroupId = 'session' | 'session-diag' | 'desktop' | 'cross-session' | 'project'

export const GROUP_LABELS: Record<LogGroupId, string> = {
  'session': '会话主干',
  'session-diag': '会话内诊断（缓存 / 六维 / 工具轨迹）',
  'desktop': '桌面端',
  'cross-session': '跨会话与根级',
  'project': '项目内 .rivet/',
}

export interface LogLocation {
  /** 稳定标识，供程序化消费（桌面 UI、测试）引用，不随文案改动。 */
  readonly id: string
  readonly label: string
  readonly path: string
  readonly kind: LogKind
  readonly group: LogGroupId
  /** 写入门控：什么条件下才会有内容。空表示始终写。 */
  readonly gate?: string
  /** 回收策略。标注「不回收」的是已知会无限累积的。 */
  readonly retention?: string
}

export interface EnvOverride {
  readonly env: string
  readonly value: string
  readonly effect: string
}

export interface LogLocationReport {
  readonly rivetHome: string
  readonly homeSource: 'RIVET_HOME' | 'platform-default'
  readonly platformDefault: string
  readonly cwd: string
  readonly projectSlug: string
  readonly sessionId?: string
  /** 会话树目录。`RIVET_SESSION_DIR` 生效时会绕过 slug 分层直接指向它。 */
  readonly sessionDir: string
  readonly locations: readonly LogLocation[]
  readonly overrides: readonly EnvOverride[]
}

/**
 * `memory/` 的分片键：sha256(cwd) 前 12 位。
 *
 * 注意它与 `projectSlug` 的哈希**不是同一个算法**——slug 在 Windows 上会先把
 * cwd 小写化并统一分隔符再哈希，这里用的是原始 cwd（照 `observation-store.ts`
 * 的 `projectHash`）。POSIX 下两者一致，所以 slug 的 6 位哈希是这里 12 位的前缀，
 * 可以互相反查；Windows 下大小写不同的 cwd 会得到不同的 memory 分片。
 */
function memoryHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

function collectOverrides(): EnvOverride[] {
  const specs: Array<[string, string]> = [
    ['RIVET_HOME', '整棵数据树搬家（CLI 生效；桌面端不读环境变量，只认 launcher.json）'],
    ['RIVET_SESSION_DIR', '只搬会话树，并绕过 slug 分层——该目录直接当成最终会话目录'],
    ['RIVET_DESKTOP_DIR', '只搬桌面树（含 sidecar 退出面包屑与会话事件流）'],
    ['RIVET_DESKTOP_SESSION_DIR', '只搬桌面会话事件流'],
    ['RIVET_CONFIG_PATH', '只搬 config.json'],
  ]
  const out: EnvOverride[] = []
  for (const [env, effect] of specs) {
    const value = process.env[env]
    if (value) out.push({ env, value, effect })
  }
  return out
}

/** 遥测门控的说明文案。集中在此，三个入口共用同一套措辞。 */
const GATE_SENSORIUM =
  '全量需 RIVET_DEBUG_TELEMETRY（任意非空值）；未设时只写 vitals-lite 等轻量行，RIVET_TELEMETRY_LITE=0 则完全静默'
const GATE_FRAMES = '默认开；RIVET_FRAME_TELEMETRY=0 或 RIVET_TELEMETRY_LITE=0 关闭'
const EVICT = '同 slug 超 50 会话时按 mtime 淘汰最旧的'

/**
 * 算出当前上下文下所有日志落点。
 *
 * `sessionId` 缺省时六维与认知帧会落到项目内 `.rivet/` 的回退路径——这不是
 * 假设而是 `telemetry-writer.ts` / `frame-telemetry.ts` 的真实分支，且实测仍在
 * 活跃写入。会话专属的那几份（缓存日志、工具轨迹）没有回退路径，此时用
 * `<session-id>` 占位标出形状，让用户知道缺的是会话 id 而不是文件。
 */
export function resolveLogLocations(input: { cwd: string; sessionId?: string }): LogLocationReport {
  const { cwd, sessionId } = input
  const home = rivetHome()
  const sessionRoot = sessionsDir(cwd)
  const slug = projectSlug(cwd)
  const dtop = desktopDir()

  // 会话子目录：有 id 用真实路径，无 id 用占位符标出形状。
  const sessionSub = join(sessionRoot, sessionId ?? '<session-id>')
  // 六维/帧的回退落点：无 sessionId 时写项目内 .rivet/。
  const telemetryDir = sessionId ? sessionSub : join(cwd, '.rivet')
  const projectRivet = join(cwd, '.rivet')
  const idPrefix = sessionId ?? '<session-id>'

  const locations: LogLocation[] = [
    // ── 会话主干 ──
    { id: 'transcript', label: '对话主体（user/assistant/tool、model_switch、usage）', path: join(sessionRoot, `${idPrefix}.jsonl`), kind: 'file', group: 'session', retention: EVICT },
    { id: 'meta', label: '会话元数据（model / cwd / turn 数 / cleanExit）', path: join(sessionRoot, `${idPrefix}.meta.json`), kind: 'file', group: 'session', retention: EVICT },
    { id: 'session-memory', label: '会话记忆（compact 蒸馏）', path: join(sessionRoot, `${idPrefix}.memory.json`), kind: 'file', group: 'session', gate: 'compact 触发时才写', retention: EVICT },
    { id: 'claims', label: '文件归属声明', path: join(sessionRoot, `${idPrefix}.claims.jsonl`), kind: 'file', group: 'session', gate: '有 claim 时', retention: EVICT },
    { id: 'frozen', label: '冻结前缀快照（resume 缓存继承）', path: join(sessionRoot, `${idPrefix}.frozen.json`), kind: 'file', group: 'session', gate: '每个 user 边界 + shutdown', retention: EVICT },
    { id: 'handoff', label: '会话交接文档', path: join(sessionRoot, `${idPrefix}.handoff.md`), kind: 'file', group: 'session', gate: 'shutdown 兜底 / /handoff', retention: '不回收（会无限累积）' },

    // ── 会话内诊断 ──
    { id: 'cache-log', label: '逐 API 请求缓存指标 + 侧路成本', path: join(sessionSub, 'cache-log.jsonl'), kind: 'file', group: 'session-diag' },
    { id: 'sensorium', label: '六维快照 / CVM / advisory 台账', path: join(telemetryDir, 'sensorium.jsonl'), kind: 'file', group: 'session-diag', gate: GATE_SENSORIUM, retention: '无上限' },
    { id: 'frames', label: '认知帧（相位、策略）', path: join(telemetryDir, 'frames.jsonl'), kind: 'file', group: 'session-diag', gate: GATE_FRAMES, retention: '1,500 行封顶' },
    { id: 'appendix-trace', label: '逐请求附录渲染留痕（模型实际看到的自述块）', path: join(sessionSub, 'appendix-trace.jsonl'), kind: 'file', group: 'session-diag', gate: 'RIVET_APPENDIX_TRACE=1', retention: '无上限' },
    { id: 'tool-result-trace', label: '工具结果轨迹', path: join(sessionSub, 'tool-result-trace.jsonl'), kind: 'file', group: 'session-diag', gate: '命中特定诊断条件' },
    { id: 'tool-input-trace', label: '工具入参轨迹（含 hook 改写链）', path: join(sessionSub, 'tool-input-trace.jsonl'), kind: 'file', group: 'session-diag', gate: '命中特定诊断条件' },
    { id: 'pheromones', label: '会话内信息素（非跨会话）', path: join(sessionSub, 'pheromones.json'), kind: 'file', group: 'session-diag', gate: '有沉积时' },
    { id: 'file-history', label: '文件读写历史', path: join(sessionSub, 'file-history.json'), kind: 'file', group: 'session-diag' },

    // ── 桌面端 ──
    { id: 'sidecar-logs', label: 'sidecar stdout/stderr —— GUI 启动失败的唯一线索', path: join(home, 'logs'), kind: 'dir', group: 'desktop', gate: '每次启动新建一个带时间戳的文件', retention: '不轮转' },
    { id: 'sidecar-exit', label: 'sidecar 退出面包屑（崩溃排查第一现场）', path: join(dtop, 'sidecar-exit.json'), kind: 'file', group: 'desktop', gate: '退出时' },
    { id: 'desktop-sessions', label: '桌面会话 UI 事件流目录（与会话主干是两份不同数据）', path: desktopSessionsDir(), kind: 'dir', group: 'desktop' },
    { id: 'desktop-events', label: '本会话的 UI 事件流', path: join(desktopSessionsDir(), idPrefix, 'events.jsonl'), kind: 'file', group: 'desktop', gate: '仅桌面端会话；非 ephemeral 模式' },

    // ── 跨会话与根级 ──
    { id: 'memory-shard', label: `跨会话记忆分片（观察 / 门禁台账 / 召回有效性）`, path: memoryDir(memoryHash(cwd)), kind: 'dir', group: 'cross-session' },
    { id: 'subagents', label: 'worker 子会话恢复数据', path: join(home, 'subagents'), kind: 'dir', group: 'cross-session' },
    { id: 'update-log', label: '自更新日志', path: join(home, 'update.log'), kind: 'file', group: 'cross-session', gate: '执行过 /update' },
    { id: 'history', label: 'TUI 命令历史', path: join(home, 'history.json'), kind: 'file', group: 'cross-session' },

    // ── 项目内 ──
    { id: 'knowledge', label: '项目持久化知识（跨会话）', path: join(projectRivet, 'knowledge'), kind: 'dir', group: 'project' },
    { id: 'playbook', label: '历史教训回放', path: join(projectRivet, 'playbook.jsonl'), kind: 'file', group: 'project' },
    { id: 'artifacts', label: '大工具输出全文（主会话 + worker）', path: join(projectRivet, 'artifacts'), kind: 'dir', group: 'project' },
    { id: 'plans', label: 'Plan Mode 计划文档', path: join(projectRivet, 'plans'), kind: 'dir', group: 'project' },
  ]

  return {
    rivetHome: home,
    homeSource: process.env['RIVET_HOME'] ? 'RIVET_HOME' : 'platform-default',
    platformDefault: defaultRivetHome(),
    cwd,
    projectSlug: slug,
    ...(sessionId ? { sessionId } : {}),
    sessionDir: sessionRoot,
    locations,
    overrides: collectOverrides(),
  }
}

export interface LogLocationStatus extends LogLocation {
  readonly exists: boolean
  /** 文件字节数。目录恒为 0——目录看 `entries`。 */
  readonly bytes: number
  /** 目录条目数。文件为 undefined。 */
  readonly entries?: number
  readonly mtimeMs?: number
}

/**
 * 探测每个落点的存在性与规模。
 *
 * 全程 fail-open：排查工具自己因为权限/竞态崩掉是最没用的失败模式，
 * 任何 IO 异常都退化成 `exists:false` 而不是抛出。
 */
export function statLogLocations(locations: readonly LogLocation[]): LogLocationStatus[] {
  return locations.map((loc) => {
    try {
      if (!existsSync(loc.path)) return { ...loc, exists: false, bytes: 0 }
      const st = statSync(loc.path)
      if (st.isDirectory()) {
        let entries = 0
        try { entries = readdirSync(loc.path).filter(name => !isFilesystemMetadata(name)).length } catch { entries = 0 }
        return { ...loc, exists: true, bytes: 0, entries, mtimeMs: st.mtimeMs }
      }
      return { ...loc, exists: true, bytes: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return { ...loc, exists: false, bytes: 0 }
    }
  })
}

/**
 * 找出会话树里最近写入的会话 id。
 *
 * `rivet logs` 在会话外运行时用它兜底——否则用户拿到的是一堆 `<session-id>`
 * 占位符，等于还得自己去 `ls -t`。
 *
 * 刻意排除 `worker-*`：worker 子会话与主会话共用同一个 slug 目录，而且往往
 * 是最后写入的那个（派发结束晚于用户最后一句话）。不排除的话用户跑
 * `rivet logs` 拿到的是某个子代理的落点，不是自己的对话。
 */
export function latestSessionId(sessionDir: string): string | undefined {
  try {
    const files = readdirSync(sessionDir).filter(f =>
      !isFilesystemMetadata(f) && f.endsWith('.jsonl') && !f.includes('.claims.') && !f.startsWith('worker-'))
    let best: { id: string; mtime: number } | undefined
    for (const f of files) {
      const id = f.slice(0, -'.jsonl'.length)
      let mtime = 0
      try { mtime = statSync(join(sessionDir, f)).mtimeMs } catch { continue }
      if (!best || mtime > best.mtime) best = { id, mtime }
    }
    return best?.id
  } catch {
    return undefined
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function sizeCell(s: LogLocationStatus): string {
  if (!s.exists) return '  --  '
  if (s.kind === 'dir') return `${s.entries ?? 0} 项`
  return formatBytes(s.bytes)
}

/**
 * 渲染成等宽终端文本。`/logs` 与 `rivet logs` 共用，保证两处措辞一致。
 */
export function formatLogLocationReport(
  report: LogLocationReport,
  statuses: readonly LogLocationStatus[],
): string {
  const lines: string[] = ['日志落点 (/logs)', '═══════════════════════']

  lines.push(`数据根: ${report.rivetHome}`)
  lines.push(`        来源 ${report.homeSource === 'RIVET_HOME' ? 'RIVET_HOME 环境变量' : `平台默认（${report.platformDefault}）`}`)
  lines.push(`项目:   ${report.cwd}`)
  lines.push(`slug:   ${report.projectSlug}`)
  lines.push(`会话:   ${report.sessionId ?? '（未指定——会话专属落点以 <session-id> 占位）'}`)

  if (report.overrides.length > 0) {
    lines.push('', '生效中的路径覆盖')
    lines.push('───────────────────────')
    for (const o of report.overrides) {
      lines.push(`${o.env}=${o.value}`)
      lines.push(`  ${o.effect}`)
    }
  }

  const groups: LogGroupId[] = ['session', 'session-diag', 'desktop', 'cross-session', 'project']
  for (const g of groups) {
    const rows = statuses.filter(s => s.group === g)
    if (rows.length === 0) continue
    lines.push('', GROUP_LABELS[g], '───────────────────────')
    const widest = Math.max(...rows.map(r => sizeCell(r).length))
    for (const r of rows) {
      lines.push(`[${sizeCell(r).padStart(widest)}] ${r.path}`)
      lines.push(`${' '.repeat(widest + 3)}${r.label}`)
      if (r.gate) lines.push(`${' '.repeat(widest + 3)}门控: ${r.gate}`)
      if (r.retention) lines.push(`${' '.repeat(widest + 3)}回收: ${r.retention}`)
    }
  }

  lines.push('')
  lines.push('说明: [ -- ] 表示尚未产生。六维为空先查门控那行的环境变量。')
  lines.push('桌面端的数据根由 launcher.json 决定，不读环境里的 RIVET_HOME——')
  lines.push('在设置 → 存储位置页可以看到桌面端实际用的路径。')

  return lines.join('\n')
}

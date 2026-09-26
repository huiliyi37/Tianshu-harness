/**
 * CVM 台账聚合与渲染（issue #249）——`/debug cvm` 的数据层。
 *
 * 纯函数、零 IO：单元格的读取由调用方（slash-commands 的 /debug cvm 分支）
 * 负责，本模块只把 sensorium.jsonl 的行聚合成可渲染的分布。
 *
 * 复算口径与 `docs/reference/observability-harness.md:221` 的 jq 命令一致：
 *
 *   jq -r 'select(.kind=="cvm-vector-decision") | .classification' sensorium.jsonl \
 *     | sort | uniq -c
 *
 * 唯一差异在 null：`classification` 在遥测里可为 null（有 candidate/yielded 但无
 * 分类命中时仍落一行），jq 会把它输出成字符串 "null"；这里归入 `(none)` 桶并
 * 在渲染时保留，既不与真实分类混淆，也不把数字吞掉。
 */

/**
 * 困难分类的中文标签。键与 `src/agent/hooks/cognitive-capsule-router.ts` 的
 * `CvmDifficultyKind` 同源（gate-blocked / context-pressure / perspective-locked /
 * verification-debt / attack-stalled）。
 *
 * 未知取值不丢弃——原样透出分类名，让新增分类在界面上立刻可见，而不是被静默
 * 折进兜底桶。所以这里刻意不是穷尽的 Record<CvmDifficultyKind, string>。
 */
const CLASSIFICATION_LABELS: Readonly<Record<string, string>> = {
  'gate-blocked': '门禁拦截',
  'verification-debt': '验证债务',
  'context-pressure': '上下文压力',
  'perspective-locked': '视角锁定',
  'attack-stalled': '攻坚停滞',
}

/** `classification: null` 的桶名。 */
export const CVM_NONE_BUCKET = '(none)'

export interface CvmClassificationCount {
  readonly classification: string
  /** 中文标签；未知分类回落到 classification 本身。 */
  readonly label: string
  readonly count: number
}

export interface CvmLedgerSummary {
  /** `kind === 'cvm-vector-decision'` 的行数。 */
  readonly total: number
  /** 按 count 降序、同 count 按分类名升序（稳定，不依赖输入顺序）。 */
  readonly byClassification: readonly CvmClassificationCount[]
  /** 非空但无法解析为对象的行数。 */
  readonly malformed: number
}

/**
 * 聚合 sensorium.jsonl 的行。
 *
 * 全程 fail-open：单行坏了只计入 `malformed`，不抛出——排查工具自己崩掉是最
 * 没用的失败模式。空白行直接跳过，不计入 malformed（那是文件格式，不是坏数据）。
 */
export function summarizeCvmLedger(lines: Iterable<string>): CvmLedgerSummary {
  let total = 0
  let malformed = 0
  const counts = new Map<string, number>()

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      malformed++
      continue
    }
    if (!parsed || typeof parsed !== 'object') {
      malformed++
      continue
    }

    const rec = parsed as Record<string, unknown>
    if (rec['kind'] !== 'cvm-vector-decision') continue

    total++
    const cls = typeof rec['classification'] === 'string' && rec['classification'].length > 0
      ? rec['classification']
      : CVM_NONE_BUCKET
    counts.set(cls, (counts.get(cls) ?? 0) + 1)
  }

  const byClassification = [...counts.entries()]
    .map(([classification, count]) => ({
      classification,
      label: CLASSIFICATION_LABELS[classification] ?? classification,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.classification.localeCompare(b.classification))

  return { total, byClassification, malformed }
}

/** 渲染成等宽终端文本。空台账给出可行动提示（指向门控），不是一句「无数据」。 */
export function formatCvmLedgerSummary(
  summary: CvmLedgerSummary,
  opts: { sessionId?: string; path?: string } = {},
): string {
  const scope = opts.sessionId ? `会话 ${opts.sessionId}` : '本会话'

  if (summary.total === 0) {
    const lines = [
      `CVM 拦截 · ${scope}：没有记录。`,
      '台账只在发生拦截时写入（sensorium.jsonl 的 cvm-vector-decision 行）。',
      '若确信发生过拦截，先查落点与门控：/logs 看 sensorium.jsonl 的路径与写入条件',
      '（全量需 RIVET_DEBUG_TELEMETRY；未设时只写轻量行）。',
    ]
    if (opts.path) lines.push(`落点：${opts.path}`)
    return lines.join('\n')
  }

  const lines = [`CVM 拦截 · ${scope}（cvm-vector-decision ×${summary.total}）`]
  const widest = Math.max(...summary.byClassification.map((r) => r.classification.length))
  for (const r of summary.byClassification) {
    lines.push(`  ${r.classification.padEnd(widest)}  ${r.label}  ×${r.count}`)
  }
  if (summary.malformed > 0) {
    lines.push(`  （另有 ${summary.malformed} 行无法解析，已跳过）`)
  }
  if (opts.path) lines.push(`落点：${opts.path}`)
  return lines.join('\n')
}

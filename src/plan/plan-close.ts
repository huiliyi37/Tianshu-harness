export interface PlanCloseOptions {
  tasks: string
  verifiedCommands?: string[]
  deliveryState?: 'GREEN' | 'YELLOW' | 'RED'
  note?: string
  updateClosure?: boolean
}

export interface PlanCloseChange {
  taskNumber: number
  checkboxCount: number
  changedCheckboxCount: number
}

export interface PlanCloseResult {
  content: string
  changes: PlanCloseChange[]
  totalChangedCheckboxes: number
  alreadyClosed: boolean
  closureInserted: boolean
  closureUpdated: boolean
}

interface TaskBlock {
  taskNumber: number
  startLine: number
  endLineExclusive: number
}

export function parseTaskSelection(selection: string): number[] {
  const trimmed = selection.trim().toLowerCase()
  if (trimmed === 'all') return []
  if (!trimmed) throw new Error(`Invalid task selection: ${selection}`)

  const selected = new Set<number>()
  for (const token of trimmed.split(',')) {
    const part = token.trim()
    if (!part) throw new Error(`Invalid task selection: ${selection}`)

    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0 || start > end) {
        throw new Error(`Invalid task selection: ${selection}`)
      }
      for (let n = start; n <= end; n++) selected.add(n)
      continue
    }

    const single = part.match(/^\d+$/)
    if (!single) throw new Error(`Invalid task selection: ${selection}`)
    const value = Number(part)
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid task selection: ${selection}`)
    selected.add(value)
  }

  return [...selected].sort((a, b) => a - b)
}

function findTaskBlocks(lines: string[]): TaskBlock[] {
  // 三级识别（2026-10-09 去格式约定化）：
  //   1. ### Task N / ### Wave N / ### 任务 N —— 显式编号，taskNumber = N；
  //   2. 任意 ## / ### 标题分块 —— 按出现顺序编号 1..n，只收块内含 checkbox 的
  //      （「## 需求提炼」这类非任务标题自然被跳过）；
  //   3. 无标题 —— 整篇当一个块（含 checkbox 时）。
  //
  // 为什么容错而非要求格式：markdown 任务清单的通行写法就是裸 `- [ ]`
  // （GitHub task list；claude-code 系插件同样用 .llm/todo.md 的裸 checkbox），
  // 没有实现对标题形态提要求。把格式约束推给提示词，等于让「怎么写都该能闭环」
  // 变成「模型必须背格式」——分发给终端用户时尤其不可取。
  const numbered = findNumberedBlocks(lines)
  if (numbered.length > 0) return numbered
  const headed = findHeadedBlocks(lines)
  if (headed.length > 0) return headed
  return findWholeDocumentBlock(lines)
}

/** 显式编号标题分块（既有语义，行为不变）。 */
function findNumberedBlocks(lines: string[]): TaskBlock[] {
  const blocks: TaskBlock[] = []
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const match = lines[i]!.match(/^###\s+(?:Task|Wave|任务)\s+(\d+)\b/)
    if (!match) continue
    if (blocks.length > 0) {
      blocks[blocks.length - 1]!.endLineExclusive = i
    }
    blocks.push({ taskNumber: Number(match[1]), startLine: i, endLineExclusive: lines.length })
  }
  return blocks
}

/** 兜底一：任意 ## / ### 标题分块，仅保留块内含 checkbox 的段。 */
function findHeadedBlocks(lines: string[]): TaskBlock[] {
  const fenceMask = computeFenceMask(lines)
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue
    if (/^#{2,3}\s+\S/.test(lines[i]!)) starts.push(i)
  }

  const blocks: TaskBlock[] = []
  for (const [index, start] of starts.entries()) {
    const end = index + 1 < starts.length ? starts[index + 1]! : lines.length
    if (!hasCheckbox(lines, fenceMask, start, end)) continue
    blocks.push({ taskNumber: blocks.length + 1, startLine: start, endLineExclusive: end })
  }
  return blocks
}

/** 兜底二：无标题时整篇单块（含 checkbox 才成立）。 */
function findWholeDocumentBlock(lines: string[]): TaskBlock[] {
  const fenceMask = computeFenceMask(lines)
  return hasCheckbox(lines, fenceMask, 0, lines.length)
    ? [{ taskNumber: 1, startLine: 0, endLineExclusive: lines.length }]
    : []
}

function hasCheckbox(lines: string[], fenceMask: boolean[], start: number, endExclusive: number): boolean {
  for (let i = start; i < endExclusive; i++) {
    if (fenceMask[i]) continue
    if (/^\s*- \[[ xX]\]/.test(lines[i]!)) return true
  }
  return false
}

function computeFenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false)
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) {
      mask[i] = true
      inFence = !inFence
      continue
    }
    mask[i] = inFence
  }

  return mask
}

function restoreTrailingNewline(lines: string[], hasTrailingNewline: boolean): string {
  const content = lines.join('\n')
  return hasTrailingNewline ? `${content}\n` : content
}

function formatTaskLabel(tasks: string, selected: number[], allTaskNumbers: number[]): string {
  const numbers = tasks.trim().toLowerCase() === 'all' ? allTaskNumbers : selected
  if (numbers.length === 0) return 'Task 0'
  const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1)
  if (contiguous && numbers.length > 1) return `Task ${numbers[0]}-${numbers[numbers.length - 1]}`
  return `Task ${numbers.join(',')}`
}

function upsertExecutionStatus(lines: string[], statusLine: string): { lines: string[]; updated: boolean; inserted: boolean } {
  const fenceMask = computeFenceMask(lines)
  const existingIndex = lines.findIndex((line, index) => !fenceMask[index] && line.startsWith('**执行状态：**'))
  if (existingIndex >= 0) {
    const next = [...lines]
    next[existingIndex] = statusLine
    return { lines: next, updated: true, inserted: false }
  }

  const techIndex = lines.findIndex((line, index) => !fenceMask[index] && line.startsWith('**技术栈：**'))
  if (techIndex >= 0) {
    const insertAt = lines.findIndex((line, index) => index > techIndex && line.trim() === '')
    const target = insertAt >= 0 ? insertAt : techIndex + 1
    const next = [...lines]
    next.splice(target, 0, '', statusLine)
    return { lines: next, updated: false, inserted: true }
  }

  const next = [...lines]
  next.splice(1, 0, '', statusLine)
  return { lines: next, updated: false, inserted: true }
}

function upsertExecutionClosure(lines: string[], closure: string[]): { lines: string[]; updated: boolean; inserted: boolean } {
  const fenceMask = computeFenceMask(lines)
  const headingIndex = lines.findIndex((line, index) => !fenceMask[index] && /^##\s+7\.\s+Execution\s+(handoff|closure)\b/.test(line))
  if (headingIndex >= 0) {
    return { lines: [...lines.slice(0, headingIndex), ...closure], updated: true, inserted: false }
  }

  const next = [...lines]
  while (next.length > 0 && next[next.length - 1]!.trim() === '') next.pop()
  next.push('', ...closure)
  return { lines: next, updated: false, inserted: true }
}

function buildClosure(taskLabel: string, options: PlanCloseOptions): string[] {
  const lines = [
    '## 7. Execution closure',
    '',
    `已闭环：${taskLabel} 均已完成并通过验证。`,
    '',
  ]

  const verifiedCommands = options.verifiedCommands ?? []
  if (verifiedCommands.length > 0) {
    lines.push('最终验证记录：', '', '```bash', ...verifiedCommands, '```')
  } else {
    lines.push('最终验证记录：本次未传入显式验证命令。')
  }

  if (options.deliveryState) {
    lines.push('', `交付门检查：${options.deliveryState}。`)
  }

  if (options.note?.trim()) {
    lines.push('', `备注：${options.note.trim()}`)
  }

  return lines
}

export function closePlanMarkdown(markdown: string, options: PlanCloseOptions): PlanCloseResult {
  const hasTrailingNewline = markdown.endsWith('\n')
  const lines = hasTrailingNewline ? markdown.slice(0, -1).split('\n') : markdown.split('\n')
  const fenceMask = computeFenceMask(lines)
  const blocks = findTaskBlocks(lines)
  const selected = parseTaskSelection(options.tasks)
  const selectedSet = selected.length > 0 ? new Set(selected) : new Set(blocks.map(b => b.taskNumber))
  const targetBlocks = blocks.filter(block => selectedSet.has(block.taskNumber))

  if (targetBlocks.length === 0) {
    throw new Error(`No matching task blocks found for selection: ${options.tasks}`)
  }

  const nextLines = [...lines]
  const changes: PlanCloseChange[] = []

  for (const block of targetBlocks) {
    let checkboxCount = 0
    let changedCheckboxCount = 0
    for (let i = block.startLine; i < block.endLineExclusive; i++) {
      if (fenceMask[i]) continue
      const line = nextLines[i]!
      if (/^\s*- \[[ xX]\]/.test(line)) checkboxCount++
      if (/^(\s*- \[) \](.*)$/.test(line)) {
        nextLines[i] = line.replace(/^(\s*- \[) \](.*)$/, '$1x]$2')
        changedCheckboxCount++
      }
    }
    changes.push({ taskNumber: block.taskNumber, checkboxCount, changedCheckboxCount })
  }

  let finalLines = nextLines
  let closureInserted = false
  let closureUpdated = false
  const updateClosure = options.updateClosure !== false
  if (updateClosure) {
    const allTaskNumbers = blocks.map(block => block.taskNumber).sort((a, b) => a - b)
    const taskLabel = formatTaskLabel(options.tasks, selected, allTaskNumbers)
    const statusLine = `**执行状态：** 已闭环。${taskLabel} 均已完成；验证通过${options.deliveryState ? `；交付门检查：${options.deliveryState}` : ''}。`
    const statusResult = upsertExecutionStatus(finalLines, statusLine)
    finalLines = statusResult.lines
    const closureResult = upsertExecutionClosure(finalLines, buildClosure(taskLabel, options))
    finalLines = closureResult.lines
    closureInserted = closureResult.inserted
    closureUpdated = closureResult.updated
  }

  return {
    content: restoreTrailingNewline(finalLines, hasTrailingNewline),
    changes,
    totalChangedCheckboxes: changes.reduce((sum, change) => sum + change.changedCheckboxCount, 0),
    alreadyClosed: changes.every(change => change.changedCheckboxCount === 0),
    closureInserted,
    closureUpdated,
  }
}

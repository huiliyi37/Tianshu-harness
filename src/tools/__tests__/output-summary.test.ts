import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractSmartSummary, renderSmartSummary, type SmartSummaryOptions } from '../output-summary.js'

function makeBigOutput(errorAtChar?: number, total = 40_000): string {
  // 每行 100 字符，构造 errorAtChar 处为错误行的文本
  const line = 'y'.repeat(98)
  const lines: string[] = []
  let pos = 0
  for (let i = 0; pos < total; i++) {
    const isErrLine = errorAtChar !== undefined && pos <= errorAtChar && errorAtChar < pos + 100
    lines.push(isErrLine ? `ERROR_MARKER_${i} ` + line.slice(0, 86) : line)
    pos += 100
  }
  return lines.join('\n')
}

describe('extractSmartSummary', () => {
  it('anchors an error in the middle of a big output (the truncation blind spot)', () => {
    const full = makeBigOutput(10_000) // 错误在 10KB 处（中部）
    const s = extractSmartSummary(full, { headBytes: 6 * 1024, anchorBytes: 10 * 1024, tailBytes: 8 * 1024 })
    assert.ok(s.anchors.length >= 1, '中部错误应命中锚段')
    assert.ok(s.anchors[0]!.snippet.includes('ERROR_MARKER'), '锚段应含错误行文本')
    assert.ok(s.anchorLines.length >= 1, '应返回锚行号供提示')
    assert.ok(s.middleOmitted, '大输出应标注中段省略')
  })

  it('keeps the head of the output (command echo / first results)', () => {
    const full = makeBigOutput(30_000) // 错误在尾部附近
    const s = extractSmartSummary(full, { headBytes: 6 * 1024, anchorBytes: 10 * 1024, tailBytes: 8 * 1024 })
    assert.ok(s.head.length > 0)
    assert.ok(s.head.startsWith('y'), 'head 应来自输出开头')
    assert.ok(s.head.length <= 6 * 1024 + 200, 'head 预算不超（行尾容差）')
  })

  it('keeps the tail of the output', () => {
    const full = makeBigOutput(39_500)
    const s = extractSmartSummary(full)
    assert.ok(s.tail.length > 0, 'tail 应有内容')
    assert.ok(s.tail.includes('ERROR_MARKER') || s.anchors.some(a => a.snippet.includes('ERROR_MARKER')), '尾部错误经 tail 或 anchors 可见')
  })

  it('merges dense anchors and caps total budget', () => {
    // 锚密集：每 2KB 一个错误行 → 锚段应合并且总预算不超
    const lines: string[] = []
    for (let i = 0; i < 400; i++) {
      lines.push(i % 20 === 0 ? `ERROR_${i}` : 'y'.repeat(98))
    }
    const full = lines.join('\n')
    const s = extractSmartSummary(full)
    const totalVisible = s.head.length + s.anchors.reduce((n, a) => n + a.snippet.length, 0) + s.tail.length
    assert.ok(totalVisible <= 24 * 1024 + 2000, `预算恒等：可见总量 ${totalVisible} ≤ 24KB+容差`)
    assert.ok(s.anchors.length >= 1)
  })

  it('returns no anchors for clean output and omits nothing below threshold', () => {
    const small = 'clean output\n'.repeat(10)
    const s = extractSmartSummary(small)
    assert.equal(s.anchors.length, 0)
    assert.equal(s.middleOmitted, false)
    assert.equal(s.head + s.tail, small, '小输出应原样保留（head+tail 无重叠 = 全文）')
  })

  it('line-level anchor matching avoids huge-line budget blowup', () => {
    // 一行 50KB 且含 error——行级匹配不应把整行吞进锚段
    const hugeLine = 'x'.repeat(50_000) + ' ERROR ' + 'x'.repeat(5_000)
    const full = hugeLine + '\n' + 'y'.repeat(100)
    const s = extractSmartSummary(full)
    const anchorTotal = s.anchors.reduce((n, a) => n + a.snippet.length, 0)
    assert.ok(anchorTotal <= 12 * 1024, `锚段预算防爆：${anchorTotal} ≤ 12KB`)
  })

  it('honors explicit budget options', () => {
    const full = makeBigOutput(10_000)
    const s = extractSmartSummary(full, { headBytes: 1024, anchorBytes: 2048, tailBytes: 1024 })
    assert.ok(s.head.length <= 1024 + 200)
    assert.ok(s.tail.length <= 1024 + 200)
    const anchorTotal = s.anchors.reduce((n, a) => n + a.snippet.length, 0)
    assert.ok(anchorTotal <= 2048 + 200)
  })

  it('P0-2 回归：失败型大单行（at …( 凑不出 :数字:数字)）不触发灾难性回溯', () => {
    // 旧 ANCHOR_RE `at .+\(.+:\d+:\d+\)` 在此输入上超二次方回溯（实测 96KB >60s 阻塞
    // 事件循环，bash.ts buildResult 同步路径 → TUI/桌面冻结）。修复后应线性返回、不产锚。
    // 注意：同步阻塞下 node:test 的 timeout 选项无效（定时器等不到事件循环），回归红灯
    // 形态是挂死——靠测试运行器全局超时兜底，故不加 timeout 选项。
    const hugeLine = 'at fn(xyyyy '.repeat(8000) // ≈86KB 无换行单行
    const s = extractSmartSummary(hugeLine)
    assert.equal(s.anchors.length, 0, '失败型单行不应产锚')
    assert.equal(s.middleOmitted, true, '超预算大行应标注中段省略')
  })

  it('middleOmitted 仅在真有中段 gap 时为 true——head+锚无缝覆盖全文则 false（P1-3）', () => {
    // 旧判据 `tailStart > headLines || (spans.length > 0 && tailStart > 0)` 在
    // head+锚段无缝覆盖全文（无 tail，末行即锚）时误报 true（tailStart=n > headLines）。
    // 构造：head 预算覆盖到首锚前一行的字节内（headLines=span.start），末行是错误
    // 行（span 延伸到文件尾）→ head [0..499) + span [499..500] 无缝，tail 空。
    const lines: string[] = []
    for (let i = 0; i < 500; i++) lines.push('yy' + i) // ≈3KB < 6KB head 预算
    lines.push('ERROR at very end') // L501（0-based 500）：锚段延伸到文件末
    const s = extractSmartSummary(lines.join('\n'))
    assert.ok(s.anchors.length >= 1, '末行错误应命中锚段')
    assert.equal(s.middleOmitted, false, 'head+锚段无缝覆盖全文（无 tail）时不应标省略')
    // 对照：中间确实有悬空行时应标 true
    const gappy = extractSmartSummary('clean\n'.repeat(50) + 'ERROR mid\n' + 'clean\n'.repeat(50), {
      headBytes: 128, anchorBytes: 4096, tailBytes: 128,
    })
    assert.equal(gappy.middleOmitted, true, 'head/锚/tail 之间有悬空行时应标省略')
  })

  it('renderSmartSummary 输出锚行号索引与锚段标注（P1-3 3d：此前零覆盖）', () => {
    const full = 'y'.repeat(98) + '\nERROR_MARKER\n' + 'y'.repeat(98)
    const s = extractSmartSummary(full)
    assert.ok(s.anchorLines.length >= 1)
    const out = renderSmartSummary(s, full.length)
    assert.match(out, /error anchors @raw 行 \d+/, '应输出锚行号索引')
    assert.match(out, /──── anchor @raw L\d+ ────/, '应输出锚段标注')
    assert.ok(out.includes('ERROR_MARKER'), '锚段应含错误行文本')
  })
})

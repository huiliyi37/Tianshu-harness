/**
 * Architecture guards — CI-level source-code pattern scanning.
 *
 * Turns design constraints into red/green tests. Inspired by grok-build's
 * guard.rs (compile-time API ban via test scan).
 *
 * Each guard scans src/ for forbidden patterns. When a new violation is
 * introduced, the test fails with a clear message pointing to the file.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { MAX_LINES_BASELINE, MAX_LINES_REDLINE, countPhysicalLines } from '../agent/structure-gate.js'

const SRC_ROOT = join(process.cwd(), 'src')

/**
 * POSIX 形式路径——所有比较与展示都走它。
 *
 * Windows 上 join()/relative() 产出反斜杠，而 guard 的白名单与排除规则用的是
 * POSIX 字面量（'/tui/engine/'、'/__tests__/'）：includes 判定会静默全落空，
 * 导致白名单失效、测试文件不被排除、报告输出反斜杠路径——guard 在 Windows 上
 * 形同虚设（Linux CI 正常，本机假红）。比较前一律归一化。
 */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/** Recursively collect .ts files under a directory. */
function collectTsFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, results)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

interface Violation {
  file: string
  line: number
  content: string
}

/**
 * Scan one file's lines for a forbidden pattern, skipping comment lines
 * (`//`, `/*`, and `*` block-comment continuations). Pure — exported into the
 * self-check below so the skip logic can never silently short-circuit again
 * (the original `startsWith('')` typo made every line skip and the guard
 * scanned nothing for its whole life).
 */
function scanLines(lines: string[], pattern: RegExp): Array<{ line: number; content: string }> {
  const hits: Array<{ line: number; content: string }> = []
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    if (pattern.test(line)) {
      hits.push({ line: i + 1, content: trimmed })
    }
  })
  return hits
}

/** Scan for a regex pattern across source files, returning violations. */
function scanPattern(
  files: string[],
  pattern: RegExp,
  whitelist: string[] = [],
): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    if (whitelist.some(w => toPosix(file).includes(w))) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const hit of scanLines(lines, pattern)) {
      violations.push({ file: toPosix(relative(SRC_ROOT, file)), ...hit })
    }
  }
  return violations
}

const allSrcFiles = collectTsFiles(SRC_ROOT)

// —— max-lines 棘轮 ——
// 基线表与红线值住在 src/agent/structure-gate.ts（deliver_task 的 YELLOW
// 预警门共用同一张表）；本测试是硬门：超限即红。语义详见该模块 JSDoc。

describe('architecture guards', () => {
  test('guards actually scan (self-check: skip logic and corpus are live)', () => {
    // 回归自检：曾因 startsWith('') 恒真导致每行被跳过，guard 全程空扫。
    // 植入violation必须被抓到；注释行必须被跳过；语料必须非空。
    const planted = scanLines(['const x = process.stdout.write("boom")'], /process\.stdout\.write\s*\(/)
    assert.equal(planted.length, 1, 'scanLines must catch a planted violation (empty-scan regression)')
    const commented = scanLines(
      ['// process.stdout.write("a")', '* process.stdout.write("b")', '/* process.stdout.write("c") */'],
      /process\.stdout\.write\s*\(/,
    )
    assert.equal(commented.length, 0, 'comment lines must be skipped, nothing else')
    assert.ok(allSrcFiles.length > 100, `src corpus suspiciously small: ${allSrcFiles.length} files`)
  })

  test('no direct process.stdout.write outside LiveEngine', () => {
    // 白名单：/tui/engine/ 是渲染回路的唯一合法直写层；cli/、headless.ts、worker-process/child.ts（NDJSON 协议通道，非渲染）,
    // main.ts 是无 LiveEngine 竞争的进程入口面（banner/错误/非 TUI 子命令）。
    // TUI 运行态内的直写（如曾经的 slash-commands /clear）一律违规。
    const whitelist = ['/tui/engine/', '/__tests__/', '/cli/', 'src/headless.ts', 'src/main.ts', 'src/agent/worker-process/child.ts']
    const scanned = allSrcFiles.filter(f => !whitelist.some(w => toPosix(f).includes(w)))
    assert.ok(scanned.length > 0, 'guard corpus empty after whitelist — guard would scan nothing')
    const violations = scanPattern(
      allSrcFiles,
      /process\.stdout\.write\s*\(/,
      whitelist,
    )
    assert.equal(
      violations.length,
      0,
      `Found ${violations.length} direct process.stdout.write call(s) outside LiveEngine:\n` +
        violations.map(v => `  ${v.file}:${v.line}`).join('\n'),
    )
  })

  test('spawn calls without windowsHide (threshold check)', () => {
    // Best-effort scan: flag spawn-family calls that lack windowsHide:true
    // in the ±10-line window around the call. Allows detached+stdio:ignore.
    //
    // 口径覆盖整个 spawn 家族（spawn/spawnSync/exec/execSync/execFile/
    // execFileSync）——它们共用同一套 windowsHide 选项，只扫 spawn/spawnSync
    // 会漏掉一半（本 guard 曾因此把 baseline 低估为 25）。
    //
    // 四道去噪，每道都由一次实测误报驱动：
    // ① 只扫引用过 child_process 的文件——同名局部变量与模式字符串不是调用；
    // ② 标识符前的引号排除——`'execSync('` 这类字符串字面量曾被命中；
    // ③ 多行方法定义排除——接口里的 `spawn(\n  command: string,\n)` 不是调用；
    // ④ 窗口向前后各看 10 行——windowsHide 可能经变量传入（spawn-git 的 mergedOpts）。
    const CALL_RE = /(?:^|[^\w."`])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/
    const METHOD_SIG_RE = /\(\s*\w+\s*:\s*[\w<{[]/
    // 平台专用豁免：文件内全部 spawn 目标都是 Windows 上不存在的命令
    // （osascript / pbcopy / screencapture），不可能产生控制台窗口。
    // 登记标准严格——跨平台命令（node/git/npm/where/reg/taskkill/soffice）
    // 一律不豁免，新增调用点自己带 windowsHide，而不是往这里加名字。
    const PLATFORM_SPECIFIC = ['src/pro/computer-use/macos-driver.ts']
    const guardFiles = allSrcFiles.filter(f => {
      const p = toPosix(f)
      if (p.includes('/__tests__/')) return false
      return !PLATFORM_SPECIFIC.some(x => p.endsWith(x))
    })
    assert.ok(guardFiles.length > 0, 'spawn guard corpus empty — guard would scan nothing')
    const violations: Violation[] = []
    let scanned = 0
    for (const file of guardFiles) {
      const content = readFileSync(file, 'utf8')
      // ① 只扫引用 child_process 的文件。guard 守的是 child_process 调用；
      //    tui/engine/app.ts 的 `exec` 局部回调、agent/security-patterns.ts 的
      //    模式字符串都只是重名，不构成闪窗风险。
      if (!/['"](?:node:)?child_process['"]/.test(content)) continue
      scanned++
      const lines = content.split('\n')
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
        if (trimmed.includes('import ')) return
        if (!CALL_RE.test(trimmed)) return
        // ③ 方法定义形如 `spawn(\n  command: string,\n): X` —— 不是调用
        if (METHOD_SIG_RE.test(lines.slice(i, Math.min(i + 3, lines.length)).join(' '))) return
        // ④ 前后各 10 行：windowsHide 可能在调用点之前定义（spawn-git 的 mergedOpts）
        const window = lines.slice(Math.max(0, i - 10), Math.min(i + 10, lines.length)).join('\n')
        const hasHide = /windowsHide\s*:\s*true/.test(window)
        const isDetachedIgnore = /detached\s*:\s*true/.test(window) && /stdio.*ignore/.test(window)
        if (!hasHide && !isDetachedIgnore) {
          violations.push({ file: toPosix(relative(SRC_ROOT, file)), line: i + 1, content: trimmed })
        }
      })
    }
    assert.ok(scanned > 20, `spawn guard: only ${scanned} file(s) reference child_process — corpus suspiciously small`)
    // Baseline 0：全仓 spawn 家族调用点均已带 windowsHide（平台专用文件已豁免）。
    // 新增调用点时补 windowsHide: true——不要把这里改回阈值。
    assert.equal(
      violations.length,
      0,
      `Spawn guard: ${violations.length} spawn-family call(s) without windowsHide (baseline 0):\n` +
        violations.map(v => `  ${v.file}:${v.line}  ${v.content.slice(0, 80)}`).join('\n'),
    )
  })

  test('max-lines ratchet: named monoliths only shrink; other files stay under redline', () => {
    const baseline = new Map<string, number>(MAX_LINES_BASELINE)
    // 自检 1：基线不得指向已消失的文件（拆分/改名/删除时同 PR 更新基线表）。
    // 双环境兼容：公开仓无 src/pro（闭源不随 sync）——缺失条目跳过而非失败，
    // 与 checkStructureGate 主逻辑（content===null → continue）语义对齐。
    const ghosts = [...baseline.keys()].filter(p => !existsSync(join(process.cwd(), p)))
    for (const ghost of ghosts) baseline.delete(ghost)
    // 自检 2：守备语料非空（防再度空扫）。
    const productFiles = allSrcFiles.filter(f => !f.includes(`${sep}__tests__${sep}`))
    assert.ok(productFiles.length > 100, `max-lines corpus suspiciously small: ${productFiles.length} files`)

    const overCeiling: string[] = []
    const overRedline: string[] = []
    for (const file of productFiles) {
      const rel = relative(process.cwd(), file).split(sep).join('/')
      const lines = countPhysicalLines(readFileSync(file, 'utf8'))
      const ceiling = baseline.get(rel)
      if (ceiling !== undefined) {
        if (lines > ceiling) overCeiling.push(`  ${rel}: ${lines} 行 > ceiling ${ceiling}`)
      } else if (lines > MAX_LINES_REDLINE) {
        overRedline.push(`  ${rel}: ${lines} 行 > 红线 ${MAX_LINES_REDLINE}`)
      }
    }
    assert.equal(
      overCeiling.length,
      0,
      `点名巨石只降不升——沿接缝拆分，而不是继续膨胀；确需增长时在同一 PR 修改 MAX_LINES_BASELINE 并说明理由：\n` +
        overCeiling.join('\n'),
    )
    assert.equal(
      overRedline.length,
      0,
      `非基线文件超过 ${MAX_LINES_REDLINE} 行红线——新模块请按职责拆分；确属单一职责的大文件在同一 PR 加入 MAX_LINES_BASELINE 并说明理由：\n` +
        overRedline.join('\n'),
    )
  })
})

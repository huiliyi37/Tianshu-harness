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
const SCRIPTS_ROOT = join(process.cwd(), 'scripts')

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

/** 同 collectTsFiles，但收 `.js` / `.mjs`——scripts/ 下多为脚本（构建、运维、验收），
 *  只收 .ts 会整片漏掉。spawn 守卫用它把 scripts/ 纳入语料：issue #103 的遗漏正因
 *  只扫 src/，让 22 处调用点在无控制台宿主（mintty / Tauri GUI）下持续闪窗。 */
function collectScriptFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectScriptFiles(full, results)
    } else if (/\.(ts|js|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
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

// —— spawn 家族 windowsHide 守卫的可测内核 ——
// 逻辑抽成纯函数而不是内联进 test：守卫本身曾因 startsWith('') 恒真空扫一辈子，
// 那次教训补了 scanLines 自检；本次把匹配面从「原生名单」扩到「别名」，同样必须有
// 断言锁住匹配面，否则正则一退回就静默回到盲区。纯函数让匹配面可被 planted 用例直接打红。

/** spawn 家族原名——它们共用同一套 windowsHide 选项。 */
const SPAWN_FAMILY = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const

/**
 * 收集一个文件里「等价于直接调用 spawn 家族」的本地标识符。三类别名，每类都由一次实测漏报驱动：
 *
 * ① promisify 别名——`const execFileP = promisify(execFile)`。`execFileP(` 后面不是 `(`，
 *    原生名单匹配不到：曾让 25 处调用点整体绕过守卫，Windows 上每次刷新 git 上下文都闪一个
 *    控制台窗口（issue #103 残留）。声明形式不限定（const/let/var、带类型标注、`util.promisify`）
 *    ——形式匹配漏哪一类，盲区就从哪一类重开，每类都有 planted 用例。
 * ② child_process 导入别名——`import { execFile as ef }` / `const { execFile: ef } = require(...)`，
 *    此时 `promisify(ef)` 得到的名字同样等价于直调（参数不是家族原名，靠导入映射还原）。
 * ③ 跨文件别名——别名在 A 文件 promisify、在 B 文件调用时，B 文件根本没有 child_process 引用，
 *    会被下面的语料过滤整文件跳过。把全仓别名并集作为 externalAliases 传入、并在本文件的
 *    import 语句里核对，才能覆盖；核对 import 是为了避免与同名局部变量混淆。
 */
export function collectSpawnAliases(
  content: string,
  externalAliases: ReadonlySet<string> = new Set(),
): string[] {
  const aliases = new Set<string>()
  const isFamily = (name: string) => (SPAWN_FAMILY as readonly string[]).includes(name)
  // ② 导入别名：import { execFile as ef } / const { execFile: ef } = require(...)
  for (const m of content.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const spec = part.trim()
      if (!spec) continue
      const [orig, local] = spec.includes(' as ')
        ? spec.split(' as ').map(s => s.trim())
        : [spec, spec]
      if (orig && local && local !== orig && isFamily(orig)) aliases.add(local)
    }
  }
  for (const m of content.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require\(|import\()/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const spec = part.trim()
      if (!spec) continue
      const [orig, local] = spec.includes(':')
        ? spec.split(':').map(s => s.trim())
        : [spec, spec]
      if (orig && local && local !== orig && isFamily(orig)) aliases.add(local)
    }
  }
  // ① promisify 别名——参数可以是家族原名，也可以是上面收集到的导入别名
  for (const m of content.matchAll(
    /(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:[\w$.]+\.)?promisify\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)/g,
  )) {
    const arg = (m[2] ?? '').split('.').pop() ?? ''
    if (aliases.has(arg) || isFamily(arg)) aliases.add(m[1]!)
  }
  // ③ 跨文件别名
  for (const m of content.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const local = part.trim().split(' as ').pop()?.trim()
      if (local && externalAliases.has(local)) aliases.add(local)
    }
  }
  return [...aliases]
}

export interface SpawnCallSite {
  /** 1-based 行号 */
  line: number
  content: string
  /** ±10 行窗口内是否声明了 windowsHide: true */
  hasWindowsHide: boolean
}

/**
 * 扫出一个文件里所有 spawn 家族调用点。四道去噪，每道都由一次实测误报驱动：
 * ① 标识符前的引号排除——`'execSync('` 这类字符串字面量曾被命中；同一字符类也排除了
 *    点号，为避开 `re.exec(`（RegExp.prototype.exec）这类同名方法——代价是 `cp.exec(`
 *    这种命名空间化调用不在匹配面（当前语料无此写法，新增时需人工核对 windowsHide）；
 * ② 标识符后的 `(`——别名如 `execFileP(` 靠传进来的 aliases 补上；
 * ③ 多行方法定义排除——接口里的 `spawn(\n  command: string,\n)` 不是调用；
 * ④ 窗口向前后各看 10 行——windowsHide 可能经变量传入（spawn-git 的 mergedOpts）。
 *
 * 撤回了一条旧豁免：曾放行 `detached: true` + `stdio: 'ignore'`。但 Node 文档明确
 * detached 在 Windows 上让子进程「拥有自己的 console window」，本仓 2026-09-14 的
 * sidecar 事故（DETACHED 进程失去可继承的隐藏控制台 → 后代 spawn 弹可见窗口）也是
 * 同一机制——detached 不构成隐藏窗口的理由，且目标为 GUI 程序时 windowsHide 无害。
 */
export function scanSpawnCallSites(content: string, aliases: readonly string[] = []): SpawnCallSite[] {
  const METHOD_SIG_RE = /\(\s*\w+\s*:\s*[\w<{[]/
  const names = [...SPAWN_FAMILY, ...aliases].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, ch => '\\' + ch))
  const callRe = new RegExp('(?:^|[^\\w."`])(?:' + names.join('|') + ')\\s*\\(', '')
  const lines = content.split('\n')
  const sites: SpawnCallSite[] = []
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    if (trimmed.includes('import ')) return
    if (!callRe.test(trimmed)) return
    if (METHOD_SIG_RE.test(lines.slice(i, Math.min(i + 3, lines.length)).join(' '))) return
    const window = lines.slice(Math.max(0, i - 10), Math.min(i + 10, lines.length)).join('\n')
    sites.push({ line: i + 1, content: trimmed, hasWindowsHide: /windowsHide\s*:\s*true/.test(window) })
  })
  return sites
}

const allSrcFiles = collectTsFiles(SRC_ROOT)
/** spawn 守卫的第二份语料：scripts/ 下的 .ts/.js/.mjs（理由见 collectScriptFiles 的注释）。 */
const allScriptFiles = collectScriptFiles(SCRIPTS_ROOT)

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
    // in the ±10-line window around the call.
    //
    // 口径覆盖整个 spawn 家族（spawn/spawnSync/exec/execSync/execFile/
    // execFileSync）——它们共用同一套 windowsHide 选项，只扫 spawn/spawnSync
    // 会漏掉一半（本 guard 曾因此把 baseline 低估为 25）。
    //
    // 匹配面还包括「等价于直调」的三类别名（promisify 别名 / child_process 导入别名 /
    // 跨文件别名）：曾让 25 处调用点整体绕过本守卫，Windows 上每次刷新 git 上下文都闪一个
    // 控制台窗口（issue #103 残留）。识别规则与四道去噪住在 collectSpawnAliases /
    // scanSpawnCallSites——抽成纯函数就是为了让匹配面本身能被下一条 test 打红。
    //
    // 平台专用豁免：文件内全部 spawn 目标都是 Windows 上不存在的命令
    // （osascript / pbcopy / screencapture），不可能产生控制台窗口。
    // 登记标准严格——跨平台命令（node/git/npm/where/reg/taskkill/soffice）
    // 一律不豁免，新增调用点自己带 windowsHide，而不是往这里加名字。
    const PLATFORM_SPECIFIC = ['src/pro/computer-use/macos-driver.ts']
    const guardFiles = [...allSrcFiles, ...allScriptFiles].filter(f => {
      const p = toPosix(f)
      if (p.includes('/__tests__/')) return false
      return !PLATFORM_SPECIFIC.some(x => p.endsWith(x))
    })
    assert.ok(guardFiles.length > 0, 'spawn guard corpus empty — guard would scan nothing')

    // 跨文件别名并集：别名可能在 A 文件 promisify、在 B 文件调用（B 文件无 child_process 引用）。
    const aliasUniverse = new Set<string>()
    for (const file of guardFiles) {
      for (const alias of collectSpawnAliases(readFileSync(file, 'utf8'))) aliasUniverse.add(alias)
    }

    const violations: Violation[] = []
    let scanned = 0
    let callSites = 0
    for (const file of guardFiles) {
      const content = readFileSync(file, 'utf8')
      const aliases = collectSpawnAliases(content, aliasUniverse)
      // ① 只扫引用 child_process（或 import 了跨文件别名）的文件。guard 守的是
      //    child_process 调用；tui/engine/app.ts 的 `exec` 局部回调、
      //    agent/security-patterns.ts 的模式字符串都只是重名，不构成闪窗风险。
      if (!/['"](?:node:)?child_process['"]/.test(content) && aliases.length === 0) continue
      scanned++
      for (const site of scanSpawnCallSites(content, aliases)) {
        callSites++
        if (!site.hasWindowsHide) {
          violations.push({ file: toPosix(relative(process.cwd(), file)), line: site.line, content: site.content })
        }
      }
    }
    assert.ok(scanned > 20, `spawn guard: only ${scanned} file(s) reference child_process — corpus suspiciously small`)
    // 非空转自检：语料里必须真的存在被识别的调用点——别名识别一旦失效，这里先红，
    // 而不是等下一次 Windows 闪窗。匹配面本身由下一条 test 的 planted 用例锁住。
    assert.ok(callSites > 0, 'spawn guard matched no call sites — guard would pass vacuously')
    // Baseline 0：全仓 spawn 家族调用点（含别名）均已带 windowsHide（平台专用文件已豁免）。
    // 新增调用点时补 windowsHide: true——不要把这里改回阈值。
    assert.equal(
      violations.length,
      0,
      `Spawn guard: ${violations.length} spawn-family call(s) without windowsHide (baseline 0):\n` +
        violations.map(v => `  ${v.file}:${v.line}  ${v.content.slice(0, 80)}`).join('\n'),
    )
  })

  test('spawn guard self-check: aliased call sites are matched (planted violations must go red)', () => {
    // 守卫曾因 startsWith('') 恒真空扫一辈子，所以那次补了 scanLines 自检。本次把匹配面
    // 从原生名单扩到别名，同样要回答一句：这些写法真的会被扫到吗？下表每种写法都对应一次
    // 探针实测的漏报——任一类识别回退，这条 test 先红，而不是等下一次 Windows 闪窗。
    const cpImport = `import { execFile } from 'node:child_process'`
    const utilImport = `import { promisify } from 'node:util'`
    const call = (fn: string, opts = '{ cwd, timeout: 5000 }') => `${fn}('git', ['rev-parse', 'HEAD'], ${opts})`
    interface AliasCase { name: string; source: string; external?: string[]; aliases: string[] }
    const cases: AliasCase[] = [
      {
        name: 'const 别名（现网写法）',
        source: [cpImport, utilImport, `const execFileP = promisify(execFile)`, call('execFileP')].join('\n'),
        aliases: ['execFileP'],
      },
      {
        name: 'let 声明',
        source: [cpImport, utilImport, `let execFileP = promisify(execFile)`, call('execFileP')].join('\n'),
        aliases: ['execFileP'],
      },
      {
        name: '带类型标注',
        source: [cpImport, utilImport, `const execFileP: Probe = promisify(execFile)`, call('execFileP')].join('\n'),
        aliases: ['execFileP'],
      },
      {
        name: 'util.promisify',
        source: [cpImport, `import util from 'node:util'`, `const execFileP = util.promisify(execFile)`, call('execFileP')].join('\n'),
        aliases: ['execFileP'],
      },
      {
        name: 'import 别名后 promisify(ef)',
        source: [`import { execFile as ef } from 'node:child_process'`, utilImport, `const execFileP = promisify(ef)`, call('execFileP')].join('\n'),
        // ef 自身也在集合里：`ef(` 就是 child_process.execFile 的直调，必须覆盖；
        // execFileP 是它的 promisify 化产物（靠导入映射还原出参数是家族成员）。
        aliases: ['ef', 'execFileP'],
      },
      {
        name: '跨文件别名（本文件无 child_process 引用）',
        source: [`import { sharedExecP } from './lib.js'`, call('sharedExecP')].join('\n'),
        external: ['sharedExecP'],
        aliases: ['sharedExecP'],
      },
    ]
    for (const c of cases) {
      const aliases = collectSpawnAliases(c.source, new Set(c.external ?? []))
      assert.deepEqual(aliases.sort(), [...c.aliases].sort(), `别名识别漏了：${c.name}`)
      const sites = scanSpawnCallSites(c.source, aliases)
      assert.equal(sites.length, 1, `调用点匹配数不符：${c.name}`)
      assert.equal(sites[0]?.hasWindowsHide, false, `应判定为缺 windowsHide：${c.name}`)
    }

    // 另一侧误报：带了 windowsHide 的别名调用点不得报违例；注释里的调用不算调用。
    const okSource = [
      cpImport,
      utilImport,
      `const execFileP = promisify(execFile)`,
      `// ${call('execFileP')}`,
      call('execFileP', '{ cwd, windowsHide: true }'),
    ].join('\n')
    const okSites = scanSpawnCallSites(okSource, collectSpawnAliases(okSource))
    assert.equal(okSites.length, 1, '注释行不得计入调用点')
    assert.equal(okSites[0]?.hasWindowsHide, true, '带 windowsHide 的调用点不应报违例')
    // 别名声明本身不是调用（跨文件导出场景下，库文件只有声明）。
    const libSource = [cpImport, utilImport, `export const sharedExecP = promisify(execFile)`].join('\n')
    assert.equal(scanSpawnCallSites(libSource, collectSpawnAliases(libSource)).length, 0, '别名声明不是调用点')
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

import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  detectProbes,
  extractWriteContent,
  scanFilesForProbes,
  formatProbeHits,
  isWhitelistedPath,
  type ProbeHit,
} from '../probe-detector.js'

describe('probe-detector', () => {
  describe('detectProbes', () => {
    it('detects console.log as probe', () => {
      const hits = detectProbes('console.log("debug")\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.pattern, 'console.log/debug/dir/trace')
      assert.match(hits[0]!.line, /console\.log/)
    })

    it('detects console.debug as probe', () => {
      const hits = detectProbes('console.debug(obj)\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
    })

    it('detects console.dir as probe', () => {
      const hits = detectProbes('console.dir(deepObj)\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
    })

    it('does NOT detect console.error (error channel is not a probe)', () => {
      const hits = detectProbes('console.error("oops")\n', 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('does NOT detect console.warn (warn channel is not a probe)', () => {
      const hits = detectProbes('console.warn("hmm")\n', 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('does NOT detect structured logger calls', () => {
      const content = 'logger.info("structured")\nthis.logger.debug("x")\nlog.trace("y")\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    // ── 台账 F2：三实例（2026-09-14）──────────────────────────────
    it('不误报：env 门控调试日志（if (__dbg) console.log 形态）', () => {
      const hits = detectProbes(
        'if (__dbg) console.log(`[createSession] +${Date.now() - __t0}ms id=${rec.id}`)\n',
        'src/server/session-routes.ts',
      )
      assert.equal(hits.length, 0, '门控调试日志随开关静默，不是遗留探针')
    })

    it('不误报：desktop/scripts 下的脚本正常输出', () => {
      const hits = detectProbes('console.log(`[check-mobile-wiring] OK — resources → ${dest}`)\n', 'desktop/scripts/check-mobile-wiring.js')
      assert.equal(hits.length, 0, 'CLI 脚本的 console.log 是用户可见输出')
    })

    it('不误报：文档（.md）正文中的 console 引用', () => {
      const hits = detectProbes('1. `src/server/session-routes.ts:399` 的 `if (__dbg) console.log(…)`\n', 'docs/tasks/x.md')
      assert.equal(hits.length, 0, '说明性文本不是可执行探针')
    })

    it('保真：裸 console.log 探针仍被捕获', () => {
      const hits = detectProbes('console.log("leftover probe")\n', 'src/agent/foo.ts')
      assert.equal(hits.length, 1)
    })

    it('detects debugger statement', () => {
      const hits = detectProbes('function foo() {\n  debugger\n  return 1\n}\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.pattern, 'debugger')
    })

    it('行内注释 / 块注释 / 字符串里提到的 debugger 不算探针（降误报）', () => {
      // `debugger` 在语法上只能作语句出现，因此它前面的最后一个非空白字符必然是
      // 语句边界（行首 / ; / { / } / ) / :）。此前只有 `\bdebugger\b` + 跳过**行首**
      // 注释行，于是行内注释与字符串里的提及被一律报成「探针残留」——交付时的乱报来源之一。
      assert.equal(detectProbes('const x = 1 // debugger\n', 'src/foo.ts').length, 0, '行内注释')
      assert.equal(detectProbes('foo() /* debugger */\n', 'src/foo.ts').length, 0, '块注释')
      assert.equal(detectProbes("const s = 'debugger'\n", 'src/foo.ts').length, 0, '字符串字面量')
      assert.equal(detectProbes('// 忘了删 debugger 的教训\n', 'src/foo.ts').length, 0, '中文注释')
      // 真语句仍须命中（不许为了降误报把检测能力削掉）
      assert.equal(detectProbes('  debugger\n', 'src/foo.ts').length, 1, '缩进语句')
      assert.equal(detectProbes('debugger;\n', 'src/foo.ts').length, 1, '带分号')
      assert.equal(detectProbes('if (x) debugger\n', 'src/foo.ts').length, 1, '单行 if 体')
      assert.equal(detectProbes('a(); debugger\n', 'src/foo.ts').length, 1, '分号后同行')
    })

    it('detects .only() test isolation', () => {
      const hits = detectProbes('it.only("test", () => {})\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.pattern, '.only() test isolation')
    })

    it('does NOT detect .only() on non-test functions', () => {
      const hits = detectProbes('obj.only = true\n', 'src/foo.ts')
      // obj.only = true should not match .only(
      assert.equal(hits.length, 0)
    })

    it('skips commented lines', () => {
      const content = '// console.log("commented")\n// debugger\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('skips block-comment continuation lines', () => {
      const content = ' * console.log("in block comment")\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('detects multiple probes in one content', () => {
      const content = 'console.log("a")\ndebugger\nconsole.dir(x)\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits.length, 3)
    })

    it('reports correct line numbers', () => {
      const content = 'const a = 1\nconst b = 2\nconsole.log("probe")\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits[0]!.lineNumber, 3)
    })

    it('detects bare assert() in production code', () => {
      const hits = detectProbes('assert(x > 0)\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.pattern, 'bare assert()')
    })

    it('does NOT detect assert in import assertion syntax', () => {
      const hits = detectProbes('import json from "./data.json" assert { type: "json" }\n', 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('does NOT detect console.assert (covered by console pattern)', () => {
      const hits = detectProbes('console.assert(x > 0)\n', 'src/foo.ts')
      // console.assert is NOT in CONSOLE_PROBE_RE (only log/debug/dir/trace),
      // and "console.assert" has a dot before assert so ASSERT_PROBE_RE won't match
      assert.equal(hits.length, 0)
    })
  })

  describe('isWhitelistedPath', () => {
    it('自指豁免是内容级、不是路径级：讨论探针的文件仍要检出真探针（2026-09-25 二修）', () => {
      // 二修动机：原实现把 src/prompt/static.ts 与 src/agent/probe-detector.ts 整文件
      // 进白名单（isWhitelistedPath 返回 true），换来「模式表/文案不误报」，代价是这两个
      // 真 .ts 里的**真探针一并漏检**——而检测器自身恰恰是最常被临时插桩调试的文件
      // （deliver_task 的 fs 重扫与 probe-tracking hook 两条通道会同时静默）。
      // 误报本来只是**行级**问题（模式名、警告文案里的枚举词），就该用行级判据解决。
      for (const f of ['src/prompt/static.ts', 'src/agent/probe-detector.ts']) {
        assert.equal(isWhitelistedPath(f), false, `${f} 不再整文件豁免`)
      }
      // 真探针（含被识别为「文本」的边界形态）必须检出
      assert.equal(detectProbes("  console.log('hits', hits)\n", 'src/agent/probe-detector.ts').length, 1)
      assert.equal(detectProbes('  debugger\n', 'src/prompt/static.ts').length, 1, '独立 debugger 语句')
      assert.equal(detectProbes('debugger;\n', 'src/prompt/static.ts').length, 1)
      assert.equal(detectProbes('assert(x === 1)\n', 'src/prompt/static.ts').length, 1)
      assert.equal(detectProbes("  it.only('x', () => {})\n", 'src/prompt/static.ts').length, 1)
      // 自指文本仍豁免（误报会诱导后来者删掉模式注册项 = 删掉检测能力）
      assert.deepEqual(detectProbes("  { name: 'debugger', re: DEBUGGER_RE },\n", 'src/agent/probe-detector.ts'), [])
      assert.deepEqual(detectProbes("  { name: 'bare assert()', re: ASSERT_PROBE_RE },\n", 'src/agent/probe-detector.ts'), [])
      assert.deepEqual(detectProbes('  临时探针（console.log、assert、debugger）修复后必须清理。\n', 'src/prompt/static.ts'), [])
      // 内容级豁免只对这两个文件生效——用**真探针**验证豁免不是全局的。
      // 注意：不能拿「临时探针（…、debugger）…」这类说明性行来验作用域了——
      // DEBUGGER_RE 收紧为语句位置判据后，该行在**任何文件**里都不再命中，
      // 断言会失去前提（2026-09-25）。
      assert.equal(detectProbes("  console.log('probe')\n", 'src/agent/foo.ts').length, 1, '非自指文件真探针命中')
      assert.equal(detectProbes('  debugger\n', 'src/agent/foo.ts').length, 1, '非自指文件真语句命中')
    })

    it('回归护栏：这两个文件的真实内容零命中（新增模式/文案时须同步豁免判据）', () => {
      // 这是本次二修的验收面：整文件豁免撤掉后，不能再有任何一行被误报——否则新版会比
      // 旧版更吵，同样会诱导去删模式注册项。文件内容演进（新增模式名、改警告文案）后
      // 若这条转红，说明 isSelfReferenceLine 的行级判据需要跟着扩，而不是把路径豁免加回去。
      const cwd = process.cwd()
      const read = (p: string): string | null => {
        try { return readFileSync(p, 'utf8') } catch { return null }
      }
      for (const f of ['src/agent/probe-detector.ts', 'src/prompt/static.ts']) {
        assert.deepEqual(scanFilesForProbes([f], cwd, read), [], `${f} 自身内容被检出——豁免判据需同步`)
      }
    })

    it('gate 的真实入口 scanFilesForProbes 同样走白名单（测函数 ≠ 测调用路径）', () => {
      // 缺口记录：前一版只测了 detectProbes，而 deliver-task gate 走的是
      // scanFilesForProbes（deliver-task.ts:1090）——它在循环开头自己也不扫白名单文件。
      // 只测纯函数会漏掉入口层的差异，所以两处都要覆盖。
      const cwd = process.cwd()
      const read = (p: string): string | null => {
        try { return readFileSync(p, 'utf8') } catch { return null }
      }
      assert.deepEqual(
        scanFilesForProbes(['src/agent/probe-detector.ts', 'src/prompt/static.ts'], cwd, read),
        [],
        'gate 入口对这两个文件不应产出命中',
      )
      // 对照：同一入口 + 非白名单路径 → 仍命中。没有它就无法排除「入口因为别的原因
      // 什么都扫不到」（readFile 抛错等），那会是一条假绿。
      const control = scanFilesForProbes(['src/agent/foo.ts'], cwd, () => '  debugger\n')
      assert.equal(control.length, 1, '非白名单路径走同一入口仍应命中')
    })
    it('whitelists test files', () => {
      assert.equal(isWhitelistedPath('src/agent/foo.test.ts'), true)
      assert.equal(isWhitelistedPath('src/agent/foo.spec.ts'), true)
    })

    it('whitelists scripts/ directory', () => {
      assert.equal(isWhitelistedPath('scripts/build.ts'), true)
    })

    it('whitelists bin/ directory', () => {
      assert.equal(isWhitelistedPath('bin/cli.ts'), true)
    })

    it('does NOT whitelist source files', () => {
      assert.equal(isWhitelistedPath('src/agent/loop.ts'), false)
    })

    it('绝对路径形态同样遵守白名单（gate 的 fs 重扫/模型传绝对路径时会走到）', () => {
      // 缺陷：normalized 只 strip 前导 `./`，于是 `/Users/x/repo/scripts/a.ts` 这种
      // 绝对形态 startsWith('scripts/') 为假 → **整张白名单同时失效**，scripts/、bin/、
      // *.test.ts、.md、serve.ts 里的 console.log/debugger 全被报成「探针残留」。
      // 表现为交付时被乱报，且报的内容与本次改动无关。
      const abs = (p: string): string => join(process.cwd(), p)
      for (const p of ['scripts/build.ts', 'desktop/scripts/a.js', 'bin/cli.ts', 'src/server/serve.ts', 'src/agent/foo.test.ts', 'docs/x.md']) {
        assert.equal(isWhitelistedPath(abs(p)), true, `绝对路径 ${p} 应豁免`)
        assert.equal(isWhitelistedPath(p), true, `相对路径 ${p} 应豁免（回归）`)
      }
      // 真源码的绝对路径不得被豁免
      assert.equal(isWhitelistedPath(abs('src/agent/foo.ts')), false, '非白名单源码不豁免')
      // 路径段边界：不许把 xscripts/ 当成 scripts/
      assert.equal(isWhitelistedPath('/tmp/xscripts/a.ts'), false, '前缀须落在路径段边界上')
    })

    it('gate 真实入口：绝对路径入参下白名单仍生效（测函数 ≠ 测调用路径）', () => {
      const cwd = process.cwd()
      const read = (): string => 'console.log("probe")\n'
      assert.equal(
        scanFilesForProbes([join(cwd, 'scripts/a.ts')], cwd, read).length,
        0,
        'scripts/ 的绝对路径不应产出命中（否则交付时乱报）',
      )
      assert.equal(
        scanFilesForProbes([join(cwd, 'src/a.ts')], cwd, read).length,
        1,
        '非白名单的绝对路径仍须命中——否则白名单被放宽成了漏检',
      )
    })
  })

  describe('detectProbes whitelist integration', () => {
    it('returns empty for whitelisted test files', () => {
      const hits = detectProbes('console.log("ok in test")\n', 'src/foo.test.ts')
      assert.equal(hits.length, 0)
    })

    it('returns empty for scripts/ directory', () => {
      const hits = detectProbes('console.log("cli output")\n', 'scripts/build.ts')
      assert.equal(hits.length, 0)
    })
  })

  describe('extractWriteContent', () => {
    it('extracts content from write_file', () => {
      const result = extractWriteContent('write_file', {
        file_path: 'src/foo.ts',
        content: 'console.log("x")\n',
      })
      assert.equal(result?.filePath, 'src/foo.ts')
      assert.match(result!.content, /console\.log/)
    })

    it('extracts new_string from edit_file', () => {
      const result = extractWriteContent('edit_file', {
        file_path: 'src/bar.ts',
        old_string: 'a',
        new_string: 'console.log("x")\n',
      })
      assert.equal(result?.filePath, 'src/bar.ts')
      assert.match(result!.content, /console\.log/)
    })

    it('extracts new_string from hash_edit', () => {
      const result = extractWriteContent('hash_edit', {
        file_path: 'src/baz.ts',
        anchors: ['L1:abc'],
        new_string: 'debugger\n',
      })
      assert.equal(result?.filePath, 'src/baz.ts')
      assert.match(result!.content, /debugger/)
    })

    it('returns null for read-only tools', () => {
      assert.equal(extractWriteContent('read_file', { file_path: 'src/foo.ts' }), null)
      assert.equal(extractWriteContent('grep', { pattern: 'foo' }), null)
    })

    it('returns null when file_path is missing', () => {
      assert.equal(extractWriteContent('write_file', { content: 'x' }), null)
    })

    it('returns null when content/new_string is not a string', () => {
      assert.equal(
        extractWriteContent('write_file', { file_path: 'x.ts', content: 123 }),
        null,
      )
    })
  })

  describe('scanFilesForProbes', () => {
    it('reads files from disk and detects probes', () => {
      const fakeFs = new Map<string, string>([
        ['/cwd/src/a.ts', 'console.log("probe")\n'],
        ['/cwd/src/b.ts', 'const x = 1\n'],
      ])
      // Windows 上实现侧 join('/cwd','src/a.ts') 产出反斜杠键；fakeFs 用 Unix 键——
      // reader 归一化两种分隔符（与实现侧 join 语义对齐，Linux 直配不受影响）。
      const reader = (p: string) => fakeFs.get(p) ?? fakeFs.get(p.replace(/\\/g, '/')) ?? null
      const hits = scanFilesForProbes(['src/a.ts', 'src/b.ts'], '/cwd', reader)
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.filePath, 'src/a.ts')
    })

    it('skips files that no longer exist (null from reader)', () => {
      const reader = (_: string): string | null => null
      const hits = scanFilesForProbes(['src/gone.ts'], '/cwd', reader)
      assert.equal(hits.length, 0)
    })

    it('skips whitelisted paths', () => {
      const fakeFs = new Map<string, string>([
        ['/cwd/src/foo.test.ts', 'console.log("ok")\n'],
      ])
      const reader = (p: string) => fakeFs.get(p) ?? null
      const hits = scanFilesForProbes(['src/foo.test.ts'], '/cwd', reader)
      assert.equal(hits.length, 0)
    })
  })

  describe('formatProbeHits', () => {
    it('returns empty array for no hits', () => {
      assert.deepEqual(formatProbeHits([]), [])
    })

    it('formats hits grouped by file', () => {
      const hits: ProbeHit[] = [
        { filePath: 'src/a.ts', pattern: 'console.log/debug/dir/trace', line: '  console.log("x")', lineNumber: 5 },
        { filePath: 'src/a.ts', pattern: 'debugger', line: '  debugger', lineNumber: 10 },
        { filePath: 'src/b.ts', pattern: '.only() test isolation', line: 'it.only("t",)', lineNumber: 1 },
      ]
      const lines = formatProbeHits(hits)
      assert.ok(lines.some(l => l.includes('src/a.ts')))
      assert.ok(lines.some(l => l.includes('src/b.ts')))
      assert.ok(lines.some(l => l.includes('L5')))
      assert.ok(lines.some(l => l.includes('L10')))
      assert.ok(lines.some(l => l.includes('清理探针')))
    })

    it('truncates to 3 hits per file', () => {
      const hits: ProbeHit[] = Array.from({ length: 5 }, (_, i) => ({
        filePath: 'src/a.ts',
        pattern: 'debugger',
        line: `  debugger // ${i}`,
        lineNumber: i + 1,
      }))
      const lines = formatProbeHits(hits)
      assert.ok(lines.some(l => l.includes('+2 more')))
    })
  })
})

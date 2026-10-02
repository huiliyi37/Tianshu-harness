/**
 * 装配断裂审计 — CI 级源码扫描测试。
 *
 * 防止「配置定义存在，但到真实消费点的链路断了」这类静默失效。
 * 每次 push 自动跑，新增断裂必须进 allowlist 并注明理由 + reviewDate。
 *
 * 检查项：
 * 1. StarDomain / ProfileDefinition 字段消费覆盖
 * 2. RuntimeHookDeps ↔ loop-factory 实参键集合 diff
 * 3. env 开关注册表双向 completeness
 * 4. sidecar 装配面可选依赖完备性（serve-agent.ts 与 TUI 的 parity 接线 + allowlist）
 *
 * 模式选择：
 * - 字段消费 → architecture-guards 正则扫描 + allowlist
 * - hook deps → plan-mode completeness 模式
 * - env 注册表 → plan-mode completeness 模式
 * - sidecar 装配 → 源码正则接线检查 + allowlist
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionStateManager } from '../agent/session-state.js'
import { buildDynamicAppendix } from '../prompt/volatile.js'

const SRC_ROOT = join(process.cwd(), 'src')

function collectTsFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      if (entry === '__tests__') continue
      collectTsFiles(full, results)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

/** 收集所有 .ts 文件（含测试），用于 env 注册表全量扫描 */
function collectAllTsFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      collectAllTsFiles(full, results)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

const allSrcFiles = collectTsFiles(SRC_ROOT)
/**
 * 路径分隔符归一化。
 *
 * `collectTsFiles` 用 `join()` 造路径，在 Windows 上给 `src\agent\foo.ts`、POSIX 上给
 * `src/agent/foo.ts`。下面凡是按路径**片段**做过滤/比较的地方（`'/__tests__/'`、
 * `'tui/'`）都必须先过这一层——否则在 Windows 上 `includes('/…')` 恒为 false，
 * 守卫会**静默失效**（不报错、只是不再守任何东西），把真回归放过去。
 */
const toPosix = (p: string): string => p.replace(/\\/g, '/')
const productionFiles = allSrcFiles.filter(f => !toPosix(f).includes('/__tests__/'))
const allFilesIncludingTests = collectAllTsFiles(SRC_ROOT)

// ── allowlist 条目 ──

interface AllowlistEntry {
  field: string
  source: string
  category: 'display-only' | 'INERT' | 'pending' | 'reserved'
  note: string
  reviewDate: string
}

const FIELD_ALLOWLIST: AllowlistEntry[] = [
  {
    field: 'decisionStyle',
    source: 'StarDomain',
    category: 'display-only',
    note: '仅 TUI 展示（main.ts commitStatic + slash-commands display），G3 已有设计讨论，待数据支撑后接线',
    reviewDate: '2027-01-22',
  },
  {
    field: 'uiPersona',
    source: 'StarDomain',
    category: 'display-only',
    note: '仅 TUI 渲染层消费（overlay/glance-bar/team-panel），非行为面字段',
    reviewDate: '2027-01-22',
  },
  {
    field: 'systemPromptSuffix',
    source: 'StarDomain',
    category: 'display-only',
    note: '行为注入由 volatileBlock 承载（冻结 <star-domain> 前缀，主循环与 worker 同源，volatile.ts:1027）；本字段仅桌面图鉴法则面板展示（desktop CouncilSurface）。若恢复注入属独立设计决策——辅的 volatileBlock 自述「suffix 定义你怎么做」与此现状有张力，发版后需决议（2026-07-27 审查记录）。',
    reviewDate: '2027-01-22',
  },
  {
    field: 'defaultKind',
    source: 'ProfileDefinition',
    category: 'pending',
    note: '仅 parser + 测试消费，零生产行为读取。待决策：接线或删除',
    reviewDate: '2027-01-22',
  },
  {
    field: 'llmSpeculation',
    source: 'AgentConfig',
    category: 'INERT',
    note: 'schema 接收但 loop-factory.ts:974-980 明确不构造引擎（SEALED），对齐 loop-factory 注释',
    reviewDate: '2027-01-22',
  },
]

// ── 检查项 1：字段消费覆盖扫描 ──

interface FieldAudit {
  field: string
  source: string
  excludeFiles: string[]
  consumers: string[]
}

function scanFieldConsumers(fieldName: string, excludeFiles: string[]): string[] {
  const consumers: string[] = []
  const dotPattern = new RegExp(`\\.${fieldName}\\b`)
  const bracketPattern = new RegExp(`\\[['"\`]${fieldName}['"\`]\\]`)
  for (const file of productionFiles) {
    if (excludeFiles.some(e => file.endsWith(e))) continue
    const content = readFileSync(file, 'utf8')
    if (dotPattern.test(content) || bracketPattern.test(content)) {
      consumers.push(relative(SRC_ROOT, file))
    }
  }
  return consumers
}

describe('assembly audit — field consumption coverage', () => {
  const starDomainFields: FieldAudit[] = [
    { field: 'id', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'name', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'motto', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'volatileBlock', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'decisionStyle', source: 'StarDomain', excludeFiles: ['star-domain.ts', 'star-domain-registry.ts'], consumers: [] },
    { field: 'courageThreshold', source: 'StarDomain', excludeFiles: ['star-domain.ts', 'star-domain-registry.ts'], consumers: [] },
    { field: 'keywords', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'isCustom', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'toolWhitelist', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'mainToolTier', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'systemPromptSuffix', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'uiPersona', source: 'StarDomain', excludeFiles: ['star-domain.ts', 'star-domain-registry.ts'], consumers: [] },
  ]

  const profileFields: FieldAudit[] = [
    { field: 'name', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'role', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'allowedTools', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'expertisePrompt', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'defaultKind', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'defaultMaxTokens', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'defaultTimeoutMs', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'builtIn', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'tierLock', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
  ]

  for (const f of [...starDomainFields, ...profileFields]) {
    f.consumers = scanFieldConsumers(f.field, f.excludeFiles)
  }

  test('all StarDomain fields have production consumers or are allowlisted', () => {
    const violations: string[] = []
    for (const f of starDomainFields) {
      if (f.consumers.length === 0) {
        const entry = FIELD_ALLOWLIST.find(e => e.field === f.field && e.source === f.source)
        if (!entry) {
          violations.push(`  ${f.source}.${f.field}: zero production consumers, not in allowlist`)
        }
      }
    }
    assert.equal(violations.length, 0,
      `StarDomain fields with zero production consumers (not allowlisted):\n${violations.join('\n')}`)
  })

  test('all ProfileDefinition fields have production consumers or are allowlisted', () => {
    const violations: string[] = []
    for (const f of profileFields) {
      if (f.consumers.length === 0) {
        const entry = FIELD_ALLOWLIST.find(e => e.field === f.field && e.source === f.source)
        if (!entry) {
          violations.push(`  ${f.source}.${f.field}: zero production consumers, not in allowlist`)
        }
      }
    }
    assert.equal(violations.length, 0,
      `ProfileDefinition fields with zero production consumers (not allowlisted):\n${violations.join('\n')}`)
  })

  test('allowlist entries are still in source interfaces (no stale entries)', () => {
    const allFields = new Set([
      ...starDomainFields.map(f => `${f.source}.${f.field}`),
      ...profileFields.map(f => `${f.source}.${f.field}`),
    ])
    const stale: string[] = []
    for (const entry of FIELD_ALLOWLIST) {
      if (entry.source === 'AgentConfig') continue
      if (!allFields.has(`${entry.source}.${entry.field}`)) {
        stale.push(`  ${entry.source}.${entry.field}: in allowlist but not found in source`)
      }
    }
    assert.equal(stale.length, 0,
      `Stale allowlist entries (field no longer exists in source):\n${stale.join('\n')}`)
  })

  test('allowlist entries have reviewDate within 12 months', () => {
    const now = new Date()
    const oneYear = 365 * 24 * 60 * 60 * 1000
    const expired: string[] = []
    for (const entry of FIELD_ALLOWLIST) {
      const date = new Date(entry.reviewDate)
      if (isNaN(date.getTime()) || date.getTime() < now.getTime() - oneYear) {
        expired.push(`  ${entry.source}.${entry.field}: reviewDate ${entry.reviewDate}`)
      }
    }
    assert.equal(expired.length, 0,
      `Allowlist entries with expired/invalid reviewDate:\n${expired.join('\n')}`)
  })

  test('allowlist size report (size growth is an alert signal)', () => {
    const byCategory: Record<string, number> = {}
    for (const entry of FIELD_ALLOWLIST) {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1
    }
    const report = Object.entries(byCategory)
      .map(([cat, count]) => `  ${cat}: ${count}`)
      .join('\n')
    console.log(`[assembly-audit] allowlist size: ${FIELD_ALLOWLIST.length}\n${report}`)
    assert.ok(FIELD_ALLOWLIST.length < 20,
      `allowlist has ${FIELD_ALLOWLIST.length} entries — review for audit effectiveness decay`)
  })

  test('decisionStyle: confirmed display-only (regression guard)', () => {
    // 归一化后再判——原实现写死 `f.includes('tui/')`，而 consumers 里的路径在
    // Windows 上是 `src\tui\slash-commands.ts`，过滤恒不生效 → 任何 TUI 消费者
    // 都被判成「非 TUI 消费者」，该守卫在 Windows 上恒红（与是否真违规无关）。
    const isTuiOrMain = (f: string): boolean => {
      const p = toPosix(f)
      return p.includes('tui/') || p.includes('main.ts')
    }
    const decisionStyleConsumers = starDomainFields
      .find(f => f.field === 'decisionStyle')!.consumers
      .filter(f => !isTuiOrMain(f))
    const expectedTuiOnly = decisionStyleConsumers.every(isTuiOrMain)
    assert.ok(expectedTuiOnly,
      `decisionStyle has non-TUI consumers — review whether behavioral wiring was intended:\n${decisionStyleConsumers.join('\n')}`)
  })
})

// ── 检查项 2：RuntimeHookDeps ↔ loop-factory 实参键 diff ──

describe('assembly audit — RuntimeHookDeps key diff', () => {
  const UNASSIGNED_OPTIONAL_ALLOWLIST = new Set([
    'chronicle',
    'getChronicleEntries',
    'onAntiAnchoringMCTSResult',
    'dedupGuardThreshold',
    'skillDistillDisabled',
  ])

  test('all RuntimeHookDeps optional keys are either assigned in loop-factory or allowlisted', () => {
    const depsSource = readFileSync(join(SRC_ROOT, 'agent', 'create-runtime-hooks.ts'), 'utf8')
    const optionalKeyPattern = /^\s{2}(\w+)\?(?::|:)/gm
    const optionalKeys: string[] = []
    let m
    while ((m = optionalKeyPattern.exec(depsSource)) !== null) {
      optionalKeys.push(m[1]!)
    }

    const factorySource = readFileSync(join(SRC_ROOT, 'agent', 'loop-factory.ts'), 'utf8')
    const pipelineCallIdx = factorySource.indexOf('createRuntimeHooksPipeline')
    if (pipelineCallIdx === -1) {
      assert.fail('Could not locate createRuntimeHooksPipeline call in loop-factory.ts')
    }
    const assignedKeyPattern = /^\s{4,8}(\w+):\s/gm
    const assignedKeys = new Set<string>()
    const EXCLUDED_KEYS = new Set([
      'lines', 'return', 'if', 'for', 'while', 'const', 'let', 'var',
      'try', 'catch', 'finally', 'switch', 'case', 'default', 'new',
      'else', 'break', 'continue', 'throw', 'assert', 'import', 'export',
      'error', 'parse', 'separator', 'accent', 'glyph', 'id', 'name',
    ])
    while ((m = assignedKeyPattern.exec(factorySource)) !== null) {
      const key = m[1]!
      if (key.length > 1 && !EXCLUDED_KEYS.has(key)) {
        assignedKeys.add(key)
      }
    }

    const unassigned = optionalKeys.filter(k => !assignedKeys.has(k) && !UNASSIGNED_OPTIONAL_ALLOWLIST.has(k))
    assert.equal(unassigned.length, 0,
      `RuntimeHookDeps optional keys not assigned in loop-factory (not allowlisted):\n${unassigned.map(k => `  ${k}`).join('\n')}\n\nAdd to UNASSIGNED_OPTIONAL_ALLOWLIST if intentional, or wire in loop-factory.`)
  })

  test('allowlisted unassigned deps still exist in RuntimeHookDeps interface', () => {
    const depsSource = readFileSync(join(SRC_ROOT, 'agent', 'create-runtime-hooks.ts'), 'utf8')
    const stale: string[] = []
    for (const key of UNASSIGNED_OPTIONAL_ALLOWLIST) {
      if (!depsSource.includes(key)) {
        stale.push(key)
      }
    }
    assert.equal(stale.length, 0,
      `Allowlisted deps no longer in RuntimeHookDeps (remove from allowlist):\n${stale.join('\n')}`)
  })

  test('getCourageThreshold getter references sessionDomain (not hardcoded dead value)', () => {
    // 回归哨兵：loop-factory.ts:554 的 getCourageThreshold getter 必须引用
    // self.sessionDomain?.courageThreshold。若有人改成 () => 0.5 之类的死 getter，
    // hook 级测试全绿但运行时域切换永远不生效——deps key diff 只保 key 存在不保语义。
    const factorySource = readFileSync(join(SRC_ROOT, 'agent', 'loop-factory.ts'), 'utf8')
    const pattern = /getCourageThreshold:\s*\(\s*\)\s*=>/
    const match = pattern.exec(factorySource)
    assert.ok(match, 'getCourageThreshold assignment not found in loop-factory.ts')
    const rest = factorySource.slice(match.index, match.index + 120)
    assert.ok(
      rest.includes('self.sessionDomain?.courageThreshold'),
      `getCourageThreshold getter must reference self.sessionDomain?.courageThreshold (not hardcoded dead value):\n  ${rest.slice(0, 100).trim()}`,
    )
  })
})

// ── 检查项 3：env 开关注册表双向 completeness ──

describe('assembly audit — env registry completeness', () => {
  /** 从文件集合中提取所有 RIVET_* 变量名（含间接引用模式） */
  function collectRivetVars(files: string[]): Set<string> {
    const vars = new Set<string>()
    const directPattern = /process\.env\.(RIVET_[A-Z_]+)/g
    // 括号形式（process.env['RIVET_X']）与点号形式同一语义。只认点号时，用括号
    // 写法的变量会反向命中「registry 有条目但源码无引用」的假红（2026-09-15
    // RIVET_SHADOW_CRITIC 实例）；生成器侧同款补齐。
    const bracketPattern = /process\.env\[\s*['"](RIVET_[A-Z_]+)['"]\s*\]/g
    const destructuredPattern = /\benv\.(RIVET_[A-Z_]+)\b/g
    const fnPattern = /\b(?:envInt|envStr|envBool)\s*\(\s*'(RIVET_[A-Z_]+)'\)/g

    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      for (const pattern of [directPattern, bracketPattern, destructuredPattern, fnPattern]) {
        let m
        while ((m = pattern.exec(content)) !== null) {
          vars.add(m[1]!)
        }
      }
    }
    return vars
  }

  test('collectRivetVars 识别括号形式的 process.env 引用（反证：旧实现下本用例会红）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-env-scan-'))
    try {
      // 样本刻意用**真实已登记的变量名**：本文件自身也在扫描范围内，若样本写
      // 自造名（RIVET_FOO），扫描器会把样本行当成真引用 → 「源码有但 registry 无」
      // 假红；反过来生成器又会把它登记进 registry（污染条目表）。用真名两头都干净。
      const sample = join(dir, 'sample.ts')
      writeFileSync(sample, [
        'const a = process.env.RIVET_DEBUG',
        "const b = process.env['RIVET_TERSE']",
        'if (process.env["RIVET_PLAYBOOK"] === "1") return',
        "const c = envInt('RIVET_MAX_WORKERS')",
      ].join('\n'))
      const vars = collectRivetVars([sample])
      assert.ok(vars.has('RIVET_DEBUG'), '点号形式')
      assert.ok(vars.has('RIVET_TERSE'), '单引号括号形式——旧实现漏识别，正是 RIVET_SHADOW_CRITIC 假红的成因')
      assert.ok(vars.has('RIVET_PLAYBOOK'), '双引号括号形式')
      assert.ok(vars.has('RIVET_MAX_WORKERS'), '辅助函数形式不被括号补齐影响')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('every RIVET_* in source code is in registry', () => {
    const codeVars = collectRivetVars(allFilesIncludingTests)

    let registryVars: Set<string>
    try {
      const regContent = readFileSync(join(SRC_ROOT, 'config', 'env-registry.ts'), 'utf8')
      registryVars = new Set<string>()
      const regPattern = /name:\s*'(RIVET_[A-Z_]+)'/g
      let rm
      while ((rm = regPattern.exec(regContent)) !== null) {
        registryVars.add(rm[1]!)
      }
    } catch {
      assert.fail('env-registry.ts not found — run: npx tsx scripts/gen-env-registry.ts')
      return
    }

    const missing = [...codeVars].filter(v => !registryVars.has(v)).sort()
    assert.equal(missing.length, 0,
      `RIVET_* variables in code but NOT in env-registry.ts:\n${missing.map(v => `  ${v}`).join('\n')}\n\nRun: npx tsx scripts/gen-env-registry.ts`)
  })

  test('every registry entry has a corresponding RIVET_* reference in source code', () => {
    const codeVars = collectRivetVars(allFilesIncludingTests)

    let registryVars: string[]
    let regContent: string
    try {
      regContent = readFileSync(join(SRC_ROOT, 'config', 'env-registry.ts'), 'utf8')
      registryVars = []
      const regPattern = /name:\s*'(RIVET_[A-Z_]+)'/g
      let rm
      while ((rm = regPattern.exec(regContent)) !== null) {
        registryVars.push(rm[1]!)
      }
    } catch {
      assert.fail('env-registry.ts not found')
      return
    }

    // pro 专属变量（files 指向 pro/ 的条目）在公开构建中天然无源码引用——
    // src/pro 不进公开仓；它们在 dev 仓（有 src/pro）已被本测试覆盖。
    const proScoped = new Set<string>()
    const entryPattern = /name:\s*'(RIVET_[A-Z_]+)'[\s\S]*?files:\s*\[([^\]]*)\]/g
    let em
    while ((em = entryPattern.exec(regContent)) !== null) {
      if (/(^|')pro\//.test(em[2]!)) proScoped.add(em[1]!)
    }

    const stale = registryVars.filter(v => !codeVars.has(v) && !proScoped.has(v)).sort()
    assert.equal(stale.length, 0,
      `Registry entries with no RIVET_* reference in source code (stale entries):\n${stale.map(v => `  ${v}`).join('\n')}\n\nRun: npx tsx scripts/gen-env-registry.ts`)
  })
})

// ── 检查项 4：sidecar 装配面可选依赖完备性 ──

interface SidecarWiringCheck {
  /** 被检查的可选依赖 */
  dependency: string
  /** 在 serve-agent.ts 中应当出现的接线形状 */
  pattern: RegExp
  /** 不接线的后果（断言失败信息） */
  consequence: string
}

const SIDECAR_WIRING_CHECKS: SidecarWiringCheck[] = [
  {
    dependency: 'refs.getImpactedTests',
    pattern: /refs\.getImpactedTests\s*=/,
    consequence: 'delivery-gate-v2.ts:330 的 moduleCoverage 分支在桌面端/插件上永不触发',
  },
  {
    dependency: 'injectDurableClaims(cwd)',
    pattern: /injectDurableClaims\(\s*claimStore\s*,\s*cwd\s*\)/,
    consequence: 'session-persist.ts:589 的跨项目污染门禁被整块跳过',
  },
]

/** 已知未接线、有意暂缓的 sidecar 依赖。与 FIELD_ALLOWLIST 同治理：note + reviewDate。 */
const SIDECAR_WIRING_ALLOWLIST: AllowlistEntry[] = [
  {
    field: 'MeridianIndexer.stigmergy',
    source: 'serve-agent.getOrCreateMeridianIndexer',
    category: 'pending',
    note: 'getOrCreateMeridianIndexer 是 per-cwd 共享工厂（同 cwd 多 session 共享一个实例），而 stigmergy 是 session 级——直接传参会让 A 会话的信息素污染 B 会话的文件排序。这是作用域不匹配，不是漏传。待决策：把 stigmergy 改为 getFileBoost 调用时传参，或删除 meridian-behavior.ts 的 pheromone 支路（weights.pheromone=0.2 至今零贡献）。',
    reviewDate: '2027-02-01',
  },
]

describe('assembly audit — sidecar wiring completeness', () => {
  const serveAgentSource = readFileSync(join(SRC_ROOT, 'server', 'serve-agent.ts'), 'utf8')

  test('all TUI-parity optional deps are wired on the sidecar path', () => {
    const missing = SIDECAR_WIRING_CHECKS
      .filter(c => !c.pattern.test(serveAgentSource))
      .map(c => `  ${c.dependency}: ${c.consequence}`)
    assert.equal(missing.length, 0,
      `sidecar 装配面漏传（桌面端与 VS Code 插件走这条路，静默降级不报错）:\n${missing.join('\n')}`)
  })

  test('sidecar allowlist entries have reviewDate within 12 months', () => {
    const now = Date.now()
    const oneYear = 365 * 24 * 60 * 60 * 1000
    const expired = SIDECAR_WIRING_ALLOWLIST
      .filter(e => { const d = new Date(e.reviewDate).getTime(); return isNaN(d) || d < now - oneYear })
      .map(e => `  ${e.source}.${e.field}: ${e.reviewDate}`)
    assert.equal(expired.length, 0, `过期的 sidecar allowlist 条目:\n${expired.join('\n')}`)
  })

  test('sidecar allowlist size report (growth is an alert signal)', () => {
    console.log(`[assembly-audit] sidecar wiring allowlist size: ${SIDECAR_WIRING_ALLOWLIST.length}`)
    assert.ok(SIDECAR_WIRING_ALLOWLIST.length < 8,
      `sidecar allowlist has ${SIDECAR_WIRING_ALLOWLIST.length} entries — 装配面正在系统性失守`)
  })
})

// ── 检查项 5：coordinator 构造点计划约束接线（D8 L2）──

/** 生产环境 DelegationCoordinator 构造点清单。新增构造点时应在此追加；否则断言失败。 */
const COORDINATOR_CONSTRUCTION_POINTS: Array<{
  /** src-relative path */
  file: string
  /** 该构造点是否应有 getPlanConstraints */
  expectPlanConstraints: boolean
  reason: string
}> = [
  {
    file: 'bootstrap.ts',
    expectPlanConstraints: true,
    reason: '主控 agent 路径——D8 L2 计划约束兜底注入的唯一构造点',
  },
  {
    file: 'agent/headless-coordinator.ts',
    expectPlanConstraints: false,
    reason: 'headless goal_judge 单 worker（maxWorkers:1），无计划语境，有意不接。reviewDate: 2027-08-01',
  },
]

describe('assembly audit — coordinator plan-constraints wiring (D8 L2)', () => {
  test('bootstrap.ts DelegationCoordinator 构造点含 getPlanConstraints', () => {
    const src = readFileSync(join(SRC_ROOT, 'bootstrap.ts'), 'utf8')
    // 在 new DelegationCoordinator({ … }) 块内找到 getPlanConstraints
    const coordBlock = src.match(/new DelegationCoordinator\(\{([\s\S]*?)\n  \}\)/)?.[1]
    assert.ok(coordBlock, '找不到 DelegationCoordinator 构造块')
    assert.ok(
      /getPlanConstraints\s*:/.test(coordBlock),
      'bootstrap.ts 的 DelegationCoordinator 构造块缺少 getPlanConstraints——D8 L2 计划约束兜底未接线',
    )
  })

  test('所有 production 构造点已枚举（防止隐式第三个构造点）', () => {
    const allSources = COORDINATOR_CONSTRUCTION_POINTS.map(p => {
      const src = readFileSync(join(SRC_ROOT, p.file), 'utf8')
      const count = (src.match(/new DelegationCoordinator\(/g) ?? []).length
      return { file: p.file, count }
    })
    // 每个文件恰好 1 个构造点
    for (const { file, count } of allSources) {
      assert.equal(count, 1, `${file} 的 new DelegationCoordinator( 数量 ${count} ≠ 1——若新增构造点，请在此处追加条目`)
    }
  })

  test('headless-coordinator 在 allowlist 中有意不接，reviewDate 未过期', () => {
    const headless = COORDINATOR_CONSTRUCTION_POINTS.find(p => p.file === 'agent/headless-coordinator.ts')
    assert.ok(headless, 'headless-coordinator 不在构造点清单中')
    assert.equal(headless!.expectPlanConstraints, false)
    const reviewMatch = headless!.reason.match(/reviewDate:\s*(\d{4}-\d{2}-\d{2})/)
    if (reviewMatch) {
      const reviewDate = new Date(reviewMatch[1]!).getTime()
      const now = Date.now()
      const oneYear = 365 * 24 * 60 * 60 * 1000
      assert.ok(!isNaN(reviewDate) && reviewDate > now - oneYear,
        `headless-coordinator allowlist reviewDate ${reviewMatch[1]} 已过期`)
    }
  })
})

// ── 检查项 6：自述块渲染分支可达性 ──
//
// 「有调用方」是 trivially 满足的废判据——`renderProgressBlock` 的兜底分支有调用方、
// 有测试、也在覆盖率里，但它在生产中数月不可达：判别式问的是「字符串非空吗」，而被
// 问的那个字符串是 `<session-state></session-state>` 空壳，恒为真值。分支活着，只是
// 永远走不到。这一组断言抓的是这个形状。
//
// 通用不变量：**任何被 truthiness 判别式消费的块渲染器，无内容时必须返回空串。**
// 违反它的代价不是多几个字节，而是它身后的整条分支静默死掉且没有任何外显信号。

interface SelfStateChannel {
  name: string
  /** 无内容状态下的渲染结果 */
  renderEmpty: () => string | undefined
  /** 返回非空壳的后果 */
  consequence: string
}

const SELF_STATE_CHANNELS: SelfStateChannel[] = [
  {
    name: 'session-state',
    renderEmpty: () => new SessionStateManager('audit').renderForVolatile(),
    consequence: '`if (ctx.sessionState)` 恒真 → <progress> 兜底分支（含 decisions）不可达',
  },
]

describe('assembly audit — self-state render reachability', () => {
  for (const channel of SELF_STATE_CHANNELS) {
    test(`${channel.name} 无内容时渲染为空串，不留空壳`, () => {
      const rendered = channel.renderEmpty() ?? ''
      assert.equal(rendered, '',
        `${channel.name} 无内容时返回了 ${JSON.stringify(rendered)}——${channel.consequence}`)
    })
  }

  // 判据不是「函数被调用过」，是「这个来源的产物真的出现在附录里」。三个来源各自
  // 独立可达——decisions 曾经只在「session-state 为空」时才读，一旦有文件被改就静默
  // 消失；空壳恒真之后连那个窗口也没了。
  test('<progress> 的三个来源各自独立可达', () => {
    const empty = new SessionStateManager('audit')
    const modified = new SessionStateManager('audit')
    modified.trackFileModified('src/probe.ts')

    const fromDecisionsAlone = buildDynamicAppendix({
      cwd: '/repo',
      sessionState: empty.renderForVolatile(),
      decisions: ['decision-source-marker'],
    })
    assert.match(fromDecisionsAlone, /decision-source-marker/,
      'decisions 不可达——判别式又退回成了「字符串非空」')

    const fromSessionAlone = buildDynamicAppendix({ cwd: '/repo', sessionState: modified.renderForVolatile() })
    assert.match(fromSessionAlone, /Modified: src\/probe\.ts/)

    const fromTaskProgressAlone = buildDynamicAppendix({
      cwd: '/repo',
      taskProgress: { completed: [], current: 'task-source-marker', remaining: [], decisions: [] },
    })
    assert.match(fromTaskProgressAlone, /current: task-source-marker/)
  })

  test('session-state 有内容不会挤掉 decisions —— 三个来源同时在场', () => {
    const modified = new SessionStateManager('audit')
    modified.trackFileModified('src/probe.ts')
    const all = buildDynamicAppendix({
      cwd: '/repo',
      sessionState: modified.renderForVolatile(),
      taskProgress: { completed: [], current: 'task-source-marker', remaining: [], decisions: [] },
      decisions: ['decision-source-marker'],
    })
    assert.match(all, /Modified: src\/probe\.ts/)
    assert.match(all, /current: task-source-marker/)
    assert.match(all, /decision-source-marker/,
      'decisions 被 session-state 的存在挤掉了——holdout 实验的曝光量会随「改没改过文件」漂移')
  })

  test('volatile.ts 不再对预渲染字符串做裸 truthiness 判别', () => {
    // 剥注释再匹配——这个形状为什么错，正是靠注释解释的，别让门禁咬住自己的说明。
    const code = readFileSync(join(SRC_ROOT, 'prompt', 'volatile.ts'), 'utf8')
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    assert.doesNotMatch(code, /if\s*\(\s*ctx\.sessionState\s*\)/,
      '裸 `if (ctx.sessionState)` 回来了——判别式必须判「有内容」而非「字符串非空」')
  })
})

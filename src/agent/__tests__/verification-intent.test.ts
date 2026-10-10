import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyVerificationIntent, nativeVerificationStartIntent } from '../verification-intent.js'

const CWD = mkdtempSync(join(tmpdir(), 'verification-intent-'))
writeFileSync(join(CWD, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:unit': 'node --import tsx scripts/run-node-tests.ts --unit', lint: 'npx eslint .', build: 'tsc --noEmit' } }))
after(() => rmSync(CWD, { recursive: true, force: true }))
const run = (command: string, cwd = CWD) => classifyVerificationIntent(command, cwd)

/** 计划 §2「修复 A：等待资格来自执行意图」矩阵——真实命令取自三份事故会话。 */
describe('VerificationExecutionIntent — 等待资格矩阵', () => {
  it('有限验证调用 → finite，获得等待资格', () => {
    const cases: Array<[string, string]> = [
      ['rtk node --import tsx --test src/agent/__tests__/loop.test.ts', '太一事故真实命令（rtk + node --test）'],
      ['node --import tsx --test src/tools/__tests__/bash.test.ts', '裸 node --test'],
      ['node --import tsx scripts/run-node-tests.ts src/tui src/tools src/memory 2>&1', '开阳事故真实命令（batch runner）'],
      ['node --import tsx scripts/run-node-tests.ts --unit', 'PR #410 真实命令（--unit）'],
      ['npm test', '包管理器测试'],
      ['npm run test:unit', '带冒号的包脚本'],
      ['npx tsc --noEmit', 'tsc'],
      ['npm run lint', 'lint'],
      ['npm run build', 'build'],
      ['vitest run', 'vitest 非 watch'],
    ]
    for (const [cmd, why] of cases) {
      const i = run(cmd)
      assert.equal(i.lifetime, 'finite', `${why}｜${cmd} 应判 finite，得 ${i.lifetime}（${i.reason ?? ''}）`)
      assert.equal(i.waitingEligible, true, `${why}｜${cmd} 应获得等待资格`)
    }
  })

  it('真实 batch runner 命令识别为 finite——不靠单词 test', () => {
    const i = run('node --import tsx scripts/run-node-tests.ts src/agent')
    assert.equal(i.lifetime, 'finite')
    assert.ok(i.entry !== null && /run-node-tests\.ts$/.test(i.entry), `entry 应为实际入口，得 ${i.entry}`)
  })

  it('常驻形态 → persistent，不获得等待资格', () => {
    const cases: string[] = [
      'vitest --watch',
      'bun test --watch',
      'tsc -w',
      'tsc --watch --noEmit',
      'npm run dev',
      'npm run serve',
      'tail -f /tmp/test.log',
    ]
    for (const cmd of cases) {
      const i = run(cmd)
      assert.equal(i.lifetime, 'persistent', `${cmd} 应判 persistent，得 ${i.lifetime}`)
      assert.equal(i.waitingEligible, false, `${cmd} 不得获得等待资格`)
    }
  })

  it('非验证命令 → purpose none，不豁免', () => {
    const cases: string[] = [
      'grep -rn "npm test" src/',
      'sed -n 1,20p scripts/build.sh',
      'npm test --help',
      'npx tsc --version',
      'cat package.json',
      'ls scripts/build-*.sh',
    ]
    for (const cmd of cases) {
      const i = run(cmd)
      assert.equal(i.purpose, 'none', `${cmd} 应为非验证，得 ${i.purpose}`)
      assert.equal(i.waitingEligible, false, `${cmd} 不得获得等待资格`)
    }
  })

  it('不可归因入口 / 动态 shell → unknown，不豁免', () => {
    const cases: string[] = [
      'node scripts/build.ts',
      'bash -c "echo hi"',
      'make test',
      'for f in a b; do echo $f; done',
    ]
    for (const cmd of cases) {
      const i = run(cmd)
      assert.notEqual(i.waitingEligible, true, `${cmd} 不得获得等待资格`)
      assert.ok(i.reason || i.lifetime === 'unknown' || i.purpose === 'none', `${cmd} 应留下判定来源或拒绝原因`)
    }
  })
})

describe('VerificationExecutionIntent — 管道白名单与覆盖证明分离', () => {
  it('有限生产者 + 白名单输出过滤器 → 可等待，但不给覆盖证明', () => {
    const i = run('node --import tsx scripts/run-node-tests.ts src/agent 2>&1 | tail -14')
    assert.equal(i.lifetime, 'finite', '已识别的有限验证生产者应可等待')
    assert.equal(i.waitingEligible, true)
    assert.equal(i.allowsCompletionEvidence, false, 'tail 的 exit(0) 不能推导逐文件覆盖通过')
  })

  it('过滤器带 follow 或携带新可执行段 → 不豁免', () => {
    for (const cmd of [
      'node --import tsx scripts/run-node-tests.ts src/agent | tail -f',
      'node --import tsx scripts/run-node-tests.ts src/agent | grep FAIL | wc -l',
    ]) {
      const i = run(cmd)
      assert.equal(i.waitingEligible, false, `${cmd} 不得获得等待资格`)
    }
  })
})

describe('VerificationExecutionIntent — 管道非白名单：真实验证执行不得压成 none', () => {
  it('左段是验证调用 → unknown / unattributable，不获得等待资格', () => {
    const i = run('node --test src/a.test.ts | grep fail')
    assert.equal(i.purpose, 'unknown', '真实验证执行被过滤器遮蔽时不得退化成 none（下游按 purpose !== none 过滤会静默漏记）')
    assert.equal(i.lifetime, 'unknown')
    assert.equal(i.waitingEligible, false)
    assert.equal(i.allowsCompletionEvidence, false)
    assert.equal(i.source, 'unattributable')
    assert.ok(i.reason, '必须留下可直接核对的归因原因')
  })

  it('左段本身非验证 → 保持 none', () => {
    const i = run('cat package.json | grep name')
    assert.equal(i.purpose, 'none', '`cat x | grep y` 不是验证调用')
    assert.equal(i.waitingEligible, false)
  })

  it('非白名单管道分支的 cwd 口径 = 剥离左段透明包装后的 effectiveCwd', () => {
    for (const cmd of ['cat package.json | grep name', 'node --test src/a.test.ts | grep fail']) {
      assert.equal(run(cmd, '/tmp/proj').cwd, '/tmp/proj', `${cmd} 应给出 effectiveCwd 而非原始入参口径`)
    }
  })
})

describe('VerificationExecutionIntent — unresolved package scripts', () => {
  it('literal cwd survives, named test script has purpose but cannot earn waiting credit without its body', () => {
    const i = run('cd /nonexistent-proj-dir && npm run test:unit', '/some/other/dir')
    assert.equal(i.cwd, '/nonexistent-proj-dir')
    assert.equal(i.purpose, 'test')
    assert.equal(i.source, 'unattributable')
    assert.equal(i.waitingEligible, false)
  })
})

describe('VerificationExecutionIntent — 规范化字段', () => {
  it('剥离 cd 包装并解析出真实 cwd 与入口', () => {
    const i = run('cd /tmp/proj && npm test')
    assert.equal(i.cwd, '/tmp/proj')
    assert.equal(i.lifetime, 'unknown', '未读取到脚本不能凭名称授予等待资格')
  })

  it('每条判定都带可核对的来源', () => {
    for (const cmd of ['npm test', 'vitest --watch', 'cat package.json']) {
      const i = run(cmd)
      assert.ok(i.source.length > 0, `${cmd} 必须留下判定来源`)
    }
  })

  it('不理会继承属性、非字符串输入不抛错', () => {
    assert.doesNotThrow(() => run(''))
    const i = run('')
    assert.equal(i.waitingEligible, false)
  })
})

it('package bodies and actual cwd determine lifetime, never the script name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verification-package-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest --watch', build: 'vite build --watch', check: 'vitest run', opaque: 'custom-runner', loop: 'npm run loop' } }))
    for (const command of ['npm test', 'npm run build', 'vitest']) {
      const fact = run(command, dir)
      assert.equal(fact.waitingEligible, false, command)
      assert.equal(fact.lifetime, 'persistent', command)
    }
    assert.equal(run('npm run check', dir).waitingEligible, true)
    assert.equal(run('npm run opaque', dir).waitingEligible, false)
    assert.equal(run('npm run loop', dir).waitingEligible, false)
    assert.equal(run('npm test', '/nonexistent-dir').waitingEligible, false)
    const filtered = run(`cd '${dir}' && node --import tsx scripts/run-node-tests.ts src/agent 2>&1 | tail -14`)
    assert.equal(filtered.waitingEligible, true, '事故中的 cd 包装与单过滤器必须同时支持')
    assert.equal(filtered.allowsCompletionEvidence, false)
    assert.equal(filtered.cwd, dir)
    assert.equal(run('node --test | tail 14').waitingEligible, false, '读取额外文件不是过滤器')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

describe('nativeVerificationStartIntent — 原生验证工具启动事实（P2）', () => {
  it('run_tests/typecheck/lsp_diagnostics → finite 启动意图；前台执行无等待保护、scope 不可确认', () => {
    const cases: Array<['run_tests' | 'typecheck' | 'lsp_diagnostics', 'test' | 'typecheck']> = [
      ['run_tests', 'test'],
      ['typecheck', 'typecheck'],
      ['lsp_diagnostics', 'typecheck'],
    ]
    for (const [name, purpose] of cases) {
      const i = nativeVerificationStartIntent(name, CWD)
      assert.ok(i, name)
      assert.equal(i.purpose, purpose)
      assert.equal(i.lifetime, 'finite')
      assert.equal(i.waitingEligible, false, '原生工具前台执行不产生后台等待保护')
      assert.equal(i.allowsCompletionEvidence, false, '启动是活动，不是通过证明')
      assert.equal(i.scope, null, 'identity 不可确认——重复验证软判据不启动')
      assert.equal(i.source, 'runner-kind')
    }
  })

  it('非验证工具 → null（不伪造启动）', () => {
    for (const name of ['read_file', 'glob', 'write_file', 'bash']) {
      assert.equal(nativeVerificationStartIntent(name, CWD), null, name)
    }
  })
})

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createDestructiveGateState } from '../destructive-gate.js'
import { GIT_CLEAR_RE } from '../destructive-patterns.js'

describe('destructive-gate 决策矩阵', () => {
  test('无验证失败时不拦截 git 清场命令', () => {
    const gate = createDestructiveGateState()
    const d = gate.evaluate('bash', { command: 'git stash' })
    assert.equal(d.block, false)
  })

  test('验证失败后窗口内拦截 git 清场,消息含命令与放行指引', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    const d = gate.evaluate('bash', { command: 'git reset --hard HEAD' })
    assert.equal(d.block, true)
    if (d.block) {
      assert.match(d.message, /git reset --hard HEAD/)
      assert.match(d.message, /原样重发/)
      assert.match(d.message, /根因/)
    }
  })

  test('首次拦截、同一命令原样重发放行(显式坚持)', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, false)
    // 空白差异归一化后仍视为同一命令
    assert.equal(gate.evaluate('bash', { command: '  git   stash ' }).block, false)
  })

  test('不同的清场命令各自独立拦截一次', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
    assert.equal(gate.evaluate('bash', { command: 'git clean -fd' }).block, true)
    assert.equal(gate.evaluate('bash', { command: 'git clean -fd' }).block, false)
  })

  test('验证通过关窗:失败→通过→清场不拦截', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    gate.noteVerification('passed')
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, false)
  })

  test('blocked 与 failed 等价开窗，且不关窗', () => {
    const gate = createDestructiveGateState()
    // blocked 开窗——和 failed 一样，agent 感知到验证障碍
    gate.noteVerification('blocked')
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
    // blocked 不关窗：failed 开窗后再 blocked 不关
    const gate2 = createDestructiveGateState()
    gate2.noteVerification('failed')
    gate2.noteVerification('blocked')
    assert.equal(gate2.evaluate('bash', { command: 'git stash' }).block, true)
  })

  test('P1: noteAdvisoryPressure 开窗——advisory 被忽略 ≥2 时拦截清场', () => {
    const gate = createDestructiveGateState()
    gate.noteAdvisoryPressure()
    assert.equal(gate.evaluate('bash', { command: 'git checkout -- .' }).block, true)
    // 首次拦截,原样重发放行
    assert.equal(gate.evaluate('bash', { command: 'git checkout -- .' }).block, false)
  })

  test('窗口按实际执行的工具计数过期(默认 3)', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    gate.noteToolExecuted()
    gate.noteToolExecuted()
    gate.noteToolExecuted()
    // 3 次仍在窗口内
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
    const gate2 = createDestructiveGateState()
    gate2.noteVerification('failed')
    for (let i = 0; i < 4; i++) gate2.noteToolExecuted()
    assert.equal(gate2.evaluate('bash', { command: 'git stash' }).block, false)
  })

  test('新的失败重置窗口计数', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    for (let i = 0; i < 3; i++) gate.noteToolExecuted()
    gate.noteVerification('failed')
    gate.noteToolExecuted()
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
  })

  test('非 bash 工具与非清场命令永不拦截', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    assert.equal(gate.evaluate('read_file', { path: 'a.ts' }).block, false)
    assert.equal(gate.evaluate('bash', { command: 'git status' }).block, false)
    assert.equal(gate.evaluate('bash', { command: 'git stash pop' }).block, false)
    assert.equal(gate.evaluate('bash', { command: 'npm test' }).block, false)
    assert.equal(gate.evaluate('bash', {}).block, false)
  })
})

describe('GIT_CLEAR_RE 共享正则(迁移回归)', () => {
  test('匹配清场类,排除只读/恢复类', () => {
    for (const cmd of ['git stash', 'git reset --hard', 'git checkout -- .', 'git restore .', 'git clean -fd']) {
      assert.equal(GIT_CLEAR_RE.test(cmd), true, `should match: ${cmd}`)
    }
    for (const cmd of ['git stash pop', 'git stash list', 'git stash show', 'git stash apply', 'git diff', 'git log']) {
      assert.equal(GIT_CLEAR_RE.test(cmd), false, `should NOT match: ${cmd}`)
    }
  })

  // 收编公开仓 PR #410：git 与子命令之间的全局参数（-C/-c/--no-pager/--git-dir…）。
  // 值型旗标的分隔与紧贴形态（`-C dir` ≡ `-Cdir`、`--git-dir x` ≡ `--git-dir=x`）
  // 与引号值（`-C "my repo"`）语义相同，必须同判；只读形态不得误伤。
  test('全局参数形态（含紧贴与引号值）同口径', () => {
    for (const cmd of [
      'git -C repo reset --hard',
      'git --no-pager reset --hard HEAD',
      'git -c core.pager=cat clean -fd',
      'git --git-dir .git stash',
      'git --work-tree . reset --hard',
      'git --git-dir=.git stash',
      'cd x&&git reset --hard',
      'cd x;git clean -fd',
      '(git stash)',
      'git restore a.ts',
      'git -C a -C b stash',
      'git -C/tmp reset --hard',
      'git -cfoo.bar=baz clean -fd',
      'git -C "my repo" stash',
    ]) {
      assert.equal(GIT_CLEAR_RE.test(cmd), true, `should match: ${cmd}`)
    }
    for (const cmd of [
      'git stash list',
      'git --no-pager status',
      'git -C repo status',
      'git -C docs log --oneline -5',
      'git clean -dn',
      'echo digit reset --hard',
    ]) {
      assert.equal(GIT_CLEAR_RE.test(cmd), false, `should NOT match: ${cmd}`)
    }
  })
})

// ─── T4 getVirtueCredit 选项 ──────────────────────────────────────
// virtueCredit 仅影响 block message 文案中 ≥0.7 时追加一行信任引导语，
// 不影响 block 决策逻辑。

describe('destructive-gate getVirtueCredit 选项 (T4)', () => {
  test('B1: credit < 0.7 → 拦截消息不含信任轨迹', () => {
    const gate = createDestructiveGateState({ getVirtueCredit: () => 0.5 })
    gate.noteVerification('failed')
    const d = gate.evaluate('bash', { command: 'git stash' })
    assert.equal(d.block, true)
    if (d.block) {
      assert.ok(!d.message.includes('美德轨迹'), 'credit < 0.7 不应含信任轨迹')
    }
  })

  test('B2: credit ≥ 0.7 → 拦截消息含信任轨迹 + credit 数值', () => {
    const gate = createDestructiveGateState({ getVirtueCredit: () => 0.72 })
    gate.noteVerification('failed')
    const d = gate.evaluate('bash', { command: 'git stash' })
    assert.equal(d.block, true)
    if (d.block) {
      assert.match(d.message, /美德轨迹/)
      assert.match(d.message, /0\.72/)
    }
  })

  test('B3: getVirtueCredit 抛异常不崩,正常返回 block（无信任轨迹）', () => {
    const gate = createDestructiveGateState({
      getVirtueCredit: () => { throw new Error('boom') },
    })
    gate.noteVerification('failed')
    const d = gate.evaluate('bash', { command: 'git stash' })
    assert.equal(d.block, true)
    if (d.block) {
      assert.ok(!d.message.includes('美德轨迹'), '回调抛异常时应 fallback 到无信任轨迹')
    }
  })
})

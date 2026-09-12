import { describe, it } from 'node:test'
// 注：本文件用 describe/it 包裹——顶层裸 test() 在 runner 的 --test-force-exit 下
// 会被随机截断（跑一部分就退出且仍报 pass）。
import assert from 'node:assert/strict'
import { createSecurityPatternHook } from '../security-pattern-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: { cwd: '/fake', turn, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function makeWriteTool(name: string, filePath: string, content: string): RuntimeToolEvent {
  if (name === 'write_file') {
    return { name, success: true, input: { file_path: filePath, content } } as unknown as RuntimeToolEvent
  }
  return {
    name, success: true,
    input: { file_path: filePath, old_string: 'x', new_string: content },
  } as unknown as RuntimeToolEvent
}

describe('createSecurityPatternHook', () => {
  it('命中危险模式时 submit 一条 advisory 并记录到 tracker', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/api.js', 'el.innerHTML = userInput\n'))

    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'security-pattern')
    assert.equal(submitted[0]!.category, 'discipline')
    assert.ok(submitted[0]!.content.includes('【安全】'))
    assert.ok(submitted[0]!.content.includes('src/api.js'))

    const tracker = hook.getSecurityTracker()
    assert.ok(tracker.hitsByFile.get('src/api.js')!.has('innerHTML_xss'))
  })

  it('干净代码零注入、零 tracker 记录', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/math.ts', 'export const add = (a, b) => a + b\n'))

    assert.equal(submitted.length, 0)
    assert.equal(hook.getSecurityTracker().hitsByFile.size, 0)
  })

  it('edit_file 走 new_string 通道也能命中', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('edit_file', 'a.py', 'yaml.load(open(f))\n'))
    assert.equal(submitted.length, 1)
    assert.ok(hook.getSecurityTracker().hitsByFile.get('a.py')!.has('unsafe_yaml_load'))
  })

  it('同一文件多规则命中合并进一条 advisory', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'x.js', 'eval(a)\nel.innerHTML = b\n'))

    assert.equal(submitted.length, 1)
    const ruleSet = hook.getSecurityTracker().hitsByFile.get('x.js')!
    assert.ok(ruleSet.has('eval_injection'))
    assert.ok(ruleSet.has('innerHTML_xss'))
  })

  it('tracker 跨轮累积（session-scoped,非 turn-scoped）', () => {
    const hook = createSecurityPatternHook({ advisoryBus: { submit: () => {} } })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'a.js', 'eval(x)\n'))
    hook.run(makeCtx(5), makeWriteTool('write_file', 'b.js', 'el.innerHTML = y\n'))

    const tracker = hook.getSecurityTracker()
    assert.equal(tracker.hitsByFile.size, 2)
    assert.ok(tracker.hitsByFile.get('a.js')!.has('eval_injection'))
    assert.ok(tracker.hitsByFile.get('b.js')!.has('innerHTML_xss'))
  })

  it('非写工具跳过（read_file 等）', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), { name: 'read_file', success: true, input: { file_path: 'a.js' } } as unknown as RuntimeToolEvent)
    assert.equal(submitted.length, 0)
  })

  it('ast_edit 预览（缺省 dryRun）不告警——内容没落盘，与 apply_patch check_only 同理', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    // ast-edit.ts:105 `const dryRun = input.dryRun !== false`——缺省即预览、不落盘。
    hook.run(makeCtx(1), {
      name: 'ast_edit', success: true,
      input: { paths: ['a.js'], ops: [{ find: 'x', replace: 'el.innerHTML = userInput' }] },
    } as unknown as RuntimeToolEvent)

    assert.equal(submitted.length, 0, '预览不落盘——对不存在的代码告警是纯噪音')
    assert.equal(hook.getSecurityTracker().hitsByFile.size, 0)
  })

  it('ast_edit 预览不得占用 tracker 去重位——随后真写入仍须被提醒', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    // 先预览（缺省 dryRun）：若这里误扫，会把 (a.js, innerHTML_xss) 写进
    // session-scoped tracker，随后的真写入就因"已提醒过"被静默吞掉。
    hook.run(makeCtx(1), {
      name: 'ast_edit', success: true,
      input: { paths: ['a.js'], ops: [{ find: 'x', replace: 'el.innerHTML = userInput' }] },
    } as unknown as RuntimeToolEvent)
    const afterPreview = submitted.length
    hook.run(makeCtx(2), makeWriteTool('write_file', 'a.js', 'el.innerHTML = userInput\n'))

    // 用增量断言：只看总数的话，「预览误报 1 + 真写被吞 0」与「预览 0 + 真写 1」
    // 都是 1，测试会对着坏行为假绿。
    assert.equal(afterPreview, 0, '预览本身不得产生任何 advisory')
    assert.equal(submitted.length - afterPreview, 1, '真写入必须收到那条提醒（不能被预览占掉去重位）')
    assert.ok(hook.getSecurityTracker().hitsByFile.get('a.js')!.has('innerHTML_xss'))
  })

  it('ast_edit 真写（dryRun:false）照常告警', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), {
      name: 'ast_edit', success: true,
      input: { paths: ['a.js'], ops: [{ find: 'x', replace: 'el.innerHTML = userInput' }], dryRun: false },
    } as unknown as RuntimeToolEvent)

    assert.equal(submitted.length, 1)
  })

  it('resetSecurityTracker 清空累积', () => {
    const hook = createSecurityPatternHook({ advisoryBus: { submit: () => {} } })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'a.js', 'eval(x)\n'))
    assert.equal(hook.getSecurityTracker().hitsByFile.size, 1)
    hook.resetSecurityTracker()
    assert.equal(hook.getSecurityTracker().hitsByFile.size, 0)
  })

  it('写失败不告警（内容没落盘，告警是纯噪音）', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    const failed = {
      name: 'write_file', success: false,
      input: { file_path: 'a.js', content: 'eval(x)\n' },
    } as unknown as RuntimeToolEvent
    hook.run(makeCtx(1), failed)

    assert.equal(submitted.length, 0)
    assert.equal(hook.getSecurityTracker().hitsByFile.size, 0)
  })

  it('同一 (文件, 规则) 只提醒一次（跨轮不重发长文案）', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'a.js', 'eval(x)\n'))
    hook.run(makeCtx(2), makeWriteTool('write_file', 'a.js', 'eval(y)\n'))
    hook.run(makeCtx(3), makeWriteTool('edit_file', 'a.js', 'eval(z)\n'))

    assert.equal(submitted.length, 1, 'AdvisoryBus 只在同轮去重，跨轮抑制得靠 tracker')
    // 已提醒的规则仍留在 tracker 里，供交付前复扫。
    assert.ok(hook.getSecurityTracker().hitsByFile.get('a.js')!.has('eval_injection'))
  })

  it('同一文件出现新规则仍然提醒（去重是按规则粒度）', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'a.js', 'eval(x)\n'))
    hook.run(makeCtx(2), makeWriteTool('write_file', 'a.js', 'eval(x)\nel.innerHTML = y\n'))

    assert.equal(submitted.length, 2)
    assert.ok(submitted[1]!.content.includes('innerHTML'), '第二条只讲新规则')
    assert.ok(!submitted[1]!.content.includes('eval()'), '不该复述已提醒过的 eval')
  })

  it('advisory 带 file_touched 核销谓词（否则只计送达、不进采纳率）', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/api.js', 'eval(x)\n'))

    const expect = submitted[0]!.expect
    assert.ok(expect && expect.kind === 'file_touched')
    assert.deepEqual(expect.paths, ['src/api.js'])
  })

  describe('apply_patch 覆盖', () => {
    function makePatchTool(diff: string, checkOnly = false): RuntimeToolEvent {
      return {
        name: 'apply_patch', success: true,
        input: { diff, ...(checkOnly ? { check_only: true } : {}) },
      } as unknown as RuntimeToolEvent
    }

    const dangerousDiff = [
      'diff --git a/src/db.ts b/src/db.ts',
      '--- a/src/db.ts',
      '+++ b/src/db.ts',
      '@@ -1 +1,2 @@',
      ' const x = 1',
      '+db.query(`SELECT * FROM users WHERE id = ${id}`)',
    ].join('\n')

    it('扫描 diff 里的新增行（换个写工具不该绕过检测）', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createSecurityPatternHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      hook.run(makeCtx(1), makePatchTool(dangerousDiff))

      assert.equal(submitted.length, 1)
      assert.ok(submitted[0]!.content.includes('src/db.ts'))
      assert.ok(hook.getSecurityTracker().hitsByFile.get('src/db.ts')!.has('sql_string_interpolation'))
    })

    it('check_only 不扫描（只校验不落盘）', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createSecurityPatternHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      hook.run(makeCtx(1), makePatchTool(dangerousDiff, true))
      assert.equal(submitted.length, 0)
    })

    it('context 行里的既有问题不告警（只看新增行）', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createSecurityPatternHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      const contextOnly = [
        '--- a/src/old.js',
        '+++ b/src/old.js',
        '@@ -1,2 +1,3 @@',
        ' eval(legacyInput)',
        '+const safe = 1',
      ].join('\n')
      hook.run(makeCtx(1), makePatchTool(contextOnly))
      assert.equal(submitted.length, 0, '未被本次改动引入的问题不该记在这次写入头上')
    })
  })
})

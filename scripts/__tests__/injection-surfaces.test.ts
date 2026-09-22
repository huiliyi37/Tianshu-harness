/**
 * 注入点申报表门禁测试。
 *
 * 这里测的重点不是「表通过」，而是**每道检查在表被改坏时确实会失败**——
 * 不会失败的门禁等于装饰。每条都用一个变异构造出对应的破坏，断言失败信息
 * 命中该检查号。基线用例反而是最弱的一条。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runChecks, listPushSites, type Report } from '../verify-injection-surfaces.js'
import {
  APPENDIX_SURFACES,
  CHANNEL_SURFACES,
  INJECTION_SURFACES,
  FROZEN_STRIPPED_FIELDS,
} from '../../src/prompt/injection-surfaces.js'

/** 断言报告失败，且失败项里有一条来自 `check`，返回该条信息供进一步断言。 */
function expectFailure(report: Report, check: string): string {
  assert.equal(report.ok, false, `期望校验失败，实际通过（检查 ${check}）`)
  const hit = report.failures.find(f => f.check === check)
  assert.ok(hit, `期望出现 ${check} 失败，实际失败项：${report.failures.map(f => `[${f.check}] ${f.message}`).join(' | ')}`)
  return hit.message
}

/** 断言 `check` 的失败项里**至少有一条**命中给定模式（同一检查可能先报别的条目）。 */
function expectFailureMatching(report: Report, check: string, pattern: RegExp): string {
  assert.equal(report.ok, false, `期望校验失败，实际通过（检查 ${check}）`)
  const msgs = report.failures.filter(f => f.check === check).map(f => f.message)
  assert.ok(msgs.length > 0, `期望出现 ${check} 失败，实际失败项：${report.failures.map(f => `[${f.check}] ${f.message}`).join(' | ')}`)
  const hit = msgs.find(m => pattern.test(m))
  assert.ok(hit, `期望 ${check} 里有一条命中 ${pattern}，实际：${msgs.join(' | ')}`)
  return hit
}

describe('注入点申报表 · 基线', () => {
  it('当前申报表与源码一致', () => {
    const report = runChecks()
    assert.deepEqual(report.failures, [], report.failures.map(f => `[${f.check}] ${f.message}`).join('\n'))
    assert.equal(report.ok, true)
  })

  it('规模与通道数符合当前实现', () => {
    const { stats } = runChecks()
    // 27 个普通 appendix 块 + 2 个受保护块 + 9 个通道级条目
    assert.equal(stats.appendix, 27)
    assert.equal(stats.appendixProtected, 2)
    assert.equal(stats.surfaces, 38)
    assert.equal(stats.channels, 7)
    // CvmInjectionSource 七源全部被认领
    assert.equal(stats.metered, 7)
    // 每个锚点都真在源码里找到了
    assert.equal(stats.anchorsVerified, stats.surfaces)
  })

  it('appendix 推送点可从源码实抽，且顺序稳定', () => {
    const sites = listPushSites()
    // 27 个申报块 + git-status 的 if/else 多一处 = 28 个普通推送点，加 2 个受保护块
    assert.equal(sites.length, 30, `实抽 ${sites.length} 个 push 点`)
    assert.equal(sites.filter(s => !s.protected).length, 28)
    assert.equal(sites.filter(s => s.protected).length, 2)
    // git-status 的 if/else 两条腿
    assert.equal(sites.filter(s => s.key === 'tag:git-status').length, 2)
    for (const site of sites) assert.ok(site.line > 0, `${site.key} 行号缺失`)
  })

  it('申报条目自身不违反映射约定：appendix 有 order，通道级没有', () => {
    for (const s of APPENDIX_SURFACES) assert.notEqual(s.order, undefined, `${s.id} 缺 order`)
    for (const s of CHANNEL_SURFACES) assert.equal(s.order, undefined, `${s.id} 不该有 order`)
  })
})

describe('注入点申报表 · 每道检查都会咬', () => {
  it('V1：id 重复被抓', () => {
    const msg = expectFailure(runChecks(v => {
      const first = v.surfaces[0]!
      v.surfaces.push({ ...first })
    }), 'V1')
    assert.match(msg, /id 重复/)
  })

  it('V1：appendix 块丢 order 被抓', () => {
    const msg = expectFailure(runChecks(v => {
      const target = v.surfaces.find(s => s.id === 'appendix.progress')!
      delete (target as { order?: number }).order
    }), 'V1')
    assert.match(msg, /缺 order/)
  })

  it('V1：appendix 序号出现空洞被抓', () => {
    const msg = expectFailure(runChecks(v => {
      const target = v.surfaces.find(s => s.id === 'appendix.progress')!
      ;(target as { order?: number }).order = 99
    }), 'V1')
    assert.match(msg, /连续序号/)
  })

  it('V2：锚点符号被重构掉后被抓', () => {
    const msg = expectFailure(runChecks(v => {
      const target = v.surfaces.find(s => s.id === 'appendix.git-status')!
      ;(target.anchor as { symbol: string }).symbol = '<git-status-that-never-existed>'
    }), 'V2')
    assert.match(msg, /找不到符号/)
  })

  it('V3：CVM 计量源无人认领被抓', () => {
    const msg = expectFailure(runChecks(v => {
      // 抹掉所有 projection 认领
      for (const s of v.surfaces) {
        if (s.metered === 'projection') delete (s as { metered?: string }).metered
      }
    }), 'V3')
    assert.match(msg, /projection/)
  })

  it('V3：声明了不存在的计量源被抓', () => {
    expectFailureMatching(runChecks(v => {
      const target = v.surfaces.find(s => s.id === 'appendix.tool-context')!
      ;(target as { metered?: string }).metered = 'no-such-source'
    }), 'V3', /不存在的计量源/)
  })

  it('V4：把一个每轮会变的字段留在冻结前缀里（strip list 有、表里没有）被抓', () => {
    const msg = expectFailure(runChecks(v => {
      // 模拟「把 gitStatus 从冻结前缀里放回去」：申报表侧删掉剥离声明
      v.frozenStripped = v.frozenStripped.filter(f => f !== 'gitStatus')
    }), 'V4')
    assert.match(msg, /未申报的剥离字段/)
    assert.match(msg, /gitStatus/)
  })

  it('V4：申报了已不存在的剥离字段被抓', () => {
    const msg = expectFailure(runChecks(v => {
      v.frozenStripped = [...v.frozenStripped, 'fieldThatWasDeleted']
    }), 'V4')
    assert.match(msg, /不存在/)
  })

  it('V4：往冻结前缀塞了未申报的新字段被抓（churner 混入字节 0 的形状）', () => {
    const msg = expectFailure(runChecks(v => {
      // 模拟某人把已申报的会话常量撤下：源码仍在渲染 → 变成「未申报」
      v.frozenKeep = v.frozenKeep.filter(f => f !== 'seedCapsuleBlock')
      v.renderSupport = v.renderSupport.filter(f => f !== 'seedCapsuleBlock')
    }), 'V4')
    assert.match(msg, /未申报的字段/)
    assert.match(msg, /seedCapsuleBlock/)
  })

  it('V4：申报了已不再渲染的保留字段被抓', () => {
    const msg = expectFailure(runChecks(v => {
      v.frozenKeep = [...v.frozenKeep, 'ghostField']
    }), 'V4')
    assert.match(msg, /已不再渲染/)
  })

  it('V5：新增推送点未申报被抓', () => {
    const msg = expectFailure(runChecks(v => {
      v.surfaces = v.surfaces.filter(s => s.id !== 'appendix.progress')
    }), 'V5')
    assert.match(msg, /未申报的推送点/)
    assert.match(msg, /renderProgressBlock/)
  })

  it('V5：申报了源码里没有的推送点被抓', () => {
    const msg = expectFailure(runChecks(v => {
      v.surfaces.push({
        id: 'appendix.ghost',
        channel: 'appendix',
        cost: 'boundary-rebuild',
        volatility: 'per-turn',
        producer: 'ctx.ghostBlock',
        anchor: { file: 'src/prompt/volatile.ts', symbol: 'ctx.ghostBlock' },
        order: 27,
        note: '测试用幽灵条目',
      })
    }), 'V2')
    assert.match(msg, /找不到符号/)
  })

  it('V5：只调换顺序也会被抓（顺序即缓存设计）', () => {
    const msg = expectFailure(runChecks(v => {
      const a = v.surfaces.find(s => s.id === 'appendix.plan-trace')!
      const b = v.surfaces.find(s => s.id === 'appendix.active-plan-pointer')!
      const oa = a.order
      ;(a as { order?: number }).order = b.order
      ;(b as { order?: number }).order = oa
    }), 'V5')
    assert.match(msg, /顺序不一致/)
  })

  it('V5：复制一个 push 点到新分支（重数变化）被抓', () => {
    const msg = expectFailure(runChecks(v => {
      const target = v.surfaces.find(s => s.id === 'appendix.cross-session-events')!
      ;(target as { pushSites?: number }).pushSites = 3
    }), 'V5')
    assert.match(msg, /push 点/)
  })

  it('V8：渲染函数内部新读了未申报的 ctx 字段被抓', () => {
    const msg = expectFailure(runChecks(v => {
      const target = v.surfaces.find(s => s.id === 'appendix.progress')!
      // 抹掉 sessionState 的申报——它在 renderProgressBlock 里仍被读
      ;(target as { consumes?: readonly string[] }).consumes = ['decisions', 'taskProgress']
    }), 'V8')
    assert.match(msg, /未申报的字段/)
    assert.match(msg, /sessionState/)
  })

  it('V8：consumes 里申报了已不再读的字段被抓', () => {
    const msg = expectFailure(runChecks(v => {
      const target = v.surfaces.find(s => s.id === 'appendix.terseness-nudge')!
      ;(target as { consumes?: readonly string[] }).consumes = [...target.consumes!, 'ghostField']
    }), 'V8')
    assert.match(msg, /已不再被读/)
  })

  it('V7：appendix 被挪出尾部挂载位置被抓', () => {
    const msg = expectFailure(runChecks(v => {
      // 抹掉引擎里的尾部挂载形状，模拟「appendix 改塞进 system 段」
      v.sourceOverrides['src/prompt/engine.ts'] = 'const nothingHere = 1\n'
    }), 'V7')
    assert.match(msg, /buildTraileredUserContent|appendix/)
  })

  it('V5：代码里的计量源与申报不一致被抓', () => {
    const msg = expectFailure(runChecks(v => {
      const target = v.surfaces.find(s => s.id === 'appendix.tool-context')!
      ;(target as { metered?: string }).metered = 'advisory-appendix'
    }), 'V5')
    assert.match(msg, /计量源/)
  })
})

describe('注入点申报表 · 口径自洽', () => {
  it('frozen 剥离字段与保留字段无交集', () => {
    const keep = new Set(INJECTION_SURFACES.filter(s => s.channel === 'trailer-frozen').flatMap(() => [] as string[]))
    void keep
    const keepFields = new Set(['activeDomain', 'cwdRelation', 'knowledgeManifestBlock', 'projectIndexBlock', 'projectMemoryBlock', 'rivetMd', 'seedCapsuleBlock', 'sessionMemoryBlock', 'workingSet'])
    for (const f of FROZEN_STRIPPED_FIELDS) {
      assert.equal(keepFields.has(f), false, `${f} 同时出现在剥离与保留两侧`)
    }
  })

  it('每个 appendix 块的 producer 都出现在源码实抽清单里', () => {
    const keys = new Set(listPushSites().map(s => s.key))
    for (const s of APPENDIX_SURFACES) {
      assert.equal(keys.has(s.producer), true, `${s.id} 的 producer ${s.producer} 不在实抽清单里`)
    }
  })
})

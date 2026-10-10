import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { formatDomainDriftNudge } from '../../tui/domain-drift-nudge.js'
import { getCapsuleByStar } from '../seed-capsule-store.js'

// 信任门（2026-10-09）：下方查询用例的素材建在临时 cwd 的 docs/ 下，需显式授信
// （信任门双态由 seed-capsule-store.test.ts 专测；此处只验查询功能本身）。
process.env.RIVET_TRUST_PROJECT = '1'

// ── 漂移提示引导文案（消息级注入语义）──────────────────────────

describe('domain-capsule: 漂移提示引导', () => {
  test('提示含 /capsule 命令 + 推荐域中文名 + 上限与零缓存代价说明', () => {
    const text = formatDomainDriftNudge({
      recommendedId: 'tianquan',
      recommendedName: '天权',
      currentId: 'tianliang',
      currentName: '天梁',
      matchedKeywords: ['审查'],
    })
    assert.ok(text.includes('/capsule 天权'), '给出可直接执行的命令（星名=胶囊 store 键）')
    assert.ok(text.includes('消息级追加'), '明示注入通道语义')
    assert.ok(text.includes('零缓存代价'), '明示不碎前缀')
    assert.ok(text.includes('2 枚'), '佩戴上限提示')
    assert.ok(text.includes('/handoff'), '保留交接路径选项')
    assert.ok(text.includes('多会话多星域并行'), '多会话并行路径')
    assert.ok(text.includes(`/domain tianquan`), '新会话进推荐域的直连命令')
    assert.ok(text.includes('当前会话继续执行'), '明示分工：新会话审查/规划，本会话执行')
  })
})

// ── seed-capsule store 查询（/capsule 与 recall_capsule 同源）──

describe('domain-capsule: seed-capsule 查询同源', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-capsule-store-'))
  // fixture 建在 describe 收集期、清在 after()——try/finally 会同步删目录，
  // 测试还没跑 fixture 就没了（recovery-stack 同款坑）。
  {
    mkdirSync(join(cwd, 'docs'), { recursive: true })
    writeFileSync(join(cwd, 'docs', 'seed-capsule-test-star.md'), [
      '# 测试星胶囊',
      '',
      '<seed-capsule star="测试星" sealed="2026-01-01" gist="一行索引">',
      '完整方法论正文。',
      '</seed-capsule>',
      '',
    ].join('\n'), 'utf-8')

    test('getCapsuleByStar 命中项目 docs/ 下的胶囊并返回完整 block', () => {
      const capsule = getCapsuleByStar(cwd, '测试星')
      assert.ok(capsule, '项目 docs/ 胶囊可命中')
      assert.ok(capsule!.block.includes('完整方法论正文'), '正文完整')
      assert.equal(capsule!.star, '测试星')
    })
    test('未知星名返回 undefined（命令面据此给出已知列表）', () => {
      assert.equal(getCapsuleByStar(cwd, '不存在的星'), undefined)
    })
  }
  after(() => rmSync(cwd, { recursive: true, force: true }))
})

// ── 命令接线契约（源码 grep 型，同 composer-image-lightbox-contract 模式）──

describe('domain-capsule: /capsule 命令接线契约', () => {
  const slashSrc = readFileSync(new URL('../../tui/slash-commands.ts', import.meta.url), 'utf8')
  const loopSrc = readFileSync(new URL('../loop.ts', import.meta.url), 'utf8')
  const volatileSrc = readFileSync(new URL('../../prompt/volatile.ts', import.meta.url), 'utf8')

  test('/capsule 经 submitToAgent 注入消息（不碰 promptEngine/前缀）', () => {
    assert.match(slashSrc, /ctx\.submitToAgent\(\`\[星域胶囊注入\]/, '注入走消息通道')
    assert.match(slashSrc, /getCapsuleByStar\(cwd, target\)/, '正文与 recall_capsule 同源')
  })

  test('loop 侧只有消息级记账：上限 2 枚，无 promptEngine/persist 触点', () => {
    assert.match(loopSrc, /MAX_CAPSULES = 2/, '上限常量')
    assert.match(loopSrc, /noteCapsuleInjection/, '注入记账入口')
    const start = loopSrc.indexOf('星域胶囊（消息级注入记账')
    const section = loopSrc.slice(start, loopSrc.indexOf('getSessionDomain(): ActiveStarDomain', start))
    assert.ok(section.length > 0, '记账区块存在')
    // 剥注释（注释里合法说明"不触碰 promptEngine/persist"的纪律本身）
    const code = section.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    assert.ok(!code.includes('promptEngine'), '胶囊记账代码不得触碰 promptEngine')
    assert.ok(!code.includes('persist'), '胶囊记账代码不得触碰 persist')
  })

  test('volatile 前缀零胶囊渲染（正文只进消息——cache-safe 纪律回归闸）', () => {
    assert.ok(!volatileSrc.includes('capsuleDomains'), '前缀层不得有胶囊字段')
    assert.ok(!volatileSrc.includes('<domain-capsule'), '前缀层不得渲染胶囊块')
    assert.ok(volatileSrc.includes('执行纪律（全星域共享）'), '主域块不受影响')
  })
})

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import {
  starToGeneralSlug,
  readGeneralLedger,
  listGenerals,
  parseLedgerFamilies,
  topGeneralFamilies,
  appendGeneralFinding,
  generalLedgerPath,
  setGeneralLedgerTelemetrySink,
  type GeneralLedgerTelemetryEvent,
} from '../general-ledger.js'
import { createRecallGeneralTool } from '../../tools/recall-general.js'
import { createRecordGeneralFindingTool } from '../../tools/record-general-finding.js'

// B1/B2（将星点亮）：ledger 后半程 — recall_general 读、record_general_finding 写。

const FIXTURE_LEDGER = `# 将星 · 瑶光

## identity（固定）

- **名**：瑶光

## ledger（战绩账本 · 持续生长）

> 格式：### family-slug | recurrenceCount: N | lastSeen: DATE

### always-true-on-missing-field | recurrenceCount: 4 | lastSeen: 2026-06-07

**signature**：某字段缺失时，比较/匹配逻辑退化为恒真。
**instances**：
- 2026-06-07 团队审查 round-1 ④。

### false-green | recurrenceCount: 1 | lastSeen: 2026-06-07

**signature**：测试全绿与真缺陷并存。

---

<!-- 下一个出战的瑶光：把你认出的缺陷族追加在上面。 -->
`

describe('general-ledger', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(os.tmpdir(), 'general-ledger-'))
  })
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function seedLedger(slug = 'yaoguang', content = FIXTURE_LEDGER): void {
    mkdirSync(join(cwd, '.rivet/generals'), { recursive: true })
    writeFileSync(join(cwd, '.rivet/generals', `${slug}.md`), content)
  }

  describe('starToGeneralSlug', () => {
    it('maps domain names (中文/slug) and extra generals', () => {
      assert.equal(starToGeneralSlug('瑶光'), 'yaoguang')
      assert.equal(starToGeneralSlug('yaoguang'), 'yaoguang')
      assert.equal(starToGeneralSlug('天梁'), 'tianliang')
      assert.equal(starToGeneralSlug('贪狼'), 'tanlang')
      assert.equal(starToGeneralSlug('tanlang'), 'tanlang')
      assert.equal(starToGeneralSlug('不存在的星'), null)
      assert.equal(starToGeneralSlug(''), null)
    })
  })

  describe('read / list', () => {
    it('reads an existing ledger by 中文名 or slug', () => {
      seedLedger()
      assert.match(readGeneralLedger(cwd, '瑶光')!.content, /always-true-on-missing-field/)
      assert.equal(readGeneralLedger(cwd, 'yaoguang')!.slug, 'yaoguang')
      assert.equal(readGeneralLedger(cwd, '天梁'), null, '无账本文件 → null')
      assert.deepEqual(listGenerals(cwd), ['yaoguang'])
    })

    it('listGenerals excludes metadata while preserving ordinary dotfile ledgers', () => {
      seedLedger()
      seedLedger('.notes', '# Ordinary dotfile ledger')
      seedLedger('._metadata', '# Filesystem metadata')
      writeFileSync(join(cwd, '.rivet/generals', '.DS_Store'), 'filesystem metadata')
      assert.deepEqual(listGenerals(cwd).sort(), ['.notes', 'yaoguang'])
      assert.match(readGeneralLedger(cwd, '瑶光')!.content, /always-true-on-missing-field/)
    })

    it('listGenerals returns [] when dir missing', () => {
      assert.deepEqual(listGenerals(cwd), [])
    })
  })

  describe('parseLedgerFamilies / topGeneralFamilies', () => {
    it('extracts family headings with count, lastSeen and signature', () => {
      const families = parseLedgerFamilies(FIXTURE_LEDGER)
      assert.equal(families.length, 2)
      assert.deepEqual(families[0], {
        family: 'always-true-on-missing-field',
        recurrenceCount: 4,
        lastSeen: '2026-06-07',
        signature: '某字段缺失时，比较/匹配逻辑退化为恒真。',
      })
      assert.equal(families[1]!.family, 'false-green')
      assert.equal(families[1]!.recurrenceCount, 1)
    })

    it('topGeneralFamilies sorts by recurrenceCount desc and caps at n', () => {
      seedLedger()
      const top = topGeneralFamilies(cwd, '瑶光', 1)
      assert.equal(top.length, 1)
      assert.equal(top[0]!.family, 'always-true-on-missing-field')
      assert.deepEqual(topGeneralFamilies(cwd, '天梁'), [], '无账本 → []')
    })
  })

  describe('appendGeneralFinding', () => {
    it('recurrence: bumps count, updates lastSeen, appends instance line inside the section', () => {
      seedLedger()
      const result = appendGeneralFinding(cwd, {
        star: '瑶光',
        family: 'always-true-on-missing-field',
        note: '在 X 模块又见同族',
        date: '2026-07-04',
      })
      assert.deepEqual(result, { slug: 'yaoguang', created: false, recurrenceCount: 5 })
      const content = readFileSync(generalLedgerPath(cwd, 'yaoguang'), 'utf-8')
      assert.match(content, /### always-true-on-missing-field \| recurrenceCount: 5 \| lastSeen: 2026-07-04/)
      // 实例行落在该族段内（false-green 段之前）
      const idxInstance = content.indexOf('- 2026-07-04 在 X 模块又见同族')
      const idxNext = content.indexOf('### false-green')
      assert.ok(idxInstance > 0 && idxInstance < idxNext, '实例行必须在同族段落内')
      // 其他族不受影响
      assert.match(content, /### false-green \| recurrenceCount: 1 \| lastSeen: 2026-06-07/)
    })

    it('new family: appends a fresh section before the trailing comment', () => {
      seedLedger()
      const result = appendGeneralFinding(cwd, {
        star: 'yaoguang',
        family: 'silent-mute-stack',
        note: '多层各自合理的改动叠加成静音栈',
        date: '2026-07-04',
      })
      assert.deepEqual(result, { slug: 'yaoguang', created: true, recurrenceCount: 1 })
      const content = readFileSync(generalLedgerPath(cwd, 'yaoguang'), 'utf-8')
      const idxNew = content.indexOf('### silent-mute-stack | recurrenceCount: 1 | lastSeen: 2026-07-04')
      const idxComment = content.indexOf('<!--')
      assert.ok(idxNew > 0)
      assert.ok(idxNew < idxComment, '新族段落插在尾注之前')
    })

    it('creates a skeleton ledger when the file does not exist', () => {
      const result = appendGeneralFinding(cwd, {
        star: '贪狼',
        family: 'capability-archaeology',
        note: '半接线能力盘点',
        date: '2026-07-04',
      })
      assert.deepEqual(result, { slug: 'tanlang', created: true, recurrenceCount: 1 })
      const content = readFileSync(generalLedgerPath(cwd, 'tanlang'), 'utf-8')
      assert.match(content, /# 将星 · 贪狼/)
      assert.match(content, /### capability-archaeology \| recurrenceCount: 1/)
      // round-trip：新建的账本可被解析
      assert.equal(parseLedgerFamilies(content).length, 1)
    })

    it('returns null for unknown star', () => {
      assert.equal(appendGeneralFinding(cwd, { star: '未知', family: 'x', note: 'y' }), null)
    })
  })

  // G3（静音之道 Y8）：账本机制自己也要有账本——读/写各落一个遥测事件。
  describe('telemetry sink', () => {
    it('emits read and write events; sink errors never break ledger I/O', () => {
      seedLedger()
      const events: GeneralLedgerTelemetryEvent[] = []
      setGeneralLedgerTelemetrySink(e => events.push(e))
      try {
        readGeneralLedger(cwd, '瑶光')
        assert.equal(events.length, 1)
        assert.deepEqual(events[0], { kind: 'general-ledger', op: 'read', star: '瑶光', slug: 'yaoguang' })

        const res = appendGeneralFinding(cwd, { star: '瑶光', family: 'false-green', note: 'x', date: '2026-07-05' })
        assert.equal(res!.recurrenceCount, 2)
        assert.equal(events.length, 2)
        assert.equal(events[1]!.op, 'write')
        assert.equal(events[1]!.family, 'false-green')
        assert.equal(events[1]!.created, false)
        assert.equal(events[1]!.recurrenceCount, 2)

        // 抛错的 sink 被吞——账本 I/O 不受影响
        setGeneralLedgerTelemetrySink(() => { throw new Error('boom') })
        const ok = readGeneralLedger(cwd, '瑶光')
        assert.ok(ok, 'ledger read survives a throwing sink')
      } finally {
        setGeneralLedgerTelemetrySink(null)
      }
    })
  })

  describe('recall_general tool', () => {
    it('returns ledger content for known star with ledger', async () => {
      seedLedger()
      const tool = createRecallGeneralTool(() => cwd)
      const res = await tool.execute({ input: { star: '瑶光' }, cwd, toolUseId: 'tu_test' })
      assert.equal(res.isError, false)
      assert.match(res.content, /always-true-on-missing-field/)
    })

    it('errors for unknown star / missing ledger', async () => {
      seedLedger()
      const tool = createRecallGeneralTool(() => cwd)
      const unknown = await tool.execute({ input: { star: '未知星' }, cwd, toolUseId: 'tu_test' })
      assert.equal(unknown.isError, true)
      // 消息中文化第二波：recall-general 错误文案已翻译
      assert.match(unknown.content, /未知星域/)
      const noLedger = await tool.execute({ input: { star: '天梁' }, cwd, toolUseId: 'tu_test' })
      assert.equal(noLedger.isError, true)
      assert.match(noLedger.content, /record_general_finding/)
    })
  })

  describe('record_general_finding tool', () => {
    it('appends and reports recurrence semantics', async () => {
      seedLedger()
      const tool = createRecordGeneralFindingTool(() => cwd)
      const res = await tool.execute({
        input: { star: '瑶光', family: 'false-green', note: '又一处虚假绿灯' },
        cwd,
        toolUseId: 'tu_test',
      })
      assert.equal(res.isError, false)
      assert.match(res.content, /recurrenceCount: 2/)
    })

    it('rejects non-kebab family slugs and missing fields', async () => {
      const tool = createRecordGeneralFindingTool(() => cwd)
      const bad = await tool.execute({ input: { star: '瑶光', family: '中文族名', note: 'x' }, cwd, toolUseId: 'tu_test' })
      assert.equal(bad.isError, true)
      const missing = await tool.execute({ input: { star: '瑶光', family: '', note: '' }, cwd, toolUseId: 'tu_test' })
      assert.equal(missing.isError, true)
    })
  })
})

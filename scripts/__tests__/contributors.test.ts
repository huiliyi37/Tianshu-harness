import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseContributorsMarkdown,
  mergeContributors,
  renderContributorsMarkdown,
  diffContributors,
  type ContributorPr,
} from '../contributors.js'

const SAMPLE = `# Contributors ✨

感谢以下贡献者（按首次贡献时间排序）：

| 贡献者 | 贡献 | PR |
|--------|------|-----|
| **alice** | 修了 A 与 B | [#1](https://github.com/huiliyi37/Tianshu-harness/pull/1), [#2](https://github.com/huiliyi37/Tianshu-harness/pull/2) |
| **bob** | 重写 C | [#3](https://github.com/huiliyi37/Tianshu-harness/pull/3) |

页脚说明：本文件由脚本维护。
`

const PRS: ContributorPr[] = [
  { number: 1, login: 'alice', title: 'fix: A', state: 'CLOSED', createdAt: '2026-01-01T00:00:00Z' },
  { number: 2, login: 'alice', title: 'fix: B', state: 'CLOSED', createdAt: '2026-01-02T00:00:00Z' },
  { number: 3, login: 'bob', title: 'feat: C', state: 'MERGED', createdAt: '2026-01-03T00:00:00Z' },
  { number: 4, login: 'carol', title: 'fix: D', state: 'CLOSED', createdAt: '2026-01-04T00:00:00Z' },
]

describe('contributors 名单（收编流程适配）', () => {
  it('解析现有表格：login / 人工描述 / PR 列表', () => {
    const entries = parseContributorsMarkdown(SAMPLE)
    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.login, 'alice')
    assert.equal(entries[0]?.description, '修了 A 与 B')
    assert.deepEqual(entries[0]?.prs, [1, 2])
    assert.equal(entries[1]?.login, 'bob')
    assert.deepEqual(entries[1]?.prs, [3])
  })

  it('合并时绝不删除既有条目——这是旧脚本清空名单的根因', () => {
    // 既有条目 bob 的 PR 完全不在 PR 数据里（例如超出 gh 分页 / 数据源不可用），
    // 仍必须原地保留：宁可有陈旧条目，也不能静默丢人。
    const partial: ContributorPr[] = [PRS[0]!, PRS[1]!, PRS[3]!]
    const { entries } = mergeContributors(parseContributorsMarkdown(SAMPLE), partial)
    const logins = entries.map(e => e.login)
    assert.ok(logins.includes('alice'))
    assert.ok(logins.includes('bob'), '数据源未覆盖的既有条目不得被删除')
  })

  it('保留人工撰写的描述，不被自动文本覆盖', () => {
    const { entries } = mergeContributors(parseContributorsMarkdown(SAMPLE), PRS)
    assert.equal(entries.find(e => e.login === 'alice')?.description, '修了 A 与 B')
    assert.equal(entries.find(e => e.login === 'bob')?.description, '重写 C')
  })

  it('追加新贡献者，并按首次贡献时间放到正确位置', () => {
    const { entries, added } = mergeContributors(parseContributorsMarkdown(SAMPLE), PRS)
    assert.deepEqual(added, ['carol'])
    assert.deepEqual(entries.map(e => e.login), ['alice', 'bob', 'carol'])
  })

  it('补录一个更早的历史贡献者时插到前面', () => {
    const withEarly: ContributorPr[] = [
      ...PRS,
      { number: 7, login: 'dave', title: 'fix: early', state: 'CLOSED', createdAt: '2025-12-31T00:00:00Z' },
    ]
    const { entries } = mergeContributors(parseContributorsMarkdown(SAMPLE), withEarly)
    assert.deepEqual(entries.map(e => e.login), ['dave', 'alice', 'bob', 'carol'])
  })

  it('把已有作者的新 PR 并入既有列表（去重升序），并报出新增项', () => {
    const withNew: ContributorPr[] = [
      ...PRS,
      { number: 9, login: 'alice', title: 'fix: I', state: 'CLOSED', createdAt: '2026-01-09T00:00:00Z' },
      { number: 2, login: 'alice', title: 'fix: B（重复条目）', state: 'CLOSED', createdAt: '2026-01-02T00:00:00Z' },
    ]
    const { entries, newPrs } = mergeContributors(parseContributorsMarkdown(SAMPLE), withNew)
    assert.deepEqual(entries.find(e => e.login === 'alice')?.prs, [1, 2, 9])
    assert.deepEqual(newPrs.get('alice'), [9])
  })

  it('渲染结果可被再次解析，且二次合并无变化（幂等往返）', () => {
    const first = mergeContributors(parseContributorsMarkdown(SAMPLE), PRS)
    const md1 = renderContributorsMarkdown(first.entries)
    const second = mergeContributors(parseContributorsMarkdown(md1), PRS)
    const md2 = renderContributorsMarkdown(second.entries)
    assert.equal(md1, md2)
    assert.equal(second.added.length, 0)
    assert.equal(second.newPrs.size, 0)
  })

  it('对账：报告未登记的作者与 PR', () => {
    const { missingLogins, missingPrs } = diffContributors(parseContributorsMarkdown(SAMPLE), PRS)
    assert.deepEqual(missingLogins, ['carol'])
    assert.deepEqual(missingPrs, [])

    const stale = parseContributorsMarkdown(SAMPLE)
    const { missingLogins: none, missingPrs: p } = diffContributors(stale, PRS.slice(0, 3))
    assert.deepEqual(none, [])
    assert.deepEqual(p, [])
  })

  it('新条目的描述列给出 PR 标题初稿并标记待润色', () => {
    const { entries } = mergeContributors(parseContributorsMarkdown(SAMPLE), PRS)
    const carol = entries.find(e => e.login === 'carol')
    assert.ok(carol)
    assert.match(carol.description, /fix: D/)
    assert.match(carol.description, /待润色/)
  })
})

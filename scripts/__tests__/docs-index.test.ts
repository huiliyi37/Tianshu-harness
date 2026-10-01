/**
 * docs-index 的「子集检出」口径（issue #176）。
 *
 * 公开仓的 docs/ 是开发仓文档树的**子集**：索引在开发仓生成、随同步进公开仓，因此
 * `docs/docs.json` 里登记的绝大多数条目在本仓并不存在。`related`/`supersedes` 引用这些
 * 「索引已知、本仓未行」的文档不是作者写错了路径——旧版把它们一律判成 frontmatter 错误，
 * `npm run docs:check` 因此在公开仓恒红 13 条（RED：退出码 1）。
 *
 * 这里锁三件事：
 *   1. 引用「索引已知但未分发」的文档 → 只进 `unshipped`，不进 `errors`；
 *   2. 引用「索引里也没有」的路径 → 仍然进 `errors`——放宽不能变成把关掉；
 *   3. schema 错误（type/status/date/必填字段）在任何情况下都仍是 `errors`。
 *
 * 第 2、3 条是这套放宽的成本护栏：没有它们，改法会退化成「把校验关了」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkDocs,
  describeIndexCoverage,
  loadKnownIndexPaths,
  toRepoRelative,
  type DocMeta,
} from '../docs-index.js'

/** 规范 frontmatter 的最小合法形状；extra 用于追加 related/supersedes 等字段。 */
function frontmatter(extra = ''): string {
  return `---\ntitle: 测试文档\ntype: plan\nstatus: draft\ndate: 2026-07-31\n${extra}---\n\n# 测试文档\n`
}

function meta(over: Partial<DocMeta> & { path: string }): DocMeta {
  return {
    title: '测试文档',
    type: 'plan',
    typeSource: 'frontmatter',
    status: 'draft',
    statusSource: 'frontmatter',
    date: '2026-07-31',
    related: [],
    supersedes: '',
    tags: [],
    hasFrontmatter: true,
    ...over,
  }
}

const known = new Set(['docs/design/2026-08-01-galaxy-mechanism-convergence.md'])

describe('docs-index — 子集检出下的 related/supersedes 口径', () => {
  it('引用「索引已知、本仓未分发」的文档：进 unshipped，不进 errors', () => {
    const docs = [meta({ path: 'plans/2026-07-31-a.md', related: ['../design/2026-08-01-galaxy-mechanism-convergence.md'] })]
    const report = checkDocs(docs, { knownIndexPaths: known, readFrontmatter: () => frontmatter() })

    assert.deepEqual(report.errors, [], '索引已知的未分发引用不该判失败（这正是 #176 的 13 条）')
    assert.equal(report.unshipped.length, 1)
    assert.match(report.unshipped[0].message, /未随本仓分发/)
    assert.match(report.unshipped[0].message, /galaxy-mechanism-convergence/)
  })

  it('引用「索引里也没有」的路径：仍然判失败——放宽不能把关掉', () => {
    const docs = [meta({ path: 'plans/2026-07-31-b.md', related: ['../design/typo-does-not-exist.md'] })]
    const report = checkDocs(docs, { knownIndexPaths: known, readFrontmatter: () => frontmatter() })

    assert.equal(report.unshipped.length, 0)
    assert.equal(report.errors.length, 1)
    assert.match(report.errors[0].message, /指向不存在的文件/)
  })

  it('不给已知索引（空集，= 索引缺失时的严格口径）：未分发引用按错误处理', () => {
    const docs = [meta({ path: 'plans/2026-07-31-c.md', related: ['../design/2026-08-01-galaxy-mechanism-convergence.md'] })]
    const report = checkDocs(docs, { readFrontmatter: () => frontmatter() })

    assert.equal(report.unshipped.length, 0)
    assert.equal(report.errors.length, 1, '没有索引可比对时必须退回旧版严格口径：宁可真红，不可假绿')
  })

  it('目标文件真在磁盘上时：既不报错也不进 unshipped', () => {
    // docs/README.md 真实存在；从 docs/plans/ 相对引用它是 `../README.md`
    const docs = [meta({ path: 'plans/2026-07-31-d.md', related: ['../README.md'] })]
    const report = checkDocs(docs, { knownIndexPaths: known, readFrontmatter: () => frontmatter() })

    assert.deepEqual(report.errors, [])
    assert.deepEqual(report.unshipped, [])
  })

  it('schema 错误不被子集放宽掩盖（type 非法 + 未分发引用并存）', () => {
    const docs = [
      meta({
        path: 'plans/2026-07-31-e.md',
        related: ['../design/2026-08-01-galaxy-mechanism-convergence.md'],
      }),
    ]
    const report = checkDocs(docs, {
      knownIndexPaths: known,
      readFrontmatter: () => frontmatter().replace('type: plan', 'type: bogus'),
    })

    assert.equal(report.unshipped.length, 1, '未分发引用仍应被识别')
    assert.equal(report.errors.length, 1, 'type 非法必须still 是错误')
    assert.match(report.errors[0].message, /type 非法/)
  })

  it('supersedes 与 related 同一口径', () => {
    const docs = [meta({ path: 'plans/2026-07-31-f.md', supersedes: '../design/2026-08-01-galaxy-mechanism-convergence.md' })]
    const report = checkDocs(docs, { knownIndexPaths: known, readFrontmatter: () => frontmatter() })

    assert.deepEqual(report.errors, [])
    assert.equal(report.unshipped.length, 1)
  })
})

describe('docs-index — 路径归一', () => {
  it('仓库根相对写法与文档目录相对写法归一到同一路径', () => {
    const repoRoot = process.cwd()
    const fromDocDir = toRepoRelative('plans/2026-07-31-a.md', '../design/x.md', repoRoot)
    const fromRepoRoot = toRepoRelative('plans/2026-07-31-a.md', 'docs/design/x.md', repoRoot)

    assert.equal(fromDocDir, 'docs/design/x.md')
    assert.equal(fromRepoRoot, 'docs/design/x.md')
    assert.equal(fromDocDir, fromRepoRoot, '两种写法必须落到同一个键，否则索引比对会漏')
  })

  it('markdown 链接写法与锚点同样归一，外链返回 null', () => {
    const repoRoot = process.cwd()
    assert.equal(toRepoRelative('plans/a.md', '[文本](../design/x.md#小节)', repoRoot), 'docs/design/x.md')
    assert.equal(toRepoRelative('plans/a.md', 'https://example.com/x.md', repoRoot), null)
    assert.equal(toRepoRelative('plans/a.md', '', repoRoot), null)
  })

  it('逃出仓库的路径不算「索引已知」', () => {
    // docs/plans/ 往上三级才越过仓库根（上一级只到仓库根，仍在仓内）
    assert.equal(toRepoRelative('plans/a.md', '../../../outside.md', process.cwd()), null)
  })
})

describe('docs-index — 索引读取与覆盖度提示', () => {
  it('loadKnownIndexPaths 读 docs.json 的 path 列', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-docs-index-'))
    try {
      const file = join(dir, 'docs.json')
      writeFileSync(file, JSON.stringify({ count: 2, docs: [{ path: 'docs/a.md' }, { path: 'docs/b.md' }, {}] }))
      assert.deepEqual([...loadKnownIndexPaths(file)].sort(), ['docs/a.md', 'docs/b.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadKnownIndexPaths 在索引缺失/损坏时返回空集（不抛）', () => {
    assert.equal(loadKnownIndexPaths(join(tmpdir(), 'definitely-absent-docs.json')).size, 0)
  })

  it('describeIndexCoverage：本仓缺条目时给出子集提示，完整树返回 null', () => {
    const docs = [meta({ path: 'README-ish.md' })]
    const subset = describeIndexCoverage(new Set(['docs/a.md', 'docs/b.md']), docs)
    assert.ok(subset && /子集/.test(subset) && /2 篇/.test(subset), `实际：${subset}`)

    const complete = describeIndexCoverage(new Set(['docs/README-ish.md']), docs)
    assert.equal(complete, null, '索引与磁盘一致时必须给 null——完整树下行为不能变')
    assert.equal(describeIndexCoverage(new Set(), docs), null, '没有索引可比对时不提示')
  })
})

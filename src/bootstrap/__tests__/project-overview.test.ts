import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_RIVET_MD_HEAD, OVERVIEW_BEGIN, OVERVIEW_END, refreshProjectOverview, renderOverview, scanProjectOverview,
  summarizeReadme, upsertOverviewSection, ownProjectOverview,
} from '../project-overview.js'
import { needsTemplatesInit } from '../project-templates.js'

let root: string
let home: string
let prevHome: string | undefined

function seedProject(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test', build: 'tsc -p .' } }))
  writeFileSync(join(dir, 'README.md'), '# Demo\n\n![badge](x.svg)\n\nA tiny ledger service for tests.\n')
  mkdirSync(join(dir, 'src', 'api'), { recursive: true })
  mkdirSync(join(dir, 'src', '__tests__'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), 'export {}\n')
  writeFileSync(join(dir, 'src', 'api', 'routes.ts'), 'export {}\n')
  writeFileSync(join(dir, 'src', '__tests__', 'routes.test.ts'), 'export {}\n')
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'overview-proj-'))
  home = mkdtempSync(join(tmpdir(), 'overview-home-'))
  prevHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
})
afterEach(() => {
  if (prevHome === undefined) delete process.env.RIVET_HOME
  else process.env.RIVET_HOME = prevHome
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('project overview scan', () => {
  it('collects stack, commands, entries, tests and README, skipping node_modules', async () => {
    seedProject(root)
    const scan = await scanProjectOverview(root)
    assert.equal(scan.files, 5, 'node_modules must be pruned')
    assert.deepEqual(scan.languages[0], { name: 'TypeScript', files: 3 })
    assert.deepEqual(scan.scripts, { build: 'tsc -p .', test: 'node --test' })
    assert.deepEqual(scan.entries, ['src/index.ts'])
    assert.equal(scan.tests.count, 1)
    assert.deepEqual(scan.tests.dirs, ['src/__tests__'])
    assert.match(scan.readme ?? '', /A tiny ledger service for tests\./)
    assert.doesNotMatch(scan.readme ?? '', /badge/)
    const text = renderOverview(scan)
    assert.match(text, /test → `node --test`/)
    assert.match(text, /`src\/api\/` — 1 个文件/)
  })
})

describe('summarizeReadme', () => {
  it('keeps the title and the first paragraph, and lists H2 sections instead of flattening the whole file', () => {
    const raw = '# 会议室预订 REST 服务\n\n基于 Node 原生 `node:http` 实现的会议室预订服务，数据全部保存在内存中。\n\n## 启动\n\n```bash\nnpm start\n```\n\n服务端口读取环境变量 `PORT`。\n\n## 运行测试\n\n## API 概览\n\n- `GET /health` — 健康检查\n'
    const r = summarizeReadme(raw)
    assert.equal(r.summary, '会议室预订 REST 服务 — 基于 Node 原生 `node:http` 实现的会议室预订服务，数据全部保存在内存中。')
    assert.deepEqual(r.sections, ['启动', '运行测试', 'API 概览'])
  })

  it('reads setext titles and blockquote taglines, and cuts long text at a sentence end', () => {
    const r = summarizeReadme(`Ledger\n======\n\n> The ledger keeps every transaction in one append-only file. ${'x'.repeat(300)}\n`)
    assert.equal(r.summary, 'Ledger — The ledger keeps every transaction in one append-only file.')
    const noStop = summarizeReadme(`# T\n\n${'y'.repeat(237)}... ${'z'.repeat(50)}\n`)
    assert.equal(noStop.summary, `T — ${'y'.repeat(237)}…`, 'hard cut drops trailing dots before the ellipsis')
  })

  it('reads centered HTML READMEs: <h1> title, skips badge and nav rows, drops emoji and the TOC from sections', () => {
    const raw = [
      '<p align="center">', '  <img src="docs/banner.jpg" alt="Orbit" width="100%">', '</p>', '',
      '<h1 align="center">Orbit <sub>Deploy Kit</sub></h1>', '',
      '<p align="center">', '  <a href="https://example.com"><b>🌐 官网</b></a> ·', '  🇨🇳 <b>中文</b> ·', '  <a href="README.en.md">English</a>', '</p>', '',
      '[![CI](https://img.shields.io/badge/ci-passing-green)](https://ci.example.com)', '',
      '<p align="center"><b>一条命令把服务部署到你自己的机器上。</b></p>', '',
      '## 目录', '', '## 🚀 快速开始', '', '## ✨ 核心特性 {#features}', '',
    ].join('\n')
    const r = summarizeReadme(raw)
    assert.equal(r.summary, 'Orbit Deploy Kit — 一条命令把服务部署到你自己的机器上。')
    assert.deepEqual(r.sections, ['快速开始', '核心特性'])
  })

  it('joins wrapped CJK lines without a stray space and strips bold and link markup', () => {
    const r = summarizeReadme('# 看板\n\n**原生 TypeScript** 实现的看板组件，\n支持拖拽和[键盘操作](docs/keys.md)。\nWorks offline.\n')
    assert.equal(r.summary, '看板 — 原生 TypeScript 实现的看板组件，支持拖拽和键盘操作。 Works offline.')
  })
})

describe('upsertOverviewSection', () => {
  it('appends once, then replaces in place without touching hand-written text', () => {
    const hand = '# Project\n\n## Conventions\n- 用 pnpm\n'
    const once = upsertOverviewSection(hand, 'A')
    assert.ok(once.startsWith(hand.trimEnd()))
    assert.ok(once.includes(`${OVERVIEW_BEGIN}\nA\n${OVERVIEW_END}`))
    const edited = once.replace('- 用 pnpm', '- 用 pnpm\n- 中文注释')
    const twice = upsertOverviewSection(edited, 'B')
    assert.ok(twice.includes('- 中文注释'), 'user edits outside markers survive')
    assert.ok(twice.includes(`${OVERVIEW_BEGIN}\nB\n${OVERVIEW_END}`))
    assert.equal(twice.split(OVERVIEW_BEGIN).length, 2, 'exactly one auto section')
  })
})

describe('refreshProjectOverview', () => {
  it('writes .rivet.md on a fresh project, retires the template prompt, then skips when nothing changed', async () => {
    seedProject(root)
    assert.equal(needsTemplatesInit(root), true)
    assert.equal((await refreshProjectOverview(root)).status, 'written')
    const md = readFileSync(join(root, '.rivet.md'), 'utf8')
    assert.ok(md.includes(OVERVIEW_BEGIN) && md.includes('## 项目概况（自动维护）'))
    assert.ok(md.startsWith(AUTO_RIVET_MD_HEAD.trimEnd()), 'fresh file starts with the short head')
    assert.doesNotMatch(md, /## Stack|- Language:/, 'no empty placeholders read into every session')
    assert.match(md, /简介：Demo — A tiny ledger service for tests\./)
    assert.equal(needsTemplatesInit(root), false, 'old template prompt no longer fires')
    assert.equal(existsSync(join(root, '.rivet', 'overview-state.json')), false, 'state lives outside the project')
    assert.equal((await refreshProjectOverview(root)).status, 'unchanged')
    assert.equal(readFileSync(join(root, '.rivet.md'), 'utf8'), md, 'no rewrite when unchanged')
    assert.ok(ownProjectOverview(root)?.includes('## 项目概况（自动维护）'))
  })

  it('updates the section after the project changes and keeps user text', async () => {
    seedProject(root)
    writeFileSync(join(root, '.rivet.md'), '# Project\n\n## Conventions\n- 手写约定\n')
    await refreshProjectOverview(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }))
    assert.equal((await refreshProjectOverview(root)).status, 'written')
    const md = readFileSync(join(root, '.rivet.md'), 'utf8')
    assert.match(md, /test → `vitest run`/)
    assert.match(md, /- 手写约定/)
  })

  it('never throws: a missing workspace is skipped', async () => {
    assert.equal((await refreshProjectOverview(join(root, 'gone'))).status, 'skipped')
  })
})

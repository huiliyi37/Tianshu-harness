import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LIST_LIMIT,
  formatWorkspaceList,
  isHiddenName,
  listWorkspaces,
  pickWorkspaces,
  resolveWorkspaceRoot,
} from '../lib/workspaces.mjs'

/** 复刻本机真实形状：根下有隐藏的数据目录，3 个工作区各自内部还带一份 .rivet/。 */
const realShapeFs = () => ({
  readdirSync: () => [
    { name: '.rivet', isDirectory: () => true },
    { name: 'bridge天枢默认', isDirectory: () => true },
    { name: 'coding', isDirectory: () => true },
    { name: '日常', isDirectory: () => true },
    { name: 'README.md', isDirectory: () => false },
  ],
})

// ── 枚举根解析 ───────────────────────────────────────────────

test('resolveWorkspaceRoot: 取配置项的父目录', () => {
  assert.equal(resolveWorkspaceRoot('D:\\path\\to\\bridge天枢默认'), 'D:\\path\\to')
})

test('resolveWorkspaceRoot: 已带尾分隔符也能推', () => {
  assert.equal(resolveWorkspaceRoot('D:\\path\\to\\coding\\'), 'D:\\path\\to')
})

test('resolveWorkspaceRoot: 未配置/空/非字符串 → null', () => {
  assert.equal(resolveWorkspaceRoot(''), null)
  assert.equal(resolveWorkspaceRoot('   '), null)
  assert.equal(resolveWorkspaceRoot(undefined), null)
  assert.equal(resolveWorkspaceRoot(null), null)
  assert.equal(resolveWorkspaceRoot(123), null)
})

// ── 排除规则 ─────────────────────────────────────────────────

test('isHiddenName: 点开头才算隐藏', () => {
  assert.equal(isHiddenName('.rivet'), true)
  assert.equal(isHiddenName('.git'), true)
  assert.equal(isHiddenName('coding'), false)
  assert.equal(isHiddenName(''), false)
  assert.equal(isHiddenName(undefined), false)
})

test('pickWorkspaces: 排除隐藏项与非目录，并做码点序排序', () => {
  const names = pickWorkspaces([
    { name: '日常', isDirectory: true },
    { name: '.rivet', isDirectory: true },
    { name: 'README.md', isDirectory: false },
    { name: 'coding', isDirectory: true },
    { name: 'bridge天枢默认', isDirectory: true },
    { name: '', isDirectory: true },
  ])
  assert.deepEqual(names, ['bridge天枢默认', 'coding', '日常'])
})

test('回归: 工作区内部自带的 .rivet/meridian.db 不得导致它被排除', () => {
  // 实盘踩过的坑：曾按「含 .rivet 或 meridian.db 就排除」实现，结果 3/3 个真工作区被误杀
  const names = pickWorkspaces(
    [
      { name: '.rivet', isDirectory: true },
      { name: 'bridge天枢默认', isDirectory: true },
      { name: 'coding', isDirectory: true },
      { name: '日常', isDirectory: true },
    ],
    // 第二参已被废除；就算调用方硬塞一个「所有目录都含标记」的判定，也不应影响结果
    { root: 'D:/x', hasDataMarker: () => true },
  )
  assert.deepEqual(names, ['bridge天枢默认', 'coding', '日常'], '真工作区必须全部列出')
})

test('pickWorkspaces: 入参畸形不炸', () => {
  assert.deepEqual(pickWorkspaces(null), [])
  assert.deepEqual(pickWorkspaces([null, undefined, 1]), [])
})

// ── 格式化与编号 ─────────────────────────────────────────────

test('formatWorkspaceList: 编号从 1 起、与清单顺序一致、带总数与根目录', () => {
  const r = formatWorkspaceList(['bridge天枢默认', 'coding', '日常'], { root: 'D:\\path\\to' })
  assert.deepEqual(r.lines.slice(0, 2), ['可用工作区（3 个）', '根目录：D:\\path\\to'])
  assert.deepEqual(r.lines.slice(2), ['1. bridge天枢默认', '2. coding', '3. 日常'])
  assert.equal(r.total, 3)
  assert.equal(r.shown, 3)
  assert.equal(r.truncated, false)
})

test('formatWorkspaceList: 空清单给明确提示而不是空白', () => {
  const r = formatWorkspaceList([], { root: 'D:/x' })
  assert.match(r.text, /没有可用工作区/)
  assert.equal(r.total, 0)
})

test('formatWorkspaceList: 超出上限时截断并给出提示', () => {
  const names = Array.from({ length: 25 }, (_, i) => `ws${String(i).padStart(2, '0')}`)
  const r = formatWorkspaceList(names, { root: 'D:/x', limit: DEFAULT_LIST_LIMIT })
  assert.equal(r.shown, 20)
  assert.equal(r.truncated, true)
  assert.match(r.text, /还有 5 个未列出/)
  assert.ok(!r.text.includes('ws24'), '未列出的不应出现')
})

test('formatWorkspaceList: 默认上限为正整数，畸形 limit 回落到默认', () => {
  const names = ['a', 'b', 'c']
  assert.equal(formatWorkspaceList(names, { limit: 0 }).shown, 3)
  assert.equal(formatWorkspaceList(names, { limit: -1 }).shown, 3)
  assert.equal(formatWorkspaceList(names, { limit: 'x' }).shown, 3)
})

// ── 取数（注入 fs）─────────────────────────────────────────

test('listWorkspaces: 本机真实形状 → 3 个可用、排除 1 个隐藏项', () => {
  const r = listWorkspaces({
    workspace: 'D:\\path\\to\\bridge天枢默认',
    fsImpl: realShapeFs(),
  })
  assert.equal(r.error, null)
  assert.equal(r.root, 'D:\\path\\to')
  assert.deepEqual(r.names, ['bridge天枢默认', 'coding', '日常'])
  assert.equal(r.entries, 5)
  assert.equal(r.excluded, 2, '隐藏目录 1 个 + 非目录 1 个')
})

test('listWorkspaces: 未配置 workspace 时不猜不扫，回一句可读提示', () => {
  const r = listWorkspaces({ workspace: null, fsImpl: realShapeFs() })
  assert.equal(r.root, null)
  assert.deepEqual(r.names, [])
  assert.match(r.error, /未配置工作区根目录/)
})

test('listWorkspaces: 根目录读不动时报错带上路径', () => {
  const r = listWorkspaces({
    workspace: 'D:\\nope\\x',
    fsImpl: { readdirSync: () => { throw new Error('EACCES') } },
  })
  assert.deepEqual(r.names, [])
  assert.match(r.error, /D:\\nope/)
  assert.match(r.error, /EACCES/)
})

/**
 * `withNodeOnPath` 的排位契约（issue #408）。
 *
 * ## 缺陷现场
 * 打包桌面端的 `node-runtime/<os>-<arch>/` 在 Windows 上只有 `node.cmd` 转发器
 * （`@ECHO OFF` + `"%~dp0tianshu-runtime.exe" %*`），没有真 `node.exe`。原实现对
 * 该目录无条件 prepend，于是 shell / npm 子进程解析 `node` 时命中转发器，劫持掉
 * 用户系统里的真 Node——`npm exec` / `npm run` 里经 cmd 层启动 node 的脚本失败，
 * 报错指向一个当前目录下不存在的相对路径（issue #408 复现记录）。
 *
 * 修完的判据两条，都断言在这里：
 *  - 目录里**有**真 node → 仍 prepend（issue #149：子进程要能找到同一个 node）；
 *  - 目录里**只有转发器** → append 到末尾，系统真 node 优先，bundled 目录仍可找到。
 *
 * 用例走注入的 deps（平台 / 基座 PATH / 文件系统判定），不依赖宿主平台——真机
 * 上跑不出 win32 分支。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withNodeOnPath } from '../plugin-installer.js'

const WIN_NODE_DIR = 'E:\\tianshu\\node-runtime\\win-x64'
const POSIX_NODE_DIR = '/opt/tianshu/node-runtime/linux-x64'

describe('withNodeOnPath — 有真 node 时 prepend（issue #149 行为）', () => {
  it('win32: 目录里有 node.exe → 排在基座 PATH 之前', () => {
    const out = withNodeOnPath(WIN_NODE_DIR, {
      platform: 'win32',
      path: 'D:\\nvm\\nodejs;C:\\Windows\\System32',
      existsSync: (p) => p === `${WIN_NODE_DIR}\\node.exe`,
    })
    assert.equal(out, `${WIN_NODE_DIR};D:\\nvm\\nodejs;C:\\Windows\\System32`)
  })

  it('posix: 目录里有 node → 排在基座 PATH 之前，分隔符是 :', () => {
    const out = withNodeOnPath(POSIX_NODE_DIR, {
      platform: 'linux',
      path: '/usr/bin:/bin',
      existsSync: (p) => p === `${POSIX_NODE_DIR}/node`,
    })
    assert.equal(out, `${POSIX_NODE_DIR}:/usr/bin:/bin`)
  })
})

describe('withNodeOnPath — 只有转发器（无真 node）时 append（issue #408）', () => {
  it('win32: 目录里只有 node.cmd 转发器 → 不抢首位，系统 node 优先命中', () => {
    const out = withNodeOnPath(WIN_NODE_DIR, {
      platform: 'win32',
      path: 'D:\\nvm\\nodejs;C:\\Windows\\System32',
      // 模拟 bundled 目录的实际内容：转发器在，真 node.exe 不在。
      existsSync: (p) => p === `${WIN_NODE_DIR}\\node.cmd`,
    })
    assert.ok(
      out.startsWith('D:\\nvm\\nodejs;'),
      `where node 的第一行应是系统真 node，实际: ${out}`,
    )
    assert.ok(
      out.endsWith(WIN_NODE_DIR),
      `bundled 目录仍须留在 PATH 中（系统无 node 时还有转发器兜底），实际: ${out}`,
    )
  })

  it('posix: 无真 node 时同样 append 到末尾', () => {
    const out = withNodeOnPath(POSIX_NODE_DIR, {
      platform: 'linux',
      path: '/usr/bin:/bin',
      existsSync: () => false,
    })
    assert.equal(out, `/usr/bin:/bin:${POSIX_NODE_DIR}`)
  })
})

describe('withNodeOnPath — 基座 PATH 为空', () => {
  it('基座给不出 PATH 时只返回 nodeDir（没有可 append 的基座）', () => {
    assert.equal(
      withNodeOnPath(WIN_NODE_DIR, { platform: 'win32', path: '', existsSync: () => false }),
      WIN_NODE_DIR,
    )
  })

  it('有真 node 且基座为空时同样只返回 nodeDir', () => {
    assert.equal(
      withNodeOnPath(POSIX_NODE_DIR, { platform: 'linux', path: '', existsSync: () => true }),
      POSIX_NODE_DIR,
    )
  })
})

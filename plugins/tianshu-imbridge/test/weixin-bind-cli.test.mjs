/**
 * 扫码绑定命令行工具的端到端验收。
 *
 * 这条用例的价值在于「真跑一遍」：子进程启动真实 CLI，对着假 iLink 服务器完成
 * 二维码 → 轮询 → 落盘，最后检查 weixin.json 的内容与 stdout 是否泄露凭据。
 * 光看代码看不出「工具到底能不能用」，跑一遍才算数。
 *
 * 依赖一个真实的 node 可执行文件：默认从 process.execPath 取（跑测试用的那个），
 * 需要时用 TIANSHU_NODE_BIN 覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
// fileURLToPath：各平台都给目标 node 认识的原生形式（含 Windows 盘符与前导斜杠修正），
// 并自动解码 URL 里的空格/中文（直接拿 pathname 会带着百分号编码）。
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * WSL 挂载路径 → Windows 路径。**只在执行 node 是 Windows 二进制时才需要**：
 * Linux / macOS 的 node 不认识 `D:\` 形式——对它做转换，spawn 会因 cwd 与脚本路径
 * 都不存在而报 ENOENT（Linux CI / WSL 里跑 Linux node 时踩过）。
 */
const IS_WINDOWS_NODE = process.platform === 'win32'
function toWindowsPath(mixed) {
  if (!IS_WINDOWS_NODE) return mixed
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(mixed)
  if (!match) return mixed
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`
}

async function startFakeBindServer() {
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      const reply = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (String(req.url).includes('get_bot_qrcode')) {
        return reply({ qrcode: 'QR-BIND-1', qrcode_img_content: 'https://weixin.qq.com/q/QR-BIND-1' })
      }
      if (String(req.url).includes('get_qrcode_status')) {
        return reply({
          status: 'confirmed',
          bot_token: 'tk-e2e-abcdef',
          ilink_bot_id: 'wx_bot_e2e',
          ilink_user_id: 'owner-e2e@im.wechat',
          baseurl: 'https://ilinkai.weixin.qq.com/',
        })
      }
      return reply({ ret: 0 })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('weixin-bind: 对着假 iLink 跑完整流程 → weixin.json 落盘且 stdout 不泄露 token', async () => {
  const fake = await startFakeBindServer()
  const home = mkdtempSync(join(tmpdir(), 'wx-bind-'))
  const dataDir = join(home, 'imbridge')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'weixin.json'), JSON.stringify({
    baseUrl: fake.baseUrl,
    ownerUserId: '我还没填',
    enabled: true,
  }))
  try {
    // 执行 CLI 的 node：默认为跑测试的这个（process.execPath）；可用 TIANSHU_NODE_BIN
    // 覆盖为同平台的另一份 node。路径形态按「跑测试的 node 平台」适配。
    const nodeBin = process.env.TIANSHU_NODE_BIN?.trim() || process.execPath
    const nodeHome = toWindowsPath(home)
    const nodeRepo = toWindowsPath(REPO_ROOT)
    const bindTool = join(nodeRepo, 'tools', 'weixin-bind.mjs')
    const { stdout, stderr } = await run(
      nodeBin,
      [bindTool],
      {
        cwd: nodeRepo,
        env: {
          ...process.env,
          RIVET_HOME: nodeHome,
          WSLENV: 'RIVET_HOME',
          // 关掉对外部二维码库与真实桌面的探测，走「打印链接」分支：
          // 只清 TIANSHU_WEIXIN_QR_LIB 不够——qr.mjs 还会按 USERPROFILE/HOME 找宿主目录，
          // paths.mjs 也会拿 USERPROFILE 当桌面，把测试的假码写进主人的真桌面。
          TIANSHU_WEIXIN_QR_LIB: join(nodeRepo, 'node_modules', '__nonexistent__'),
          USERPROFILE: nodeHome,
          HOME: nodeHome,
          APPDATA: nodeHome,
        },
        timeout: 60_000,
      },
    )

    // 落盘：token 与 bot_id 都写进去了，且主人原有的字段没被抹掉
    const written = JSON.parse(readFileSync(join(dataDir, 'weixin.json'), 'utf8'))
    assert.equal(written.botToken, 'tk-e2e-abcdef')
    assert.equal(written.botId, 'wx_bot_e2e')
    assert.equal(written.ownerUserId, '我还没填', '不能抹掉既有字段')
    assert.equal(written.lastBoundAt.length > 0, true)

    // 输出：告诉了主人二维码链接与下一步，但绝不整段打印凭据
    assert.match(stdout, /weixin\.qq\.com\/q\/QR-BIND-1/)
    assert.match(stdout, /绑定成功/)
    assert.match(stdout, /重启天枢/)
    assert.equal(stdout.includes('tk-e2e-abcdef'), false, 'stdout 不许出现完整 token')
    assert.equal(stderr.includes('tk-e2e-abcdef'), false, 'stderr 不许出现完整 token')
    // 掩码形态应当出现（让主人确认写进去了）
    assert.match(stdout, /tk-e…def/)
  } finally {
    await fake.close()
    rmSync(home, { recursive: true, force: true })
  }
})

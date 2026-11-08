/**
 * 插件入口加载冒烟（真机同款环境：Windows node + 真实 RIVET_HOME）。
 *
 * 为什么要有它：入口顶层 import 链一挂，天枢会**静默跳过**整个插件（红线第 1 条）。
 * 单测能钉住接口，但钉不住「真机上 import index.js 会不会炸」——所以这里真加载一次。
 *
 * 4.0.4 / TPI 起，入口是 `export default defineTianshuPlugin(...)`，工具经 activate() 交出。
 * 本脚本因此先装一个最小宿主（globalThis.__tianshuTPI），模拟天枢的加载方式再验证。
 *
 * 用法：RIVET_HOME=<...> "<node.exe>" tools/entry-smoke.mjs
 * 退出码：0 = 入口加载成功且 im_status 可调用；1 = 有问题（原因打到 stderr）。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

// fileURLToPath 而不是裸 pathname：Windows 下 pathname 带前导斜杠（/D:/…），
// 且含空格/中文的路径会是百分号编码——直接喂给 pathToFileURL 会二次编码而打不开。
const pluginIndex = process.argv[2] ?? fileURLToPath(new URL('../index.js', import.meta.url))

// 最小宿主：真实天枢注入的 SDK 会把 spec 注册进内核，这里只需要它可断言。
let registered = null
globalThis.__tianshuTPI = {
  defineTianshuPlugin: (spec) => {
    registered = spec
    return spec
  },
}

try {
  const mod = await import(pathToFileURL(pluginIndex).href)
  const spec = mod?.default ?? registered
  if (!spec || typeof spec.activate !== 'function') {
    throw new Error('入口默认导出不是 TPI 插件描述（缺 activate）')
  }
  if (spec.id !== 'tianshu-imbridge') {
    throw new Error(`插件 id 不符：${JSON.stringify(spec.id)}`)
  }

  const activation = spec.activate()
  const tools = activation?.tools
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('activate() 没有交出 tools 数组（天枢会看不到任何工具）')
  }
  const names = tools.map((t) => t?.name).filter(Boolean)
  if (!names.includes('im_status') || !names.includes('im_send')) {
    throw new Error(`工具清单缺少 im_status / im_send，实得：${JSON.stringify(names)}`)
  }
  for (const t of tools) {
    if (typeof t.execute !== 'function') throw new Error(`工具 ${t.name} 缺 execute`)
    if (typeof t.inputSchema !== 'object') throw new Error(`工具 ${t.name} 缺 inputSchema`)
  }

  // 给常驻启动一点时间跑完（配置读取 + 连接器启动）
  await new Promise((resolve) => setTimeout(resolve, 1_500))

  const status = tools.find((t) => t.name === 'im_status')
  const result = await status.execute({ args: {} })
  const parsed = JSON.parse(result.content)
  console.log('入口加载：OK（TPI）')
  console.log(`工具清单：${JSON.stringify(names)}`)
  console.log(`版本：${parsed.version}`)
  console.log(`通道：QQ=${parsed.channels.qq.connection}(configured=${parsed.channels.qq.configured}) `
    + `微信=${parsed.channels.weixin.connection}(configured=${parsed.channels.weixin.configured})`)
  console.log(`安全：qqOwner=${parsed.security.qqOwnerConfigured} weixinOwner=${parsed.security.weixinOwnerConfigured}`)
  console.log(`桥：${parsed.mode}，sessionMap=${parsed.sessionMapSize}`)
  console.log('SMOKE-RESULT: OK')
} catch (error) {
  console.error(`入口加载失败：${error?.message ?? error}`)
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'))
  console.log('SMOKE-RESULT: FAIL')
  process.exitCode = 1
}

// 加载成功并不意味着进程会退出：入口会起连接器（QQ 网关 / 微信长轮询），
// 这正是它在天枢里应有的形态。所以这里不主动 exit（Windows 上会触发 libuv 断言），
// 由调用方用超时收尾——按 SMOKE-RESULT 标记判断结果。5 秒后若无标记则调用方自行判定。
setTimeout(() => {
  console.log('SMOKE-NOTE: 入口仍在运行（连接器存活，符合预期）')
}, 5_000).unref?.()

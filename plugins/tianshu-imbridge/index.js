/**
 * tianshu-imbridge — TPI 入口（tianshu-harness 4.0.4 / TPI 1.0）。
 *
 * 分工：工具实现在 impl.js，常驻态（配置/连接/桥）在 runtime.js，
 * 这里只做「描述与握手」——把旧契约工具翻译成 TPI 形状，并在宿主激活时启动常驻连接。
 *
 * 骨架纪律（来自 2026-09-24 常驻探针实测）：
 * 1. 入口顶层保持轻量；重依赖一律 lazy-import（本文件只 import 三个同目录模块）。
 * 2. 常驻逻辑每进程只执行一次：activate() 可能被宿主重复调用（工具快照重建），
 *    重复建连会开出多条 QQ/微信连接——QQ 网关对重复连接的分发行为没有官方定义。
 * 3. 插件跑在天枢进程内：一切异步自兜异常，任何失败都不能拖垮天枢本体。
 */
import { defineTianshuPlugin } from './tpi.js'
import { tools as implTools } from './impl.js'
import { startResident, logger } from './runtime.js'

/**
 * 接收文件路径的参数 → 内核守卫模式。
 * 不在此表内的路径参数不会被内核做路径守卫（安全附录 S3）：新增带路径参数的工具时，
 * 必须同时在这里登记，否则等于关掉那道门。
 */
const PATH_PARAMS = { path: 'write', workspace: 'write', dataDir: 'write' }
const WRITE_TOOL = /bind|install|deploy/

export function pathParamsFor(tool) {
  const props = tool.definition.input_schema?.properties ?? {}
  const out = {}
  for (const key of Object.keys(props)) {
    if (!(key in PATH_PARAMS)) continue
    out[key] = PATH_PARAMS[key] === 'write' || (key === 'path' && WRITE_TOOL.test(tool.definition.name))
      ? 'write'
      : 'read'
  }
  return out
}

/** 旧契约工具 → TPI 工具描述（纯函数，单测覆盖）。 */
export function toTpiTools(list) {
  return list.map((tool) => ({
    name: tool.definition.name,
    description: tool.definition.description,
    inputSchema: tool.definition.input_schema,
    concurrencySafe: tool.isConcurrencySafe?.() === true,
    requiresApproval: tool.requiresApproval?.() === true,
    pathParams: pathParamsFor(tool),
    execute: (call) => tool.execute(call.args),
  }))
}

let residentStarted = false

export default defineTianshuPlugin({
  id: 'tianshu-imbridge',
  activate() {
    if (!residentStarted) {
      residentStarted = true
      void startResident().catch((error) => {
        logger.error('常驻启动失败:', error?.message ?? error)
      })
    }
    return { tools: toTpiTools(implTools) }
  },
})

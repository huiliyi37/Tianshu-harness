/**
 * sidecar 插件工具暖场缓存——桌面会话插件装配的同步快照源。
 *
 * 背景：serve-agent 的 buildSessionStores 是同步装配（改 async 涟漪太大），
 * 而 initializePlugins 是异步（readdir + 动态 import）。TUI 的解法是
 * fire-and-forget + agent.updateTools()，sidecar 没有等价的刷新点。故改为
 * 「启动暖场一次 → 每会话同步合入快照」：首个 initializePlugins 跑在
 * runServe 启动期（Node 模块缓存随后使命中），buildSessionStores 同步取
 * 快照注册——暖场未完成的早期会话按无插件装配（与此前行为一致，无回归）。
 *
 * 安全前提（已核）：wrapPluginTool 的 per-call cwd 覆盖 load-time cwd
 * （multi-session 设计），共享缓存不会把首个 cwd 泄漏给其他会话。
 *
 * 失效：安装/启停/卸载插件后 invalidatePluginToolsCache 重建——生效语义与
 * 技能装载一致（下一个新会话生效，不做会话内热切换）。
 */
import { initializePlugins, type PluginConfig, type PluginHookEntry, type PluginCommandEntry } from '../plugins/plugin-loader.js'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
import type { Tool } from '../tools/types.js'

export interface PluginToolsSnapshot {
  tools: Tool[]
  hooks: PluginHookEntry[]
  commands: PluginCommandEntry[]
  suppressTools: string[]
  loaded: number
  scanned: number
  warnings: string[]
}

let cache: PluginToolsSnapshot | null = null
let loading: Promise<PluginToolsSnapshot> | null = null
/** 在飞暖场期间到达的最新一次暖场请求——飞行落定后补跑（覆盖式：只关心终态）。 */
let pendingWarm: { config: PluginConfig | undefined; cwd: string } | null = null

async function buildSnapshot(config: PluginConfig | undefined, cwd: string): Promise<PluginToolsSnapshot> {
  // 冲突检测基座必须是内置工具全集——不能用空表：plugin-loader 的 existingNames
  // 读的就是传入的 registry，空表下冲突永不触发，同名插件工具随后经 serve-agent
  // 的 register（Map.set）静默覆盖内置工具。TUI 侧同类回归见 main.ts:494
  // 「empty PluginRegistry let every plugin pass」；sidecar 是同一个坑的第二例。
  const basis = createDefaultToolRegistry()
  // 快照只含插件「新增」的工具：基座是内置全集，若不减掉就会把内置工具也带进
  // 快照，serve-agent 再 register 一遍等于用另一份实例覆盖调用方的定制注册
  // （如 per-session todoStore 注入）。空表时代这一点是歪打正着成立的。
  const builtinNames = new Set(basis.getAllNames())
  const result = await initializePlugins(config, basis, cwd)
  return {
    tools: basis.getAll().filter((t) => !builtinNames.has(t.definition.name)),
    hooks: result.hooks,
    commands: result.commands,
    suppressTools: result.suppressTools,
    loaded: result.loaded,
    scanned: result.scanned,
    warnings: result.warnings,
  }
}

/** 启动/失效后暖场（幂等，fire-and-forget）。完成后 pluginToolsSnapshot 非 null。 */
export function warmPluginToolsCache(config: PluginConfig | undefined, cwd: string): void {
  if (cache) return
  if (loading) {
    // 在飞：记下最新请求，飞行落定后补跑。旧实现直接 return——于是「装插件 →
    // invalidate 重建」若撞上启动暖场窗口就被整条丢弃，而飞行中的构建用的是
    // 点火那一刻的目录快照，新插件要等下一次 invalidate 才可能出现。
    pendingWarm = { config, cwd }
    return
  }
  loading = buildSnapshot(config, cwd)
  // 保持 `void` 前缀：.then 回调返回 void，若把整链赋回 loading 会把它的类型
  // 收窄成 Promise<void>，与声明的 Promise<PluginToolsSnapshot> 冲突（TS2322）。
  void loading
    .then((snap) => { cache = snap })
    .catch((err) => {
      // 插件加载失败绝不阻断会话装配——记一行原因，按无插件继续。
      console.error('[plugins] sidecar 暖场加载失败:', (err as Error)?.message ?? err)
    })
    .finally(() => {
      loading = null
      const next = pendingWarm
      pendingWarm = null
      // 排队请求来自 invalidate（安装/启停/卸载）——语义就是「必须重建」，
      // 而函数开头的 `if (cache) return` 是「已有缓存就别重复建」的幂等守卫，
      // 刚落定的首次构建会把 cache 填上、把这次补跑挡回去。先清再跑。
      if (next) {
        cache = null
        warmPluginToolsCache(next.config, next.cwd)
      }
    })
}

/** 同步快照：暖场完成 → 插件工具集；未完成/无插件目录 → null。 */
export function pluginToolsSnapshot(): PluginToolsSnapshot | null {
  return cache
}

/** 安装/启停/卸载后调用——清缓存并（给了 cwd 就）立即重建，下一个新会话拿到新集合。 */
export function invalidatePluginToolsCache(config?: PluginConfig, cwd?: string): void {
  cache = null
  if (cwd) warmPluginToolsCache(config, cwd)
}

/** 测试专用：重置全部状态（避免用例间经模块级缓存串台）。 */
export function __resetPluginToolsCacheForTests(): void {
  cache = null
  loading = null
  pendingWarm = null
}

/**
 * 合入前的二次冲突过滤——暖场基座缺口的兜底。
 *
 * 暖场期的冲突检测基座是 createDefaultToolRegistry（21 个基础工具），而 sidecar 的
 * 真实装配走 createInteractiveToolRegistry（bootstrap.ts:467）——它额外装配
 * galaxy / deliver_task / 域工具等消费端工具。那些名字不在基座里，插件取用即可
 * 绕过暖场检测，随后经 register（Map.set）静默覆盖真工具。合入点在真实注册表
 * 在手时再拦一道，覆盖基座的全部缺口。
 *
 * 策略取「逐项过滤」而非 plugin-loader 的「整插件拒绝」：快照是各插件的合并产物，
 * 不含归属信息，整批拒绝会因一个不兼容插件废掉全部；逐项过滤对安全目标（不静默
 * 覆盖）同样有效，且保住了其余插件的可用性。
 */
export function partitionPluginTools<T extends { definition: { name: string } }>(
  pluginTools: T[],
  existingNames: ReadonlySet<string>,
): { accepted: T[]; blocked: string[] } {
  const blocked: string[] = []
  const accepted = pluginTools.filter((t) => {
    if (existingNames.has(t.definition.name)) {
      blocked.push(t.definition.name)
      return false
    }
    return true
  })
  return { accepted, blocked }
}

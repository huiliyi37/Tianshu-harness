/**
 * TPI SDK 入口（随插件分发）。只在天枢宿主内可用：宿主加载插件前安装全局 SDK，
 * 宿主之外 import 本插件会直接抛错——TPI 插件不能脱离天枢运行。
 */
export function defineTianshuPlugin(spec) {
  const sdk = globalThis.__tianshuTPI
  if (!sdk) throw new Error('not running inside Tianshu: TPI plugins load only through the Tianshu host')
  return sdk.defineTianshuPlugin(spec)
}

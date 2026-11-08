/**
 * 插件数据目录（多通道共用）。
 *
 * 为什么单独成一个模块：QQ 与微信两个通道各自的 config 都要回答同一个问题
 * 「数据往哪儿放」，而 RIVET_HOME 的解析只有一份事实。抽出来既保证两通道**同源**，
 * 也避免 `weixin/config.mjs` 去 import `qq/config.mjs`（依赖方向会成为笑柄：
 * 一个通道的配置模块被别人当工具库用）。
 *
 * 约定：$RIVET_HOME/imbridge；RIVET_HOME 缺失时回退 ~/.rivet/imbridge（与旧行为一致）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export function pluginDataDir(env = process.env) {
  const home = typeof env.RIVET_HOME === 'string' ? env.RIVET_HOME.trim() : ''
  if (home) return join(home, 'imbridge')
  return join(homedir(), '.rivet', 'imbridge')
}

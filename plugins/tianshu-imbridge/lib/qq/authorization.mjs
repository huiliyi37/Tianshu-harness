/**
 * 入站授权判定（纯函数：无依赖、可单测）。
 *
 * 为什么单独成一个模块：connection.mjs 顶层 import 了官方 QQ SDK，为一个纯函数
 * 去加载整个 SDK 不划算；而授权判定是安全面上最该被测住的一环。
 *
 * 安全默认（2026-09-29 修正）：
 * - 旧行为：未配置 ownerUserOpenid 时放行一切私聊。README 写着「强烈建议配置」，
 *   代码与文档自相矛盾，而且默认的那一侧是不安全的。
 * - 新行为：未配置 = **一律拒收**。插件与天枢同进程，手里握着文件与命令工具，
 *   放行任何陌生消息等于把整台机器交出去。安全前提没满足时，宁可什么都不做。
 * - 群聊不再豁免：mentionGate 只管「有没有 @ 机器人」，管不了「谁 @」。
 *   bot 被拉进群之后，任何群成员 @ 它都能触达天枢，所以群消息同样只认 owner。
 */

/**
 * 这条入站消息是否有权触达天枢？
 * @param {{kind?: string, senderId?: string}} message 入站消息（c2c 或 group）
 * @param {string|null|undefined} ownerUserOpenid 配置里的 owner；留空即安全拒绝
 * @returns {boolean} 仅当发信人恰为 owner 时为 true
 */
export function isAuthorizedMessage(message, ownerUserOpenid) {
  const owner = typeof ownerUserOpenid === 'string' ? ownerUserOpenid.trim() : ''
  if (!owner) return false
  const sender = typeof message?.senderId === 'string' ? message.senderId.trim() : ''
  if (!sender) return false
  return sender === owner
}

/**
 * 微信通道入站授权判定（纯函数：无依赖、可单测）。
 *
 * 为什么单独成一个模块：连接层要 import 长轮询与 HTTP 逻辑，为一个纯函数去加载
 * 整条链路不划算；而授权判定是安全面上最该被测住的一环。与 QQ 侧的
 * lib/qq/authorization.mjs 逻辑同构，但**故意不复用同一份文件**：
 * 两通道的「谁算合法来客」将来可能分头演进（微信只有私聊、QQ 有群与频道），
 * 强行共用会把两边的语义绑在一起。
 *
 * 安全默认（与 QQ 侧同一取舍，且更严）：
 * - 未配置 ownerUserId = **一律拒收**。插件与天枢同进程，手里握着文件与命令工具，
 *   放行任何陌生消息等于把整台机器交出去。安全前提没满足时，宁可什么都不做。
 * - **群聊一律拒收**：iLink 官方只支持私聊。即便服务端将来推来群消息，
 *   本通道也不认（要放开必须改本文件并补用例，不许在别处打补丁）。
 */

/** 从配置对象取 owner（未配置给 null，供启动日志判断要不要打修复指引）。 */
export function resolveOwner(config) {
  const raw = config?.ownerUserId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/**
 * 这条入站消息是否有权触达天枢？
 * @param {{kind?: string, senderId?: string}} message 入站消息
 * @param {string|null|undefined} ownerUserId 配置里的 owner；留空即安全拒绝
 * @returns {boolean} 仅当发信人恰为 owner、且不是群聊时为 true
 */
export function isAuthorizedMessage(message, ownerUserId) {
  const owner = typeof ownerUserId === 'string' ? ownerUserId.trim() : ''
  if (!owner) return false
  if (message?.kind === 'group') return false
  const sender = typeof message?.senderId === 'string' ? message.senderId.trim() : ''
  if (!sender) return false
  return sender === owner
}

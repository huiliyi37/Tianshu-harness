/**
 * StructuredUIFrame — 通用帧编解码（P2-B Wave 2）
 *
 * 从 team-panel-model / council-panel-model 两套独立 encode/decode 中提取共性。
 * 帧格式：`{prefix}{JSON}` —— 单行 JSON，前缀标记帧类型。
 *
 * 设计约束：
 * - encode/decode 逐字节兼容旧实现（重构无行为变化）
 * - 白名单注册：registerFramePrefix(prefix) 让 truncateUtf16Safe 8K cap 统一判定
 * - 撕裂回退：decode 用 indexOf 定位，JSON.parse 失败返回 null（不 throw）
 */

/** 已注册的帧前缀列表——用于 truncateUtf16Safe 的 8K 升格判定。 */
const registeredPrefixes: string[] = []

/**
 * 注册一个帧前缀到 8K 升格白名单。
 * 在模块加载时调用——不需要运行时动态注册。
 */
export function registerFramePrefix(prefix: string): void {
  if (!registeredPrefixes.includes(prefix)) {
    registeredPrefixes.push(prefix)
  }
}

/**
 * 返回所有已注册的帧前缀（副本）。
 * session-manager 的 truncateUtf16Safe 用它判断是否升格到 8K。
 */
export function getRegisteredFramePrefixes(): readonly string[] {
  return registeredPrefixes
}

/**
 * 检查 uiContent 是否包含任一已注册帧前缀。
 * 兼容旧的 `includes(PREFIX_A) || includes(PREFIX_B)` 模式。
 */
export function containsRegisteredFrame(uiContent: string): boolean {
  for (const prefix of registeredPrefixes) {
    if (uiContent.includes(prefix)) return true
  }
  return false
}

/**
 * 通用帧编码：prefix + JSON.stringify(model)。
 */
export function encodeFrame<T>(model: T, prefix: string): string {
  return `${prefix}${JSON.stringify(model)}`
}

/**
 * 通用帧解码：indexOf 定位 + JSON.parse + shape 校验。
 *
 * @param value 原始字符串（可能含多帧、其他文本、撕裂尾部）
 * @param prefix 帧前缀（如 'rivet:team-panel:v1:'）
 * @param validate shape 校验回调——返回 true 表示结构合法
 * @returns 解码后的模型，或 null（未找到/解析失败/校验失败）
 */
export function decodeFrame<T>(
  value: string,
  prefix: string,
  validate: (parsed: unknown) => parsed is T,
): T | null {
  const at = value.indexOf(prefix)
  if (at === -1) return null
  try {
    const parsed = JSON.parse(value.slice(at + prefix.length))
    if (validate(parsed)) return parsed
    return null
  } catch {
    return null
  }
}

/**
 * 通用帧解码（多帧回退版）：lastIndexOf 逐帧尝试，找到第一个合法帧。
 * 用于帧可能被覆盖的场景（council-panel 在一个 buffer 中可能有多帧）。
 *
 * @param value 原始字符串
 * @param prefix 帧前缀
 * @param validate shape 校验回调
 * @returns 解码后的模型，或 null
 */
export function decodeFrameLastWins<T>(
  value: string,
  prefix: string,
  validate: (parsed: unknown) => parsed is T,
): T | null {
  let at = value.lastIndexOf(prefix)
  while (at !== -1) {
    const start = at + prefix.length
    const nl = value.indexOf('\n', start)
    const body = nl === -1 ? value.slice(start) : value.slice(start, nl)
    try {
      const parsed = JSON.parse(body)
      if (validate(parsed)) return parsed
    } catch {
      // 撕裂帧 —— 回退到更早出现
    }
    // at===0 时 lastIndexOf(prefix, -1) 会把负 position 当 0 重新命中同一帧 → 死循环
    at = at > 0 ? value.lastIndexOf(prefix, at - 1) : -1
  }
  return null
}

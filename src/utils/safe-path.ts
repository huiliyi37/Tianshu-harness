/**
 * 不可信输入的落盘/落终端前处理工具。
 *
 * 终端转义剥离用于「会进入终端渲染的持久化文本」（会话标题等）：OSC 52 可
 * 覆写系统剪贴板、CSI 可清屏/踢出 alt-screen；标题经 /sessions 列表、
 * Chronicle、退出摘要三条路径反复回放，必须在落盘前剥净。用户消息主链无需
 * 此函数（addUserMessage 已过 sanitizeForJsonTransport）——它守的是 HTTP
 * body 直达 record 字段、不经消息链的旁路。
 */
// eslint-disable-next-line no-control-regex
const ANSI_SEQ_RE = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g

export function stripTerminalEscapes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(ANSI_SEQ_RE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
}

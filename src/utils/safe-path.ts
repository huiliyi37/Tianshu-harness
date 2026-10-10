/**
 * 不可信输入的落盘/落终端前处理工具。
 *
 * 终端转义剥离用于「会进入终端渲染的持久化文本」（会话标题等）：OSC 52 可
 * 覆写系统剪贴板、CSI 可清屏/踢出 alt-screen；标题经 /sessions 列表、
 * Chronicle、退出摘要三条路径反复回放，必须在落盘前剥净。用户消息主链无需
 * 此函数（addUserMessage 已过 sanitizeForJsonTransport）——它守的是 HTTP
 * body 直达 record 字段、不经消息链的旁路。
 *
 * 单段文件名守卫用于「路由参数/外部输入拼进文件路径前」（收编 PR #180 /
 * issue #178）：段匹配发生在 decodeURIComponent 之前，`%2e%2e%2f` 还原成
 * `../` 后会直进 join——skill 名 / plans slug / workerId / checkpoint
 * groupId 四处同病，消费侧（readFile/rmSync/writeFileSync）语义各异，
 * 守卫必须在 join 之前挡下。
 */
// eslint-disable-next-line no-control-regex
const ANSI_SEQ_RE = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g

export function stripTerminalEscapes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(ANSI_SEQ_RE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
}

/**
 * 语义与 scratch-cleanup 的 isSafeScratchName 同族（单段、非隐藏、非穿越），
 * 另加长度上限；允许 Unicode 与非尾随点号（既有技能名/计划 slug 的向后兼容面），
 * 拒绝分隔符、控制字符、Windows 非法字符 `<>:"|?*`（冒号即 NTFS ADS 暗道，
 * 跨平台统一收紧）、尾随点/空格（Windows 落盘自动剥离，同名校验会失效）、
 * 前导点与任何 `..` 序列。
 */
const MAX_NAME_LENGTH = 200

// eslint-disable-next-line no-control-regex
const FORBIDDEN_FILE_NAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/

export function isSafeFileName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return false
  if (FORBIDDEN_FILE_NAME_CHARS.test(name)) return false
  if (name.startsWith('.')) return false
  if (name.includes('..')) return false
  if (/[. ]$/u.test(name)) return false
  // Windows 保留设备名（收编 PR #396）：CON.txt 等形态在 Win32 打开设备而非建
  // 文件，同名写入无声挂起或"成功"却无落盘——与 orderFileKey 拦冒号（ADS）同族。
  if (isWindowsDeviceName(name)) return false
  return true
}

/**
 * 跨平台取路径 basename：先归一化分隔符再切尾段。
 * 取代裸 `split('/').pop()`——后者在 Windows 反斜杠路径上返回**整条路径**
 * （展示类文案/摘要会显示全路径而非文件名；同族缺陷见 evidence.ts 归一化
 * 修复的批次说明）。
 */
export function basenamePortable(p: string): string {
  const normalized = p.replaceAll('\\', '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

function isWindowsDeviceName(name: string): boolean {
  const dot = name.indexOf('.')
  const stem = (dot < 0 ? name : name.slice(0, dot)).replace(/[. ]+$/u, '')
  return WINDOWS_DEVICE_NAME.test(stem)
}

/** 按 UTF-8 字节数截断（不劈开多字节字符）。 */
function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0
  let prefix = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return prefix
}

/**
 * 压缩包附件的事件/UI 展示名清洗（dsh fileLeafName 同款五条）：剥两种路径
 * 分隔符取叶名、去控制字符、Windows 非法字符 `<>:"|?*` 置 `_`、设备名
 * （con/prn/nul/aux/com1-9/lpt1-9）加下划线前缀、UTF-8 感知截 255 字节。
 * 仅用于展示——落盘名恒为 docId，天然免疫路径注入。
 */
export function sanitizeArchiveDisplayName(value: string): string {
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  let clean = leaf
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (isWindowsDeviceName(clean)) clean = `_${clean}`
  clean = utf8Prefix(clean, 255).replace(/[. ]+$/u, '')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}

/**
 * orderId → 文件系统安全键：拼进文件名前的唯一映射（写/读/列三处共用）。
 *
 * orderId 的稳定形状含冒号（batch:0 / team:T1），而 Windows 文件名禁用冒号
 * ——裸拼名会落成 NTFS 备用数据流（ADS）：同路径写/读都"成功"，但 readdir
 * 只见宿主文件（`batch`），归档列表/清理对整族文件永远不可见（worker 结果
 * 归档在 Windows 上列不出的根因）。encodeURIComponent 单射编码（`:`→`%3A`；
 * `*` 在 Windows 亦非法故显式编码），各平台产出一致文件名；不含特殊字符的
 * orderId（wo_* 等）映射恒等，零行为差异。
 */
export function orderFileKey(orderId: string): string {
  return encodeURIComponent(orderId).replace(/\*/g, '%2A')
}

/**
 * OutputGuard — TUI 存活期拦截 `process.stderr.write`，把游离文本导入 commit 通道。
 *
 * 动机：LiveEngine 的 cursor-resident 协议假设独占 live region 的所有行。任何
 * 绕过渲染管线直写 TTY 的文本（LSP/typecheck 一次性告警、eperm-filter 的
 * unhandled rejection、第三方库 console.error）都会接在 live region 末行后
 * 硬折行，使行数追踪失同步 → cursorUp 回顶不足 → 旧帧残留叠屏。
 * CPR 自愈（live-engine.ts）负责检出外部进程写入；本 guard 从源头消除自家写入。
 *
 * 行为：
 * - 按行缓冲，完整行 sanitize（剥 ANSI/控制字符）后经 onText 回调交给调用方
 *   （通常 commitAbove 上屏为静态行），不再直写终端。
 * - dispose 恢复原始 write；缓冲区残尾此时原样补写回真实 stderr（TUI 已退场，
 *   直写不再破坏布局）。
 * - console.error / console.warn 走 util.format → stderr.write，天然被覆盖。
 *   不拦截 process.stdout.write——LiveEngine/CommitEngine 拥有 stdout。
 */

export interface OutputGuard {
  dispose(): void
}

/** 单行文本上限：超长诊断截断，避免一条日志吃掉整个 scrollback。 */
const MAX_LINE_CHARS = 300

/** 行缓冲上限：无换行流（进度条式 \r 刷写、失控循环打印）不该无界堆积——保尾截头。 */
const MAX_BUFFER_CHARS = 64 * 1024

/** 剥 CSI/OSC 序列与控制字符（保留可打印文本与空格）。 */
function sanitizeLine(line: string): string {
  const noAnsi = line
    // OSC (Operating System Command)：ESC ] ... BEL 或 ESC \
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // CSI：ESC [ 参数 中间字节 最终字节
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    // 其他 ESC 开头双字符序列
    .replace(/\x1B[@-Z\\-_]/g, '')
  // 剥除区间含 \x0D（裸 CR 会把终端光标拉回列 0，让同行后续文本覆盖 ⚠ 前缀
  // ——CRLF 尾部的 CR 此前靠 trim 兜住，行中 CR 一直放行）；\x09/\x0A 保留。
  // eslint-disable-next-line no-control-regex
  const noCtrl = noAnsi.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
  return noCtrl.trim().slice(0, MAX_LINE_CHARS)
}

let activeGuard: OutputGuard | null = null

/**
 * 安装 guard（幂等：重复安装返回既有实例）。onText 接收 sanitize 后的单行文本。
 */
export function installOutputGuard(onText: (text: string) => void): OutputGuard {
  if (activeGuard) return activeGuard

  const stderr = process.stderr
  const original = stderr.write.bind(stderr) as typeof stderr.write
  let buf = ''
  let disposed = false
  let inCallback = false

  const emitLines = (): void => {
    let idx = buf.indexOf('\n')
    while (idx !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      const clean = sanitizeLine(line)
      if (clean && !inCallback) {
        inCallback = true
        try { onText(clean) } catch { /* onText 故障不反噬 stderr 语义 */ }
        inCallback = false
      }
      idx = buf.indexOf('\n')
    }
  }

  const wrapped = function (
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    if (disposed) {
      return (original as (...args: unknown[]) => boolean)(chunk, encodingOrCb, cb)
    }
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    buf += text
    // 无换行流的上界：截头保尾（丢最旧的部分行，不丢内存）。
    if (buf.length > MAX_BUFFER_CHARS) buf = buf.slice(buf.length - MAX_BUFFER_CHARS)
    // 回调（onText → commitStatic）执行期间再入的写入只入队不派发：外层
    // emitLines 的 while 每轮重扫 buf，回调返回后会续走这些行。此前这里无脑
    // 嵌套派发，再入行被 inCallback 守卫静默整行丢弃——恰恰在打告警的时刻
    // 丢诊断日志。
    if (!inCallback) emitLines()
    const realCb = typeof encodingOrCb === 'function' ? encodingOrCb : cb
    if (typeof realCb === 'function') realCb()
    return true
  }

  ;(stderr as { write: typeof stderr.write }).write = wrapped as typeof stderr.write

  const guard: OutputGuard = {
    dispose(): void {
      if (disposed) return
      disposed = true
      ;(stderr as { write: typeof stderr.write }).write = original
      const tail = sanitizeLine(buf)
      buf = ''
      if (tail) original(`${tail}\n`)
      if (activeGuard === guard) activeGuard = null
    },
  }
  activeGuard = guard
  return guard
}

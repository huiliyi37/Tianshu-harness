/**
 * 「首次使用某命令」的记忆（命令提示去重用）。
 *
 * 与 session-map 同款：惰性读盘、按路径缓存、每次写入尽力落盘、失败静默。
 * 存的是 { "<命令名>": <首次时间戳> }；时间戳只为将来能清理旧记录，判定逻辑用不到。
 * file 为空时退化为**进程内**记忆（测试与降级用）：不写盘，重启即忘。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const caches = new Map()

function cacheFor(file) {
  if (!caches.has(file)) {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      parsed = null
    }
    caches.set(file, parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
  }
  return caches.get(file)
}

/**
 * 造一个「已教过的命令」句柄。
 * @param {string|null} file 落盘路径；空则纯内存
 */
export function makeCommandHints(file) {
  if (!file) {
    const seen = new Map()
    return {
      has: (name) => seen.has(name),
      mark: (name) => { seen.set(name, Date.now()) },
      reset: () => seen.clear(),
      size: () => seen.size,
    }
  }
  const persist = () => {
    try {
      writeFileSync(file, JSON.stringify(cacheFor(file), null, 2))
    } catch { /* 尽力而为 */ }
  }
  return {
    has: (name) => Boolean(cacheFor(file)[name]),
    mark: (name) => {
      cacheFor(file)[name] = Date.now()
      persist()
    },
    reset: () => {
      const c = cacheFor(file)
      for (const k of Object.keys(c)) delete c[k]
      persist()
    },
    size: () => Object.keys(cacheFor(file)).length,
  }
}

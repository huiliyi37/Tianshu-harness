/**
 * 会话绑定表的持久化（QQ 对话线 → 天枢 serve 会话 id）。
 *
 * 从 index.js 提出来，为的是让「落盘且重启后仍生效」这条验收标准可以被真正验证 ——
 * 藏在插件入口里的实现没法在测试里诚实复现。
 *
 * 行为与原先一致：首次访问时惰性读盘；读不动或内容不是普通对象就退回空表
 * （JSON.parse 对 "null"/"[]"/"123" 都不抛错，但只有普通对象才配当映射表）；
 * 每次写入后尽力落盘，失败静默。
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** 按文件路径缓存（原实现是全局单例缓存，多文件会串；这里按路径分开）。 */
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

/** 造一个绑定表句柄。file 为空时退化为纯内存（测试与降级用）。 */
export function makeSessionMap(file) {
  const persist = () => {
    if (!file) return
    try {
      writeFileSync(file, JSON.stringify(cacheFor(file), null, 2))
    } catch { /* 尽力而为 */ }
  }
  return {
    get: (key) => (file ? cacheFor(file)[key] ?? null : null),
    set: (key, value) => {
      if (!file) return
      cacheFor(file)[key] = value
      persist()
    },
    del: (key) => {
      if (!file) return
      delete cacheFor(file)[key]
      persist()
    },
    size: () => (file ? Object.keys(cacheFor(file)).length : 0),
  }
}

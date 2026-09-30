/**
 * 工具运行时消息中文化守卫 — 中文化第二波（消息面）防回潮。
 *
 * 递归扫描 src/tools 全树源文件里 `content:` 赋值的单行字符串/模板
 * 字面量（即 ToolResult.content 的模型-facing 消息），非豁免文件的消息
 * 必须含 CJK。已翻译文件从 PENDING_MESSAGE_LOCALE 移除后，本守卫防止
 * 后续改动把英文消息塞回去。
 *
 * 口径：
 * - 只扫单行闭合的字面量（多行模板/变量拼接放行——启发式扫描，
 *   宁可漏报不可误报）。
 * - 剥掉 `${...}` 插值后剩余文本 < 8 字符的碎片放行。
 * - 结构 key-value（`Path:`/`Exists:` 等 key 保留英文）按整条消息含
 *   CJK 判定——说明性部分翻了即过。
 * - 豁免清单随中文化波次推进缩小，最终应清空（同 description-locale）。
 *
 * ⚠️ 中文化一个文件前必读（第二波解耦纪律）：
 * 1. 若该文件的错误消息会被 failure-classifier 的英文正则命中
 *    （timeout / not found / assertion …），必须先给对应 ToolResult 打
 *    errorKind 结构字段再翻文案，否则错误分类静默失灵。
 * 2. 若消息被其他模块 includes/regex 匹配（如 search-pod-hook 匹配
 *    grep/glob 空结果），先提取共享 sentinel 常量，两边同源。
 * 3. 外部工具输出（tsc/git/测试 runner 的原始 stdout）是证据，不翻译。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 尚未消息中文化的工具文件（相对 src/tools 的路径）——翻一个删一个。
 *  初始快照：2026-07-23 第二波起点，49 个文件。
 *  2026-07-25 收缩：中文化第二波大规模落地，46 个文件翻完移出清单。 */
const PENDING_MESSAGE_LOCALE: ReadonlySet<string> = new Set([
  'attack-case.ts',
  'browser-debug/tool.ts',
  'plan-task.ts',
])

const CJK_RE = /[一-鿿]/

interface MessageHit {
  file: string
  line: number
  text: string
}

/** 提取单行闭合的 content: 字面量。多行模板不匹配（启发式，允许漏报）。 */
const CONTENT_LITERAL_RE = /content:\s*(['"`])((?:\\.|(?!\1).)*?)\1/g

async function scanMessages(dir: string, root = dir, hits: MessageHit[] = []): Promise<MessageHit[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') await scanMessages(join(dir, entry.name), root, hits)
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    const path = join(dir, entry.name)
    const src = await readFile(path, 'utf8')
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      CONTENT_LITERAL_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = CONTENT_LITERAL_RE.exec(lines[i]!)) !== null) {
        const raw = m[2]!
        const prose = raw.replace(/\$\{[^}]*\}/g, '')
        if (prose.length < 8) continue
        // 归一 POSIX：清单（PENDING_MESSAGE_LOCALE）与报告都以正斜杠书写；
        // Windows 上 relative() 产反斜杠会让豁免查询与陈旧检测双双静默失配。
        hits.push({ file: relative(root, path).replaceAll('\\', '/'), line: i + 1, text: raw })
      }
    }
  }
  return hits
}

describe('工具运行时消息中文化守卫', () => {
  it('非豁免文件的 content 消息必须含 CJK', async () => {
    const hits = await scanMessages(TOOLS_DIR)
    const violations = hits
      .filter(h => !PENDING_MESSAGE_LOCALE.has(h.file))
      .filter(h => !CJK_RE.test(h.text))
      .map(h => `${h.file}:${h.line} "${h.text.slice(0, 60)}"`)
    assert.deepEqual(violations, [], `英文消息残留（先读本文件头部纪律再翻译）：\n${violations.join('\n')}`)
  })

  it('豁免清单无陈旧条目（文件已无英文消息则应移除）', async () => {
    const hits = await scanMessages(TOOLS_DIR)
    const englishByFile = new Set(hits.filter(h => !CJK_RE.test(h.text)).map(h => h.file))
    const stale = [...PENDING_MESSAGE_LOCALE].filter(f => !englishByFile.has(f))
    assert.deepEqual(stale, [], `豁免清单陈旧条目（已翻完，请移除）：\n${stale.join('\n')}`)
  })

  it('覆盖面自检：扫描到的消息 ≥ 30（防提取正则静默失效）', async () => {
    const hits = await scanMessages(TOOLS_DIR)
    assert.ok(hits.length >= 30, `只提取到 ${hits.length} 条消息，扫描逻辑可能失效`)
  })
})

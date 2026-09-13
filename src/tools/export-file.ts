import { mkdir, stat, copyFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'path'
import type { Tool } from './types.js'
import { expandHome } from '../platform.js'
import { detectSensitiveFile } from './sensitive-file-detector.js'

const MAX_EXPORT_BYTES = 50 * 1024 * 1024 // 50MB — explicit external export safety ceiling

export interface ExportFileInput {
  destination_path?: string
  content?: string
  source_path?: string
  encoding?: 'text' | 'base64'
}

function getDestinationPath(input: Record<string, unknown>): string | null {
  const raw = input.destination_path
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  return resolve(expandHome(raw.trim()))
}

function getSourcePath(input: Record<string, unknown>): string | null {
  const raw = input.source_path
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  return resolve(expandHome(raw.trim()))
}

export async function exportFile(input: ExportFileInput): Promise<{ path: string; bytes: number; mode: 'content' | 'copy' }> {
  const destinationPath = getDestinationPath(input as Record<string, unknown>)
  if (!destinationPath) throw new Error('destination_path 为必填项')

  const hasContent = typeof input.content === 'string'
  const hasSource = typeof input.source_path === 'string' && input.source_path.trim().length > 0
  if (hasContent === hasSource) throw new Error('必须且只能提供 content 或 source_path 之一')

  await mkdir(dirname(destinationPath), { recursive: true })

  if (hasContent) {
    const encoding = input.encoding ?? 'text'
    if (encoding !== 'text' && encoding !== 'base64') throw new Error('encoding 必须为 text 或 base64')
    const buffer = encoding === 'base64'
      ? Buffer.from(input.content!, 'base64')
      : Buffer.from(input.content!, 'utf-8')
    if (buffer.length > MAX_EXPORT_BYTES) {
      throw new Error(`导出过大（${(buffer.length / (1024 * 1024)).toFixed(1)}MB）；上限为 50MB`)
    }
    await writeFile(destinationPath, buffer)
    return { path: destinationPath, bytes: buffer.length, mode: 'content' }
  }

  const sourcePath = getSourcePath(input as Record<string, unknown>)
  if (!sourcePath) throw new Error('source_path 为必填项')
  // 敏感文件硬门（issue #135）：source_path 曾是唯一不经敏感检测的读路径，
  // 可把 ~/.ssh/id_rsa、.env、凭证文件直接复制出项目。copy 之前先跑同一门禁。
  const sensitiveSource = detectSensitiveFile(sourcePath)
  if (sensitiveSource.sensitive) {
    throw new Error(`拒绝导出敏感文件（${sensitiveSource.patternName}）：${sourcePath}。敏感文件不允许复制到项目之外。`)
  }
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile()) throw new Error('source_path 必须是文件')
  if (sourceStat.size > MAX_EXPORT_BYTES) {
    throw new Error(`导出过大（${(sourceStat.size / (1024 * 1024)).toFixed(1)}MB）；上限为 50MB`)
  }
  await copyFile(sourcePath, destinationPath)
  const destinationStat = await stat(destinationPath)
  return { path: destinationPath, bytes: destinationStat.size, mode: 'copy' }
}

export const EXPORT_FILE_TOOL: Tool = {
  definition: {
    name: 'export_file',
    description: `将文件创建或复制到外部路径，如桌面、下载、挂载盘或 Windows 路径。

当用户明确要求将生成的资产放到项目工作区之外时使用。与 write_file 不同，此工具面向用户可见的外部输出，且始终需要审批。

支持：
- 写文本内容：destination_path + content
- 写二进制内容：destination_path + content + encoding="base64"
- 复制已有文件：destination_path + source_path

示例：
Good: export_file(destination_path="~/Desktop/tianshu-logo.svg", content="<svg>...</svg>")
Good: export_file(destination_path="H:\\zhuomian\\白嫖gpt\\logo.png", source_path="/tmp/generated.png")
Bad: 用 bash 重定向或 echo 往外部路径写文件`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: '绝对路径或 ~ 相对路径。可在项目之外。' },
        content: { type: 'string', description: '要写入的文件内容。二进制文件用 encoding="base64"。' },
        source_path: { type: 'string', description: '要复制到 destination_path 的已有文件。' },
        encoding: { type: 'string', enum: ['text', 'base64'], description: 'content 的解码方式。默认 text。' },
      },
      required: ['destination_path'],
    },
  },

  async execute(params) {
    try {
      const result = await exportFile(params.input as ExportFileInput)
      return {
        content: `已导出 ${result.bytes} 字节到 ${result.path}${result.mode === 'copy' ? '（已复制）' : ''}`,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `错误：${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

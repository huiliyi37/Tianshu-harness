import { readFileSync, realpathSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { rivetHome, userConfigPath } from './paths.js'
import { FROZEN_BLOCK_CAPS } from '../prompt/block-policy.js'

const noticed = new Set<string>()

/** 两端都要归一化：被指名文件走 realpathSync，`rivetHome()` 也必须解析——
 *  否则 RIVET_HOME 是符号链接 / junction 时，合法文件会被误拒（fail-closed，
 *  但功能不可用）。解析失败时回落为 resolve(p)。 */
function canonicalize(p: string): string {
  try { return realpathSync(p) } catch {
    return resolve(p)
  }
}

function notice(key: string, message: string): void {
  if (noticed.has(key)) return
  noticed.add(key)
  console.error(`[rivet] ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function loadUserInstructionsBlock(): string | undefined {
  let config: unknown
  try {
    config = JSON.parse(readFileSync(userConfigPath(), 'utf8'))
  } catch {
    return undefined
  }

  if (!isRecord(config)) return undefined
  const agent = config.agent
  if (!isRecord(agent)) return undefined
  const userInstructions = agent.userInstructions
  if (!isRecord(userInstructions) || userInstructions.enabled !== true) return undefined

  const configuredPath = userInstructions.path
  if (typeof configuredPath !== 'string' || configuredPath.trim().length === 0) {
    notice('missing-path', 'agent.userInstructions is enabled but path is missing')
    return undefined
  }

  if (!isAbsolute(configuredPath)) {
    notice('relative-path', 'agent.userInstructions path must be absolute')
    return undefined
  }

  let realPath: string
  try {
    realPath = realpathSync(configuredPath)
  } catch {
    notice('unresolvable-path', 'agent.userInstructions path could not be resolved')
    return undefined
  }

  const insideHome = relative(canonicalize(rivetHome()), realPath)
  if (insideHome.startsWith('..') || isAbsolute(insideHome)) {
    notice('outside-home', 'agent.userInstructions path must be inside rivetHome()')
    return undefined
  }

  try {
    if (!statSync(realPath).isFile()) {
      notice('not-file', 'agent.userInstructions path must name a regular file')
      return undefined
    }
  } catch {
    notice('stat-failed', 'agent.userInstructions file could not be inspected')
    return undefined
  }

  let bytes: Buffer
  try {
    bytes = readFileSync(realPath)
  } catch {
    notice('read-failed', 'agent.userInstructions file could not be read')
    return undefined
  }

  const start = bytes.length >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
    ? 3
    : 0

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start))
  } catch {
    notice('invalid-utf8', 'agent.userInstructions file is not valid UTF-8')
    return undefined
  }

  text = text.replace(/\r\n/g, '\n').trim()
  if (text.length === 0) return undefined

  if (text.length > FROZEN_BLOCK_CAPS.projectInstructions) {
    notice('over-cap', 'agent.userInstructions file exceeds the frozen instruction limit')
    return undefined
  }

  return text
}

export function notifyUserInstructionsDropped(): void {
  notice(
    'dropped',
    'global user instructions were truncated or consumed the frozen project-instructions budget',
  )
}

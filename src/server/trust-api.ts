/**
 * /project/trust — 桌面端的项目授信入口。
 *
 * 信任门（config/project-trust.ts）对未授信项目剥离安全敏感键
 * （mcp.servers / agent.approval / agent.permissions / plugins / mirrors …），
 * 项目级 hooks 也不执行。但此前只有 CLI 能授信——`--trust` / `/trust` /
 * RIVET_TRUST_PROJECT；桌面端侧只有一句注释「桌面端项目信任 UI 落地前的
 * fail-closed」（serve-agent.ts），于是终端用户在桌面端配了项目级 MCP，
 * 看到的是「服务器全没了」且无处恢复。
 *
 * 本路由补齐这一环：
 *   GET  /project/trust?cwd=<dir>  → 授信状态 + 会被剥离的敏感键 + hooks 赌注
 *   POST /project/trust            → { cwd, trusted } 授信 / 撤销（幂等）
 *
 * cwd 必须由调用方给出：桌面端的「项目」是会话工作区，而 sidecar 进程的 cwd
 * 未必是它（安装目录 / 启动目录）。缺省才回落到 process.cwd()。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { findProjectConfig } from '../config/manager.js'
import {
  isProjectTrusted,
  isTrustPromptDismissed,
  trustProject,
  untrustProject,
  findSensitiveProjectKeys,
} from '../config/project-trust.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

/** 未授信时会被剥离（配置键）或禁用（hooks）的东西——UI 据此说明「授信能得到什么」。 */
function collectStakes(projectDir: string): { sensitiveKeys: string[]; hasHooks: boolean } {
  let sensitiveKeys: string[] = []
  const projectPath = join(projectDir, '.rivet-config.json')
  if (existsSync(projectPath)) {
    try {
      const raw = JSON.parse(readFileSync(projectPath, 'utf-8')) as Record<string, unknown>
      sensitiveKeys = findSensitiveProjectKeys(raw)
    } catch {
      /* 坏 JSON 由 loadConfig 抛 ConfigLoadError 负责报错，这里不重复 */
    }
  }
  return { sensitiveKeys, hasHooks: existsSync(join(projectDir, '.rivet', 'hooks.json')) }
}

function resolveDir(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/** 项目目录由配置所在目录决定；没有项目配置时退化为传入的 cwd。 */
function projectDirFor(cwd: string): { projectDir: string; projectPath: string | undefined } {
  const projectPath = findProjectConfig(cwd)
  return { projectDir: projectPath ? dirname(projectPath) : cwd, projectPath }
}

export function buildTrustRoutes(apiToken?: string): Record<string, RouteHandler> {
  return {
    // GET /project/trust — 当前项目的授信状态与赌注。
    'GET /project/trust': withAuth((_body, params) => {
      const cwd = resolveDir(params?.cwd) ?? process.cwd()
      const { projectDir, projectPath } = projectDirFor(cwd)
      return {
        status: 200,
        body: {
          cwd,
          projectPath,
          trusted: isProjectTrusted(projectDir),
          /** 用户曾选「不再提示」——桌面端别再弹引导。 */
          dismissed: isTrustPromptDismissed(projectDir),
          stakes: collectStakes(projectDir),
        },
      }
    }, apiToken),

    // POST /project/trust — 授信 / 撤销（幂等，与 CLI 的 --trust / /trust 同一存储）。
    'POST /project/trust': withAuth((body) => {
      const data = (body ?? {}) as { cwd?: unknown; trusted?: unknown }
      const cwd = resolveDir(data.cwd)
      if (!cwd) return { status: 400, body: { error: 'cwd is required' } }
      if (typeof data.trusted !== 'boolean') {
        return { status: 400, body: { error: 'trusted must be a boolean' } }
      }
      const { projectDir } = projectDirFor(cwd)
      if (data.trusted) trustProject(projectDir)
      else untrustProject(projectDir)
      return { status: 200, body: { cwd, projectDir, trusted: isProjectTrusted(projectDir) } }
    }, apiToken),
  }
}

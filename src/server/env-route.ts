/**
 * GET /environment — host toolchain availability for the desktop setup UI.
 * Reports whether python, uv, git, node, java, maven, gradle are installed,
 * plus platform, shell info, and PATH-recovery diff.
 *
 * Probes under the RESOLVED env (getResolvedEnv), not the raw process env —
 * the GUI launch path on macOS/Windows often lacks /opt/homebrew/bin,
 * %PROGRAMFILES%, etc., so raw-env probes would falsely report tools missing.
 * This mirrors the CLI `/doctor` behavior (slash-commands.ts:950).
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { detectEnv, type PythonEnvInfo } from '../tools/env-check.js'
import { getResolvedEnv, getResolvedPathDiff } from '../tools/resolved-env.js'
import { getShellDiagnostics } from '../platform.js'
import { execSync } from 'node:child_process'

export function buildEnvRoute(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /environment': async (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const resolved = getResolvedEnv()
      const env = await detectEnv(undefined, resolved)
      const diag = getShellDiagnostics()
      env.shell = {
        kind: diag.kind,
        gitBashAvailable: diag.gitBashPath !== null,
        ...(diag.fallbackReason ? { fallbackReason: diag.fallbackReason } : {}),
      }
      // PATH-recovery diff: dirs the resolver added beyond the raw process PATH.
      // Helps users understand why a tool is/isn't found under GUI launch.
      const added = getResolvedPathDiff().added
      return {
        status: 200,
        body: {
          ...env,
          ...(added.length > 0 ? { pathDiff: added } : {}),
        } as PythonEnvInfo & { pathDiff?: string[] },
      }
    },

    'POST /config/fix-autocrlf': withAuthPost((_body, _params, _headers) => {
      // One-click fix: git config --global core.autocrlf input
      // Prevents CRLF noise in diffs when the agent writes LF.
      try {
        execSync('git config --global core.autocrlf input', { timeout: 5000, windowsHide: true })
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }, apiToken),
  }
}

function withAuthPost(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

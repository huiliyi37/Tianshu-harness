/**
 * 天枢 headless 调用封装。
 *
 * 设计约束：
 * - 不硬编码个人路径：运行时目录从当前进程 argv 推导（插件就运行在天枢进程内），
 *   node 用 process.execPath（即天枢自带的 node-runtime），数据 home 用 RIVET_HOME。
 * - 会话续接：每个 QQ 会话分配独立 cwd；会话 id 由 session-discovery 从
 *   sessions 目录确定性发现（headless 不更新 last-session 指针，`-c` 不可用），
 *   以 `-r <sessionId>` 显式续接。无 id 时为全新会话。
 * - 输出解析：headless --json 输出单行 JSON；容错地从 stdout/stderr 尾部逆序找结果行。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * 从 argv[1] 推导天枢运行时目录。
 * - serve 入口：<runtime>/cli/entry.js → <runtime>
 * - TUI/headless 入口：<runtime>/main.js → <runtime>
 */
export function resolveRuntimeDir({ argv1 = process.argv[1] } = {}) {
  const raw = typeof argv1 === 'string' ? argv1 : ''
  const normalized = raw.replace(/\\/g, '/')
  if (/\/cli\/entry\.js$/.test(normalized)) {
    return normalized.replace(/\/cli\/entry\.js$/, '')
  }
  const slash = normalized.lastIndexOf('/')
  if (slash >= 0) return normalized.slice(0, slash)
  return '.'
}

/** 组装一次 headless 调用的命令 / 参数 / 选项（纯函数，便于测试）。 */
export function buildInvocation({
  runtimeDir,
  nodePath,
  homeDir,
  cwd,
  prompt,
  baseEnv = process.env,
}) {
  const mainJs = join(runtimeDir, 'main.js')
  const args = [mainJs, '-p', prompt, '--json']
  return {
    command: nodePath,
    args,
    options: {
      cwd,
      env: { ...baseEnv, RIVET_HOME: homeDir },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  }
}

/** 逆序扫描各行，取最后一条带 success 字段的 JSON 结果行。 */
export function parseOutput(raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || !('success' in parsed)) continue
    if (parsed.success === true) {
      return {
        ok: true,
        text: typeof parsed.text === 'string' ? parsed.text : '',
        error: null,
        usage: parsed.usage ?? null,
      }
    }
    return {
      ok: false,
      text: typeof parsed.text === 'string' ? parsed.text : '',
      error: parsed.error ?? parsed.message ?? '天枢报告失败',
      usage: parsed.usage ?? null,
    }
  }
  return {
    ok: false,
    text: '',
    error: '无法解析天枢输出（未见 JSON 结果行）',
    raw: text.slice(-400),
  }
}

/**
 * 实际发起 headless 调用（进程交互；单元测试覆盖纯函数部分，此函数由真机验证）。
 * @returns {Promise<{ok:boolean,text:string,error:string|null,elapsedMs:number,exitCode?:number|null}>}
 */
export async function callTianshu(invocation, { timeoutMs = 180_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // settle 之后不再需要子进程输出：解绑，免得一个杀不死的子进程把缓冲一直堆下去
      child?.stdout?.removeAllListeners?.()
      child?.stderr?.removeAllListeners?.()
      resolve({ ...result, elapsedMs: Date.now() - startedAt })
    }

    let child
    try {
      child = spawnImpl(invocation.command, invocation.args, invocation.options)
    } catch (error) {
      resolve({
        ok: false,
        text: '',
        error: `无法启动天枢进程: ${error?.message ?? error}`,
        elapsedMs: Date.now() - startedAt,
      })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch { /* ignore */ }
      finish({ ok: false, text: '', error: `天枢调用超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on?.('data', (chunk) => {
      stderr += chunk
    })
    child.on?.('error', (error) => {
      finish({ ok: false, text: '', error: `无法启动天枢进程: ${error?.message ?? error}` })
    })
    child.on?.('close', (code) => {
      let parsed = parseOutput(stdout)
      if (!parsed.ok && parsed.error === '无法解析天枢输出（未见 JSON 结果行）') {
        parsed = parseOutput(stderr) // 容错：结果行偶发落在 stderr
      }
      finish({
        ok: parsed.ok === true,
        text: parsed.text ?? '',
        error: parsed.error ?? null,
        exitCode: code,
        diagnostics: parsed.ok ? null : (parsed.raw ?? stderr.slice(-400) ?? null),
      })
    })
  })
}

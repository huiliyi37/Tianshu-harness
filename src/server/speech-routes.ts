/**
 * POST /speech/transcribe — 语音转写（whisper.cpp 本地引擎）。
 * body: { audio: base64(wav 16k mono PCM16), lang?: string }
 * 返回: 200 { text } / 400 { error: 'invalid-audio'|'invalid-wav' }
 *       / 503 { error: 'whisper-unavailable' } / 500 { error: 'transcribe-failed' }
 * engine 为 null 时（whisper 运行时未打包/未就绪）返回 503，前端据此降级。
 *
 * GET /speech/model/status — 引擎就绪状态（设置页展示）。
 *   当前模型 = models/.active（下载即切换的持久化选择）优先，回退
 *   RIVET_WHISPER_MODEL；按文件存在性探测。
 *   返回 200 { binReady, modelReady, model, installing }。
 *
 * POST /speech/model/install — 下载 whisper 模型（设置页 tiny/base/small/turbo 切换）。
 * body: { model: 'tiny'|'base'|'small'|'turbo' }；spawn 系统 node 执行
 *   desktop/scripts/fetch-whisper-runtime.js（--model <key>）。
 *   安装状态存模块级变量防并发；完成后写 models/.active（内容 = 模型文件名，
 *   下载即切换的持久化锚点）并调 onModelInstalled（serve.ts 重建引擎，当前进程
 *   即刻生效）；失败 500 { error: 'model-install-failed' }，进行中 409。
 *   脚本路径可用 RIVET_WHISPER_FETCH_SCRIPT 覆盖（测试注入 fake 脚本）。
 *   下载走 curl，需代理时读设置 `network.proxy` 注入子进程
 *   （RIVET_WHISPER_PROXY / HTTPS_PROXY）——GUI 启动的 sidecar 往往没有 shell 代理环境。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { getNetworkConfig } from '../config/manager.js'
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { errorContext, serverLogger } from './logger.js'
import { createWhisperEngine } from './whisper-engine.js'

export interface SpeechEngine {
  /** 转写一个 wav 文件，返回识别文本。 */
  transcribe(wavPath: string, opts?: { lang?: string }): Promise<{ text: string }>
}

export interface SpeechRouteOptions {
  /** 模型目录（models/）：.active 持久化选择的读写位置。缺省由
   *  RIVET_WHISPER_MODEL 的 dirname 推断。 */
  modelDir?: string
  /** install 成功后回调——serve.ts 用它重建引擎（当前进程即刻切换模型）。
   *  返回重建是否成功（引擎可用）；install 响应据此填 modelReady。 */
  onModelInstalled?: () => boolean
}

/** 可安装模型白名单：key（install/status 契约）→ ggml 模型文件名。 */
export const INSTALLABLE_MODELS = {
  tiny: 'ggml-tiny.bin',
  base: 'ggml-base.bin',
  small: 'ggml-small.bin',
  turbo: 'ggml-large-v3-turbo-q5_0.bin',
} as const
export type InstallableModel = keyof typeof INSTALLABLE_MODELS

/** 模型目录里记录「当前启用模型」的隐藏文件（内容 = 文件名）。 */
export const ACTIVE_MODEL_FILE = '.active'

/**
 * 解析当前启用模型：models/.active（下载即切换的持久化选择）优先；
 * 无 .active 或指向的文件不存在 → 回退 env 指定的模型。解析不到返回 null。
 * 纯函数——serve.ts 启动/重建、status 路由共用，单测覆盖。
 */
export function resolveActiveModel(
  envModel: string | undefined,
  modelDir: string | undefined,
): { file: string; path: string } | null {
  const dir = modelDir ?? (envModel ? dirname(envModel) : undefined)
  if (!dir) return null
  const activePath = join(dir, ACTIVE_MODEL_FILE)
  if (existsSync(activePath)) {
    try {
      const file = readActiveModelFileSync(activePath)
      if (file) {
        const path = join(dir, file)
        if (existsSync(path)) return { file, path }
      }
    } catch { /* .active 读取失败（权限/并发半写）→ 回退 env */ }
  }
  if (!envModel || !existsSync(envModel)) return null
  return { file: basename(envModel), path: envModel }
}

function readActiveModelFileSync(p: string): string | null {
  // .active 是 20 字节内的文件名，同步读（启动路径 + status 高频调用）。
  const content = readFileSync(p, 'utf8').trim()
  if (!content || content.includes('/') || content.includes('..')) return null
  return content
}

/** 模型目录推断：.active 持久化选择与引擎工厂共用的单一来源。 */
function resolveModelDir(): string | undefined {
  const envModel = process.env.RIVET_WHISPER_MODEL
  return envModel ? dirname(envModel) : undefined
}

/**
 * 按当前配置装配 whisper 引擎：模型 = .active（下载即切换的持久化选择）优先，
 * 回退 RIVET_WHISPER_MODEL。serve.ts 启动与 install 后重建共用。
 */
export function createSpeechEngineFromEnv(): SpeechEngine | null {
  const bin = process.env.RIVET_WHISPER_BIN
  const envModel = process.env.RIVET_WHISPER_MODEL
  const resolved = resolveActiveModel(envModel, resolveModelDir())
  if (!resolved || !bin || !existsSync(bin) || !existsSync(resolved.path)) return null
  return createWhisperEngine({ binPath: bin, modelPath: resolved.path })
}

/** 模块级安装状态：任一安装进行中为 true，防止并发下载两个模型互相踩半截文件。 */
let installing = false

/**
 * 组装 whisper 模型下载子进程的 env。
 * 优先级：已有 RIVET_WHISPER_PROXY / HTTPS_PROXY 环境变量 > 设置页 network.proxy。
 * 设置代理写入 RIVET_WHISPER_PROXY（脚本优先读）并回填 HTTPS_PROXY/HTTP_PROXY，
 * 以便 curl `-x` 与其它继承代理的工具都能用上。
 */
export function buildWhisperFetchChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  network: { proxy?: string; noProxy?: string } = getNetworkConfig(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  const configured = network.proxy?.trim()
  const hasWhisperProxy = !!(env.RIVET_WHISPER_PROXY?.trim())
  const hasHttpsProxy = !!(env.HTTPS_PROXY?.trim() || env.https_proxy?.trim())
  const hasHttpProxy = !!(env.HTTP_PROXY?.trim() || env.http_proxy?.trim())
  if (configured && !hasWhisperProxy && !hasHttpsProxy && !hasHttpProxy) {
    env.RIVET_WHISPER_PROXY = configured
    env.HTTPS_PROXY = configured
    env.HTTP_PROXY = configured
  } else if (configured && !hasWhisperProxy) {
    // 仅补脚本专用键，不覆盖用户已有 HTTPS_PROXY。
    env.RIVET_WHISPER_PROXY = configured
  }
  const noProxy = network.noProxy?.trim()
  if (noProxy && !env.NO_PROXY?.trim() && !env.no_proxy?.trim()) {
    env.NO_PROXY = noProxy
  }
  return env
}

export function buildSpeechRoutes(
  getEngine: () => SpeechEngine | null,
  apiToken?: string,
  opts?: SpeechRouteOptions,
): Record<string, RouteHandler> {
  const modelDir = opts?.modelDir
  const routes: Record<string, RouteHandler> = {
    'GET /speech/model/status': async () => {
      const bin = process.env.RIVET_WHISPER_BIN
      const envModel = process.env.RIVET_WHISPER_MODEL
      const resolved = resolveActiveModel(envModel, modelDir)
      return {
        status: 200,
        body: {
          binReady: !!bin && existsSync(resolve(bin)),
          modelReady: resolved !== null,
          // env 存在但解析不到（文件缺失）时仍显示文件名——设置页据此提示
          // 该下载哪个模型；完全未配置才显示 null。
          model: resolved ? resolved.file : envModel ? basename(envModel) : null,
          installing,
        },
      }
    },
    'POST /speech/model/install': async (body) => {
      const model = (body as { model?: unknown }).model
      if (typeof model !== 'string' || !(model in INSTALLABLE_MODELS)) {
        return { status: 400, body: { error: 'invalid-model' } }
      }
      if (installing) {
        return { status: 409, body: { error: 'install-in-progress' } }
      }
      // 默认脚本相对 sidecar cwd 解析（dev 为 desktop 目录）；打包后部署侧
      // 可用 RIVET_WHISPER_FETCH_SCRIPT 指到实际位置，测试注入 fake 脚本。
      const script =
        process.env.RIVET_WHISPER_FETCH_SCRIPT ||
        join(process.cwd(), 'desktop', 'scripts', 'fetch-whisper-runtime.js')
      const args = ['--model', model]
      installing = true
      try {
        await new Promise<void>((resolveInstall, reject) => {
          const child = spawn('node', [script, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildWhisperFetchChildEnv(),
            windowsHide: true,
          })
          let stderr = ''
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString()
          })
          child.on('error', reject)
          child.on('close', (code) => {
            if (code === 0) resolveInstall()
            else reject(new Error(`fetch-whisper-runtime exit ${code}: ${stderr.trim().slice(0, 200)}`))
          })
        })
        // 下载成功 → 写 .active（下载即切换的持久化锚点）→ 通知 serve 重建引擎。
        // 模型目录不可得（env 未配置的测试场景）时跳过持久化，回调照常。
        const dir = modelDir ?? resolveModelDir()
        if (dir) {
          await writeFile(join(dir, ACTIVE_MODEL_FILE), INSTALLABLE_MODELS[model as InstallableModel], 'utf8')
        }
        // modelReady = 引擎重建结果：重建失败（如 bin 缺失）显式暴露给前端，
        // 避免「模型已就绪」toast 与实际转写可用性漂移。
        const modelReady = opts?.onModelInstalled?.() ?? true
        return { status: 200, body: { ok: true, modelReady } }
      } catch (err) {
        serverLogger.warn('Speech model install failed', { ...errorContext(err) })
        return { status: 500, body: { error: 'model-install-failed' } }
      } finally {
        installing = false
      }
    },
    'POST /speech/transcribe': async (body) => {
      const engine = getEngine()
      if (!engine) {
        return { status: 503, body: { error: 'whisper-unavailable' } }
      }
      const audio = (body as { audio?: unknown }).audio
      if (typeof audio !== 'string' || audio.length === 0) {
        return { status: 400, body: { error: 'invalid-audio' } }
      }
      const lang = (body as { lang?: unknown }).lang
      if (lang !== undefined && typeof lang !== 'string') {
        return { status: 400, body: { error: 'invalid-audio' } }
      }
      const wav = Buffer.from(audio, 'base64')
      // 最小 wav 头校验：>=44 字节且 RIFF/WAVE 魔数。防垃圾载荷进 spawn。
      if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        return { status: 400, body: { error: 'invalid-wav' } }
      }
      const dir = await mkdtemp(join(tmpdir(), 'rivet-speech-'))
      const wavPath = join(dir, 'input.wav')
      try {
        await writeFile(wavPath, wav)
        const { text } = await engine.transcribe(wavPath, lang ? { lang } : undefined)
        return { status: 200, body: { text } }
      } catch (err) {
        serverLogger.warn('Speech transcribe failed', { ...errorContext(err) })
        return { status: 500, body: { error: 'transcribe-failed' } }
      } finally {
        void rm(dir, { recursive: true, force: true })
      }
    },
  }
  // 路由级鉴权（防御纵深）：生产流量本有 index.ts 全局门，此处保证构建器
  // 被直接挂载（测试/二次 createServer）时同样不裸奔。未传 token 的直连
  // 消费方（测试）保持原行为。
  if (!apiToken) return routes
  const wrap = (h: RouteHandler): RouteHandler => async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return h(body, params, headers, res)
  }
  return Object.fromEntries(Object.entries(routes).map(([k, h]) => [k, wrap(h)]))
}

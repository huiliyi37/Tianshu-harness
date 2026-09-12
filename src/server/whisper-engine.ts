/**
 * whisper.cpp 本地转写引擎：spawn whisper-cli 把 wav 转成文本。
 * 输出用 -otxt -nt（纯文本、无时间戳），spawn 完成后读 <wav>.txt。
 * 超时 SIGKILL 兜底（whisper 在坏模型/坏音频上可能挂起）。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { SpeechEngine } from './speech-routes.js'

export interface WhisperEngineOptions {
  /** whisper-cli 可执行文件路径。 */
  binPath: string
  /** ggml 模型文件路径（如 ggml-tiny.bin）。 */
  modelPath: string
  /** 单次转写超时（毫秒），默认 60s。 */
  timeoutMs?: number
}

/**
 * 按语言注入 initial prompt（--prompt）：whisper 用 prompt 做解码文本先验，
 * 对中文同音字/领域词汇有轻度纠偏（2026-08 语音升级 A 实测项）。
 * 只对显式语言注入——auto 检测时 prompt 会干扰语言判定，不传。
 */
const LANG_PROMPTS: Record<string, string> = {
  zh: '以下是中文语音输入，可能是编程指令、代码片段、文件名或命令。',
  en: 'This is a voice transcription of programming instructions, possibly containing code, file names, or commands.',
}

export function createWhisperEngine(opts: WhisperEngineOptions): SpeechEngine {
  const timeoutMs = opts.timeoutMs ?? 60_000
  return {
    transcribe(wavPath, o) {
      return new Promise((resolve, reject) => {
        const args = ['-m', opts.modelPath, '-f', wavPath, '-otxt', '-nt']
        // 显式开启非语音 token 抑制（笑声/杂音 token）：该开关默认值随
        // whisper.cpp 版本漂移（master 为 false），显式钉住避免旧版默认关。
        args.push('-sns')
        if (o?.lang && o.lang !== 'auto') {
          args.push('-l', o.lang)
          const prompt = LANG_PROMPTS[o.lang]
          if (prompt !== undefined) args.push('--prompt', prompt)
        }
        const child = spawn(opts.binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`whisper-cli timeout after ${timeoutMs}ms`))
        }, timeoutMs)
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code !== 0) {
            reject(new Error(`whisper-cli exit ${code}: ${stderr.trim().slice(0, 200)}`))
            return
          }
          readFile(`${wavPath}.txt`, 'utf8')
            .then((t) => resolve({ text: t.trim() }))
            .catch(reject)
        })
      })
    },
  }
}

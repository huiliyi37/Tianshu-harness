import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWhisperEngine } from '../whisper-engine.js'

/**
 * 造一个 fake whisper-cli：node 脚本，解析 -f 后的路径写 <path>.txt。
 * 成功（默认）/ 失败（argv 含 --fail）/ 挂起（argv 含 --hang）。
 */
async function makeFakeBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-test-'))
  const script = join(dir, 'fake-whisper.mjs')
  const src = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
if (process.env.WHISPER_FAKE_FAIL) { process.exit(1) }
if (process.env.WHISPER_FAKE_HANG) { setInterval(() => {}, 60_000); await new Promise(() => {}); }
const argv = process.argv.slice(2)
if (process.env.WHISPER_FAKE_DUMP_ARGS) {
  writeFileSync(process.env.WHISPER_FAKE_DUMP_ARGS, JSON.stringify(argv), 'utf8')
}
const i = argv.indexOf('-f')
if (i >= 0 && argv[i + 1]) writeFileSync(argv[i + 1] + '.txt', 'hello world', 'utf8')
`
  await writeFile(script, src)
  await chmod(script, 0o755)
  return script
}

test('whisper-engine: 成功转写 → 读取 <wav>.txt 文本', async () => {
  const bin = await makeFakeBin()
  try {
    const engine = createWhisperEngine({ binPath: bin, modelPath: '/tmp/model.bin' })
    const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-wav-'))
    const wav = join(dir, 'in.wav')
    await writeFile(wav, Buffer.alloc(44))
    const { text } = await engine.transcribe(wav)
    assert.equal(text, 'hello world')
    await rm(dir, { recursive: true, force: true })
  } finally {
    await rm(join(bin, '..'), { recursive: true, force: true })
  }
})

test('whisper-engine: binPath 是 JS 脚本时经解释器执行（不依赖可执行位）', async () => {
  const bin = await makeFakeBin()
  try {
    // 摘掉可执行位：POSIX 上裸 spawn 一个无执行位的 .mjs 会 EACCES，只有「经
    // process.execPath 解释执行」这条还能跑通。Windows 本就没有可执行位语义
    // （chmod 无效、shebang 不生效），所以这一条同时钉住「JS 脚本当 binPath
    // 在 win32 上也成立」——真机跑不到的分支，在 POSIX 上用 EACCES 反证。
    await chmod(bin, 0o644)
    const engine = createWhisperEngine({ binPath: bin, modelPath: '/tmp/model.bin' })
    const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-noexec-'))
    const wav = join(dir, 'in.wav')
    await writeFile(wav, Buffer.alloc(44))
    const { text } = await engine.transcribe(wav)
    assert.equal(text, 'hello world')
    await rm(dir, { recursive: true, force: true })
  } finally {
    await rm(join(bin, '..'), { recursive: true, force: true })
  }
})

test('whisper-engine: exit 非 0 → reject 带 stderr 摘要', async () => {
  const bin = await makeFakeBin()
  try {
    const engine = createWhisperEngine({ binPath: bin, modelPath: '/tmp/model.bin' })
    const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-wav-'))
    const wav = join(dir, 'in.wav')
    await writeFile(wav, Buffer.alloc(44))
    process.env.WHISPER_FAKE_FAIL = '1'
    try {
      await assert.rejects(() => engine.transcribe(wav, { lang: 'zh' }), /exit 1/)
    } finally {
      delete process.env.WHISPER_FAKE_FAIL
    }
    await rm(dir, { recursive: true, force: true })
  } finally {
    await rm(join(bin, '..'), { recursive: true, force: true })
  }
})

test('whisper-engine: 挂起 → 超时 SIGKILL reject', async () => {
  const bin = await makeFakeBin()
  try {
    const engine = createWhisperEngine({ binPath: bin, modelPath: '/tmp/model.bin', timeoutMs: 300 })
    const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-wav-'))
    const wav = join(dir, 'in.wav')
    await writeFile(wav, Buffer.alloc(44))
    process.env.WHISPER_FAKE_HANG = '1'
    try {
      await assert.rejects(() => engine.transcribe(wav), /timeout/)
    } finally {
      delete process.env.WHISPER_FAKE_HANG
    }
    await rm(dir, { recursive: true, force: true })
  } finally {
    await rm(join(bin, '..'), { recursive: true, force: true })
  }
})

// ── 解码参数契约（whisper.cpp CLI 参数面）──
// 中文错别字专项（2026-08 语音升级 A）：zh 转写必须带 --prompt（initial
// prompt 中文先验，whisper 用它做文本偏好）与显式 -sns（suppress non-speech
// tokens；该开关默认值随 whisper.cpp 版本漂移，显式钉住避免旧版默认关）。
// beam size / temperature fallback 为 whisper.cpp 默认开启项（-bs 5 /
// 无 -nf），不重复传。auto 检测时不带 prompt（prompt 会干扰语言检测）也不带 -l。

async function transcribeWithArgs(opts: { lang?: string }): Promise<string[]> {
  const bin = await makeFakeBin()
  try {
    const engine = createWhisperEngine({ binPath: bin, modelPath: '/tmp/model.bin' })
    const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-wav-'))
    const wav = join(dir, 'in.wav')
    await writeFile(wav, Buffer.alloc(44))
    const dump = join(dir, 'args.json')
    process.env.WHISPER_FAKE_DUMP_ARGS = dump
    try {
      await engine.transcribe(wav, opts.lang ? { lang: opts.lang } : undefined)
      return JSON.parse(await readFile(dump, 'utf8')) as string[]
    } finally {
      delete process.env.WHISPER_FAKE_DUMP_ARGS
      await rm(dir, { recursive: true, force: true })
    }
  } finally {
    await rm(join(bin, '..'), { recursive: true, force: true })
  }
}

test('whisper-engine: zh 转写带 --prompt（中文先验）与显式 -sns', async () => {
  const args = await transcribeWithArgs({ lang: 'zh' })
  assert.ok(args.includes('-sns'), '显式开启非语音 token 抑制')
  const promptIdx = args.indexOf('--prompt')
  assert.ok(promptIdx >= 0, 'zh 转写必须带 --prompt')
  assert.ok(promptIdx + 1 < args.length && /[\u4e00-\u9fff]/.test(args[promptIdx + 1]!), 'prompt 为中文文本')
  assert.equal(args[args.indexOf('-l') + 1], 'zh', '语言参数仍传递')
})

test('whisper-engine: en 转写带英文 prompt 与 -sns', async () => {
  const args = await transcribeWithArgs({ lang: 'en' })
  assert.ok(args.includes('-sns'))
  const promptIdx = args.indexOf('--prompt')
  assert.ok(promptIdx >= 0, 'en 转写必须带 --prompt')
  assert.equal(args[args.indexOf('-l') + 1], 'en')
})

test('whisper-engine: auto/无 lang 不带 --prompt 与 -l（prompt 会干扰语言检测）', async () => {
  const args = await transcribeWithArgs({})
  assert.ok(!args.includes('--prompt'), 'auto 检测不带 prompt')
  assert.ok(!args.includes('-l'), 'auto 检测不带语言参数')
  assert.ok(args.includes('-sns'), '-sns 独立于语言始终显式传入')
})

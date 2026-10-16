import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash'
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  if (existsSync(gitBash)) return gitBash
  const localBash = path.join(process.env.LOCALAPPDATA || '', 'Programs\\Git\\bin\\bash.exe')
  if (existsSync(localBash)) return localBash
  return 'bash'
}
const BASH = resolveBash()

const root = path.resolve(import.meta.dirname, '../..')
const hostSource = await readFile(path.join(root, 'scripts/build-linux-container.sh'), 'utf8')
const containerSource = await readFile(path.join(root, 'scripts/linux-container-build.sh'), 'utf8')
const imageId = 'sha256:' + 'a'.repeat(64)

interface ImageFixture {
  arch?: 'amd64' | 'arm64'
  localPlatform?: string | null
  pulledPlatform?: string | null
  platformAware?: boolean
  pullError?: boolean
  proxy?: string
  image?: string
}

async function runHost(config: ImageFixture, source = hostSource) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tianshu-linux-image-'))
  await mkdir(path.join(dir, 'scripts')); await mkdir(path.join(dir, 'bin'))
  await writeFile(path.join(dir, 'scripts/build.sh'), source)
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config))
  await writeFile(path.join(dir, 'bin/docker'), `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2), cfg = JSON.parse(fs.readFileSync(process.env.DOCKER_TEST_CONFIG, 'utf8'))
fs.appendFileSync(process.env.DOCKER_TEST_LOG, JSON.stringify(args)+'\\n')
if (args[0] === 'image' && args[1] === 'inspect') {
  if (args.includes('--platform') && !cfg.platformAware) process.exit(64)
  const platform = fs.existsSync(process.env.DOCKER_TEST_PULLED) ? cfg.pulledPlatform : cfg.localPlatform
  if (!platform) process.exit(1)
  console.log('${imageId} '+platform); process.exit(0)
}
if (args[0] === 'pull') {
  if (cfg.pullError) process.exit(71)
  fs.writeFileSync(process.env.DOCKER_TEST_PULLED, 'pulled'); process.exit(0)
}
if (args[0] === 'volume') process.exit(0)
// End the fixture before source copying, real build commands or artifact cleanup.
if (args[0] === 'run') process.exit(73)
process.exit(99)
`, { mode: 0o755 })
  const result = spawnSync(BASH, [path.join(dir, 'scripts/build.sh'), config.arch ?? 'amd64'], {
    cwd: dir, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH,
      IMG: config.image ?? '', CONTAINER_PROXY: config.proxy ?? '',
      RIVET_RELEASE_KEY_PKCS8: 'fixture-only', TAURI_SIGNING_PRIVATE_KEY: 'fixture-only',
      DOCKER_TEST_CONFIG: path.join(dir, 'config.json'), DOCKER_TEST_LOG: path.join(dir, 'calls.jsonl'),
      DOCKER_TEST_PULLED: path.join(dir, 'pulled'),
    },
  })
  assert.equal(result.error, undefined)
  const calls: string[][] = (await readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { ...result, calls }
}

function assertRunUsesValidatedImage(result: Awaited<ReturnType<typeof runHost>>) {
  assert.equal(result.status, 73, result.stderr)
  const run = result.calls.find(args => args[0] === 'run')!
  assert.ok(run.includes('--pull=never'))
  assert.equal(run.at(-3), imageId, 'run must use the inspected ID, never the mutable tag')
}

for (const arch of ['amd64', 'arm64'] as const) {
  test(`cached linux/${arch} image works offline on legacy engines`, async () => {
    const result = await runHost({ arch, localPlatform: `linux/${arch}`, image: `ubuntu-${arch}:22.04` })
    assertRunUsesValidatedImage(result)
    assert.equal(result.calls.some(args => args[0] === 'pull'), false)
    assert.ok(result.calls.some(args => args[0] === 'image' && !args.includes('--platform')), 'legacy inspect fallback is exercised')
  })
}

test('new engines select a matching local platform without pulling', async () => {
  const result = await runHost({ platformAware: true, localPlatform: 'linux/amd64' })
  assertRunUsesValidatedImage(result)
  assert.equal(result.calls.filter(args => args[0] === 'image').length, 1)
  assert.equal(result.calls.some(args => args[0] === 'pull'), false)
})

test('switching from an amd64 cache to arm64 also pulls the requested platform', async () => {
  const result = await runHost({ arch: 'arm64', localPlatform: 'linux/amd64', pulledPlatform: 'linux/arm64' })
  assertRunUsesValidatedImage(result)
  assert.deepEqual(result.calls.find(args => args[0] === 'pull'), ['pull', '--platform', 'linux/arm64', 'ubuntu:22.04'])
})

for (const localPlatform of [null, 'linux/arm64', 'windows/amd64']) {
  test(`missing or mismatched cache (${localPlatform}) pulls and validates the requested platform`, async () => {
    const result = await runHost({ localPlatform, pulledPlatform: 'linux/amd64' })
    assertRunUsesValidatedImage(result)
    assert.deepEqual(result.calls.find(args => args[0] === 'pull'), ['pull', '--platform', 'linux/amd64', 'ubuntu:22.04'])
    const pull = result.calls.findIndex(args => args[0] === 'pull')
    assert.ok(result.calls.slice(pull + 1).some(args => args[0] === 'image'), 'pull success is not proof of platform correctness')
  })
}

test('a pull that still resolves to the wrong platform stops before volume changes or run', async () => {
  const result = await runHost({ localPlatform: 'linux/arm64', pulledPlatform: 'linux/arm64' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /需要 linux\/amd64，实际 linux\/arm64/)
  assert.equal(result.calls.some(args => args[0] === 'volume' || args[0] === 'run'), false)
})

test('pull errors stop without using the wrong cached image', async () => {
  const result = await runHost({ localPlatform: 'linux/arm64', pullError: true })
  assert.equal(result.status, 71)
  assert.equal(result.calls.some(args => args[0] === 'volume' || args[0] === 'run'), false)
})

test('container downloads receive upper/lowercase proxy and identical bypass rules', async () => {
  const proxy = 'http://proxy.fixture:7890'
  const result = await runHost({ localPlatform: 'linux/amd64', proxy })
  assertRunUsesValidatedImage(result)
  const run = result.calls.find(args => args[0] === 'run')!
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.ok(run.includes(`${name}=${proxy}`))
  const upper = run.find(arg => arg.startsWith('NO_PROXY='))!.slice('NO_PROXY='.length)
  assert.ok(run.includes(`no_proxy=${upper}`))
  assert.ok(upper.includes('localhost') && upper.includes('mirrors.aliyun.com'))
})

test('an absent container proxy does not inject proxy settings', async () => {
  const result = await runHost({ localPlatform: 'linux/amd64' })
  assertRunUsesValidatedImage(result)
  const run = result.calls.find(args => args[0] === 'run')!
  assert.equal(run.some(arg => /^(https?_proxy|HTTPS?_PROXY|NO_PROXY|no_proxy)=/.test(arg)), false)
})

test('restoring mutable-tag startup is caught by the validated-image assertion', async () => {
  const invocation = '"$IMAGE_ID" sleep infinity'
  assert.ok(hostSource.includes(invocation))
  const result = await runHost({ localPlatform: 'linux/amd64' }, hostSource.replace(invocation, '"$IMG" sleep infinity'))
  assert.throws(() => assertRunUsesValidatedImage(result), assert.AssertionError)
})

test('restoring image-exists-only acceptance is caught by the wrong-architecture scenario', async () => {
  const guard = '[[ "$IMAGE_ID" =~ ^sha256:[[:xdigit:]]{64}$ ]] && [[ "$IMAGE_PLATFORM" == "$PLATFORM" ]]'
  assert.ok(hostSource.includes(guard))
  const result = await runHost({ localPlatform: 'linux/arm64', pulledPlatform: 'linux/amd64' }, hostSource.replace(guard, '[[ -n "$IMAGE_ID" ]]'))
  assert.throws(() => assert.ok(result.calls.some(args => args[0] === 'pull'), 'wrong-architecture cache must pull'), assert.AssertionError)
})

async function runApt(source = containerSource, failUpdate = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tianshu-linux-apt-'))
  await mkdir(path.join(dir, 'bin'))
  await writeFile(path.join(dir, 'bin/apt-get'), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2)
const env = Object.fromEntries(['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','all_proxy','ALL_PROXY','DEBIAN_FRONTEND'].map(key=>[key,process.env[key]]))
fs.appendFileSync(process.env.APT_TEST_LOG, JSON.stringify({args,env})+'\\n')
if (args.includes('update') && process.env.APT_TEST_FAIL === '1') process.exit(67)
`, { mode: 0o755 })
  const boundary = source.indexOf('# Node 24')
  assert.ok(boundary > 0, 'fixture must stop before real download/build commands')
  const prefix = source.slice(0, boundary)
  assert.ok(prefix.includes('apt_get update') && prefix.includes('apt_get install'))
  await writeFile(path.join(dir, 'apt-fixture.sh'), prefix.replace('cd /work', 'cd "$APT_TEST_WORK"') + '\nprintf "%s" "$HTTP_PROXY"\n')
  const proxy = 'http://proxy.fixture:7890'
  const result = spawnSync(BASH, [path.join(dir, 'apt-fixture.sh')], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH,
      APT_TEST_WORK: dir, APT_TEST_LOG: path.join(dir, 'calls.jsonl'), APT_TEST_FAIL: failUpdate ? '1' : '0',
      http_proxy: proxy, https_proxy: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, all_proxy: proxy, ALL_PROXY: proxy,
    },
  })
  assert.equal(result.error, undefined)
  const calls = (await readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as { args: string[]; env: Record<string, string> }[]
  return { ...result, calls, proxy }
}

function assertAptDirect(result: Awaited<ReturnType<typeof runApt>>) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.calls.length, 2)
  for (const { args, env } of result.calls) {
    assert.ok(args.includes('Acquire::http::Proxy=DIRECT') && args.includes('Acquire::https::Proxy=DIRECT'))
    assert.equal(env.DEBIAN_FRONTEND, 'noninteractive')
    for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) assert.equal(env[key], '')
  }
  assert.equal(result.stdout, result.proxy, 'other downloads must retain the caller proxy')
}

test('apt update/install bypass configured and environment proxies without changing download environment', async () => {
  assertAptDirect(await runApt())
})

test('apt update failure aborts before package installation', async () => {
  const result = await runApt(containerSource, true)
  assert.equal(result.status, 67)
  assert.equal(result.calls.length, 1)
})

test('restoring plain apt-get invocation is caught by the direct-download assertions', async () => {
  const wrapper = /apt_get\(\) \{[\s\S]*?\n\}/
  assert.match(containerSource, wrapper)
  const result = await runApt(containerSource.replace(wrapper, 'apt_get() { apt-get "$@"; }'))
  assert.throws(() => assertAptDirect(result), assert.AssertionError)
})

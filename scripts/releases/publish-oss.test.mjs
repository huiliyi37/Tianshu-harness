import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const script = join(root, 'scripts/upload-update-to-oss.sh')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const oss = 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/'
const github = 'https://github.com/huiliyi37/Tianshu-harness/releases/download/'
let windowsBin

function bashPath(path) {
  return /^[A-Za-z]:[\\/]/.test(path) ? '/' + path[0].toLowerCase() + '/' + path.slice(3).replaceAll('\\', '/') : path
}

function resolveBash() {
  if (process.platform !== 'win32') return '/bin/bash'
  const paths = [process.env.RIVET_GIT_BASH_PATH, join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe')]
  for (const directory of (process.env.PATH ?? '').split(delimiter)) if (/git[\\/](?:usr[\\/])?bin/i.test(directory)) paths.push(join(directory, 'bash.exe'))
  const found = paths.find(path => path && existsSync(path))
  if (!found) throw new Error('OSS publisher behavior tests require Git for Windows Bash; set RIVET_GIT_BASH_PATH to its bash.exe')
  return found
}

after(() => { if (windowsBin) rmSync(windowsBin, {recursive: true, force: true}) })

const fakeCLI = `#!/usr/bin/env node
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
const home = process.env.OSS_TEST_HOME
const state = JSON.parse(readFileSync(join(home, 'state.json')))
const executable = basename(process.execPath).toLowerCase()
const nativeFake = ['gh.exe', 'ossutil.exe'].includes(executable)
const args = nativeFake ? [basename(process.argv[1]), ...process.argv.slice(2)] : process.argv.slice(2)
const value = flag => args[args.indexOf(flag) + 1]
const command = nativeFake ? executable.slice(0, -4) : basename(process.argv[1])
appendFileSync(join(home, 'events.jsonl'), JSON.stringify({command, args}) + '\\n')
if (command === 'gh') {
  if (state.ghFailure) { process.stderr.write('Untrusted diagnostic sentinel'); process.exit(11) }
  if (args[0] === 'api' && args[1] === 'repos/huiliyi37/Tianshu-harness/releases/tags/v' + state.version && args.length === 2) {
    process.stdout.write(JSON.stringify(state.release))
  } else if (args[0] === 'release' && args[1] === 'download' && args[2] === 'v' + state.version && value('--repo') === 'huiliyi37/Tianshu-harness') {
    const name = value('--pattern')
    if (!state.release.assets.some(asset => asset.name === name)) process.exit(3)
    mkdirSync(value('--dir'), { recursive: true })
    copyFileSync(join(home, 'github', name), join(value('--dir'), name))
  } else process.exit(4)
} else if (command === 'ossutil') {
  if (args[0] === 'api' && args[1] === 'get-bucket-versioning' && value('--bucket') === 'tianshu-update') {
    process.stdout.write(state.versioning ?? '<VersioningConfiguration/>')
  } else if (args[0] === 'api' && args[1] === 'put-object' && value('--bucket') === 'tianshu-update' && value('--forbid-overwrite') === 'true') {
    const key = value('--key')
    if (!key.startsWith('tianshu/v' + state.version + '/')) process.exit(5)
    const destination = join(home, 'objects', key)
    mkdirSync(dirname(destination), { recursive: true })
    if (state.raceKey === key && !existsSync(destination)) writeFileSync(destination, state.raceBytes)
    if (existsSync(destination)) process.exit(6)
    copyFileSync(value('--body').slice('file://'.length), destination)
    if (state.flipControlAfterAsset && !key.endsWith('.json')) {
      state.control.stable.catalogSha256 = '0'.repeat(64)
      writeFileSync(join(home, 'state.json'), JSON.stringify(state))
    }
    if (state.corruptFixedCatalogAfterAsset && !key.endsWith('.json')) writeFileSync(join(home, 'objects', 'tianshu/release-catalog.json'), 'Conflicting fixed catalog')
    if (state.failAfterWrite === key) process.exit(7)
  } else if (args[0] === 'cp' && args[2]?.startsWith('oss://tianshu-update/tianshu/')) {
    const key = args[2].slice('oss://tianshu-update/'.length)
    if (!['tianshu/latest.json', 'tianshu/release-catalog.json'].includes(key)) process.exit(8)
    const destination = join(home, 'objects', key)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(args[1], destination)
    if (state.failAfterWrite === key) process.exit(7)
  } else process.exit(9)
} else process.exit(10)
`

const fetchProbe = `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
if (['gh.exe', 'ossutil.exe'].includes(basename(process.execPath).toLowerCase())) {
  await import(pathToFileURL(join(process.env.OSS_TEST_HOME, 'fake-cli.mjs')).href)
  process.exit(0)
}
globalThis.fetch = async (url, options = {}) => {
  const home = process.env.OSS_TEST_HOME
  const state = JSON.parse(readFileSync(join(home, 'state.json')))
  const entry = String(url)
  appendFileSync(join(home, 'events.jsonl'), JSON.stringify({command: 'fetch', url: entry, method: options.method ?? 'GET'}) + '\\n')
  if (options.headers?.Authorization || options.headers?.Cookie) throw new Error('Credential-bearing public probe')
  if (state.networkFailure) throw new Error('Controlled offline probe')
  const controls = ['${oss}tianshu/update-control.json', '${github}update-control/update-control.json']
  if (controls.includes(entry)) {
    if (state.missingControl) return new Response(null, {status: 404})
    const control = entry === controls[1] && state.secondControl ? state.secondControl : state.control
    return new Response(state.controlBody ?? JSON.stringify(control))
  }
  if (!entry.startsWith('${oss}tianshu/')) throw new Error('Unexpected external fetch')
  const key = entry.slice('${oss}'.length)
  if (state.probeStatus?.[key]) return new Response(null, {status: state.probeStatus[key]})
  const path = join(home, 'objects', key)
  if (!existsSync(path)) return new Response(null, {status: 404})
  return new Response(readFileSync(path), {status: 200})
}
`

function fixture(context, version = '3.31.0') {
  const home = mkdtempSync(join(tmpdir(), 'tianshu-oss-behavior space-'))
  context.after(() => rmSync(home, { recursive: true, force: true }))
  for (const directory of ['bin', 'github', 'objects', 'workspace', 'local-assets']) mkdirSync(join(home, directory))
  writeFileSync(join(home, 'fake-cli.mjs'), fakeCLI)
  if (process.platform === 'win32') {
    if (!windowsBin) {
      windowsBin = mkdtempSync(join(tmpdir(), 'tianshu-oss-native-bin-'))
      for (const command of ['gh', 'ossutil']) copyFileSync(process.execPath, join(windowsBin, command + '.exe'))
    }
  } else {
    for (const command of ['gh', 'ossutil']) {
      const file = join(home, 'bin', command)
      writeFileSync(file, fakeCLI)
      chmodSync(file, 0o755)
    }
  }
  writeFileSync(join(home, 'fetch-probe.mjs'), fetchProbe)
  const catalog = { schemaVersion: 1, revision: 1, version, publishedAt: '2026-10-14T00:00:00Z', artifacts: [] }
  const manifest = { version, notes: 'Local signed-package fixture, not real upgrade acceptance', pub_date: catalog.publishedAt, platforms: {} }
  const assets = []
  const add = (name, bytes) => {
    writeFileSync(join(home, 'github', name), bytes)
    assets.push({name, size: bytes.length, digest: 'sha256:' + hash(bytes)})
  }
  for (const [platform, suffix] of [['windows-x86_64', 'x64-setup.exe'], ['darwin-aarch64', 'aarch64.app.tar.gz']]) {
    const name = 'Tianshu_' + version + '_' + suffix
    const bytes = Buffer.from('Package fixture ' + name)
    const signature = 'Public signature fixture ' + name
    const source = {url: github + 'v' + version + '/' + name, verified: true, verifiedAt: catalog.publishedAt, size: bytes.length, sha256: hash(bytes)}
    catalog.artifacts.push({platform, purpose: 'update', fileName: name, size: bytes.length, sha256: hash(bytes), signature, sources: {github: source, oss: {url: oss + 'tianshu/v' + version + '/' + name, verified: false}}})
    manifest.platforms[platform] = {url: source.url, signature}
    add(name, bytes)
    add(name + '.sig', Buffer.from(signature + '\n'))
    if (platform.startsWith('darwin')) {
      const dmgName = 'Tianshu_' + version + '_aarch64.dmg', dmg = Buffer.from('DMG fixture')
      const dmgSource = {...source, url: github + 'v' + version + '/' + dmgName, size: dmg.length, sha256: hash(dmg)}
      catalog.artifacts.push({platform, purpose: 'install', fileName: dmgName, size: dmg.length, sha256: hash(dmg), sources: {github: dmgSource}})
      add(dmgName, dmg)
    } else catalog.artifacts.push({...catalog.artifacts[0], purpose: 'install', signature: undefined})
  }
  const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n')
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  add('release-catalog.json', catalogBytes)
  add('latest.json', manifestBytes)
  for (const name of ['release-catalog.json', 'latest.json']) writeFileSync(join(home, 'workspace', name), readFileSync(join(home, 'github', name)))
  const control = {schemaVersion: 1, revision: 3, stable: {version, catalogSha256: hash(catalogBytes)}, revokedVersions: []}
  writeFileSync(join(home, 'workspace', 'update-control.json'), JSON.stringify(control))
  const state = {version, control, release: {tag_name: 'v' + version, draft: false, prerelease: false, assets}}
  const save = () => writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  save()
  const events = () => existsSync(join(home, 'events.jsonl')) ? readFileSync(join(home, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const writes = () => events().filter(event => event.command === 'ossutil' && (event.args[0] === 'cp' || event.args[1] === 'put-object'))
  const run = (args = [], env = {}) => {
    save()
    const executableBin = windowsBin ?? join(home, 'bin')
    const platformEnv = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(name => process.env[name]).map(name => [name, process.env[name]]))
    return spawnSync(resolveBash(), [bashPath(script), ...args.map(bashPath)], {cwd: join(home, 'workspace'), encoding: 'utf8', timeout: 30000, windowsHide: true, env: {...platformEnv, PATH: executableBin + delimiter + process.env.PATH, HOME: home, TMPDIR: bashPath(tmpdir()), OSS_TEST_HOME: home, ...(windowsBin ? {OSSUTIL_BIN: join(windowsBin, 'ossutil.exe').replaceAll('\\', '/')} : {}), NODE_OPTIONS: '--import="' + pathToFileURL(join(home, 'fetch-probe.mjs')).href + '"', ...env}})
  }
  const object = key => join(home, 'objects', 'tianshu', key)
  const put = (key, bytes) => {const path = object(key); mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, bytes)}
  return {home, catalog, catalogBytes, manifest, state, run, events, writes, object, put}
}

test('Git Bash path conversion supports Windows drive letters and spaces', () => {
  assert.equal(bashPath('C:\\Users\\Test User\\Temp\\fixture.sh'), '/c/Users/Test User/Temp/fixture.sh')
  assert.equal(bashPath('E:/workspace/release/script.sh'), '/e/workspace/release/script.sh')
  assert.equal(bashPath('/tmp/fixture.sh'), '/tmp/fixture.sh')
})

test('native fake executable router runs before a nonexistent main is resolved', context => {
  const setup = fixture(context)
  const executable = join(setup.home, 'gh.exe')
  copyFileSync(process.execPath, executable)
  const result = spawnSync(executable, ['api', 'repos/huiliyi37/Tianshu-harness/releases/tags/v3.31.0'], {cwd: join(setup.home, 'workspace'), encoding: 'utf8', windowsHide: true, env: {OSS_TEST_HOME: setup.home, NODE_OPTIONS: '--import="' + pathToFileURL(join(setup.home, 'fetch-probe.mjs')).href + '"'}})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).tag_name, 'v3.31.0')
  assert.deepEqual(setup.events().map(event => [event.command, event.args]), [['gh', ['api', 'repos/huiliyi37/Tianshu-harness/releases/tags/v3.31.0']]])
})

test('dry run acquires and validates GitHub packages but changes no public or workspace bytes', context => {
  const setup = fixture(context), before = readdirSync(join(setup.home, 'workspace'))
  const result = setup.run(['--dry-run'])
  assert.ok(result.stdout, JSON.stringify(result))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /DRY RUN/)
  assert.equal(setup.writes().length, 0)
  assert.ok(setup.events().some(event => event.command === 'gh' && event.args[1] === 'download' && event.args.includes(setup.catalog.artifacts[0].fileName)))
  assert.deepEqual(readdirSync(join(setup.home, 'workspace')), before)
  assert.deepEqual(readFileSync(join(setup.home, 'workspace', 'release-catalog.json')), setup.catalogBytes)
})

test('stable publication mirrors packages, original signatures, immutable metadata and guarded fixed entries', context => {
  const setup = fixture(context), result = setup.run()
  assert.equal(result.status, 0, result.stderr)
  for (const name of ['Tianshu_3.31.0_x64-setup.exe', 'Tianshu_3.31.0_x64-setup.exe.sig', 'Tianshu_3.31.0_aarch64.app.tar.gz', 'Tianshu_3.31.0_aarch64.app.tar.gz.sig', 'Tianshu_3.31.0_aarch64.dmg']) {
    assert.deepEqual(readFileSync(setup.object('v3.31.0/' + name)), readFileSync(join(setup.home, 'github', name)))
  }
  assert.deepEqual(readFileSync(setup.object('release-catalog.json')), setup.catalogBytes)
  assert.deepEqual(readFileSync(setup.object('v3.31.0/release-catalog.json')), setup.catalogBytes)
  const mirrored = JSON.parse(readFileSync(setup.object('latest.json')))
  for (const [platform, entry] of Object.entries(mirrored.platforms)) {
    assert.equal(entry.signature, setup.manifest.platforms[platform].signature)
    assert.equal(entry.url, oss + 'tianshu/v3.31.0/' + setup.catalog.artifacts.find(asset => asset.platform === platform && asset.purpose === 'update').fileName)
  }
  assert.deepEqual(readFileSync(setup.object('v3.31.0/latest.json')), readFileSync(setup.object('latest.json')))
  const historyEvents = setup.events()
  for (const [eventIndex, write] of historyEvents.entries()) {
    if (write.command !== 'ossutil') continue
    if (write.args[0] === 'cp' || write.args.includes('tianshu/v3.31.0/release-catalog.json') || write.args.includes('tianshu/v3.31.0/latest.json')) {
      const history = historyEvents.slice(0, eventIndex)
      assert.ok(history.filter(event => event.command === 'fetch' && event.url.endsWith('update-control.json')).length >= 2)
    }
  }
})

test('candidate assets-only publication cannot create either fixed or versioned metadata', context => {
  const setup = fixture(context, '3.32.0')
  setup.state.release.prerelease = true
  setup.state.control.stable.version = '3.31.0'
  const result = setup.run(['--assets-only', '--version', '3.32.0'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /候选资产上传完成/)
  assert.equal(setup.writes().length, 5)
  assert.ok(setup.writes().every(event => event.args[1] === 'put-object' && event.args.includes('--forbid-overwrite') && !event.args.some(arg => arg.endsWith('.json'))))
  assert.equal(existsSync(setup.object('latest.json')), false)
  assert.equal(existsSync(setup.object('release-catalog.json')), false)
})

test('a successful retry reuses identical objects without uploading them again', context => {
  const setup = fixture(context)
  assert.equal(setup.run().status, 0)
  const count = setup.writes().length
  const result = setup.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(setup.writes().length, count)
})

test('a failed command that already stored exact immutable bytes is safely resumed', context => {
  const setup = fixture(context)
  setup.state.failAfterWrite = 'tianshu/v3.31.0/' + setup.catalog.artifacts[0].fileName
  const result = setup.run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(setup.object('release-catalog.json')), setup.catalogBytes)
})

const rejection = {
  candidate: /controlled stable/,
  'catalog pin': /Controlled catalog bytes are immutable/,
  'local pin': /UPDATE_POLICY_ROLLBACK|UPDATE_POLICY_CATALOG_CHANGED/,
  'split policy': /Controlled catalog bytes are immutable|UPDATE_POLICY_CONFLICT/,
  'missing policy': /initialized live update control/,
  offline: /validation or I\/O failed/,
  signature: /Original updater signature differs/,
  'missing signature': /missing a required package or signature/,
  'package digest': /authoritative GitHub SHA-256/,
  'unqualified source': /authoritative GitHub qualification/,
  'missing platform': /exactly all catalog update platforms/,
  'extra platform': /exactly all catalog update platforms/,
  draft: /published, not draft/,
  prerelease: /Prerelease metadata/,
  'immutable package': /immutable bytes cannot be replaced/,
  'immutable catalog': /immutable bytes cannot be replaced/,
  'fixed catalog': /immutable bytes cannot be replaced/,
  'versioned bucket': /versioning never enabled/,
}

for (const defect of Object.keys(rejection)) {
  test('fails closed before all uploads: ' + defect, context => {
    const setup = fixture(context), artifact = setup.catalog.artifacts[0]
    if (defect === 'candidate') setup.state.control.stable.version = '3.30.0'
    if (defect === 'catalog pin') setup.state.control.stable.catalogSha256 = '0'.repeat(64)
    if (defect === 'local pin') writeFileSync(join(setup.home, 'workspace/update-control.json'), JSON.stringify({...setup.state.control, revision: 4, stable: {...setup.state.control.stable, catalogSha256: '0'.repeat(64)}}))
    if (defect === 'split policy') setup.state.secondControl = {...setup.state.control, stable: {...setup.state.control.stable, catalogSha256: '0'.repeat(64)}}
    if (defect === 'missing policy') setup.state.missingControl = true
    if (defect === 'offline') setup.state.networkFailure = true
    if (defect === 'signature') writeFileSync(join(setup.home, 'github', artifact.fileName + '.sig'), 'wrong public signature')
    if (defect === 'missing signature') setup.state.release.assets = setup.state.release.assets.filter(asset => asset.name !== artifact.fileName + '.sig')
    if (defect === 'package digest') writeFileSync(join(setup.home, 'github', artifact.fileName), 'wrong package')
    if (defect === 'unqualified source') setup.catalog.artifacts.forEach(asset => {asset.sources.github.verified = false})
    if (defect === 'missing platform') delete setup.manifest.platforms['darwin-aarch64']
    if (defect === 'extra platform') setup.manifest.platforms['darwin-x86_64'] = setup.manifest.platforms['darwin-aarch64']
    if (defect === 'draft') setup.state.release.draft = true
    if (defect === 'prerelease') setup.state.release.prerelease = true
    if (defect === 'immutable package') setup.put('v3.31.0/' + artifact.fileName, 'different package')
    if (defect === 'immutable catalog') setup.put('v3.31.0/release-catalog.json', Buffer.concat([setup.catalogBytes, Buffer.from('\n')]))
    if (defect === 'fixed catalog') setup.put('release-catalog.json', Buffer.concat([setup.catalogBytes, Buffer.from('\n')]))
    if (defect === 'versioned bucket') setup.state.versioning = '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'
    if (['unqualified source', 'missing platform', 'extra platform'].includes(defect)) {
      const name = defect === 'unqualified source' ? 'release-catalog.json' : 'latest.json'
      const bytes = Buffer.from(JSON.stringify(defect === 'unqualified source' ? setup.catalog : setup.manifest))
      writeFileSync(join(setup.home, 'github', name), bytes)
      writeFileSync(join(setup.home, 'workspace', name), bytes)
      const remote = setup.state.release.assets.find(asset => asset.name === name)
      remote.size = bytes.length; remote.digest = 'sha256:' + hash(bytes)
      if (name === 'release-catalog.json') {
        setup.state.control.stable.catalogSha256 = hash(bytes)
        writeFileSync(join(setup.home, 'workspace', 'update-control.json'), JSON.stringify(setup.state.control))
      }
    }
    const result = setup.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, rejection[defect])
    assert.doesNotMatch(result.stdout + result.stderr, /Controlled offline probe/)
    assert.equal(setup.writes().length, 0, result.stderr)
  })
}

test('control changes after package uploads block every stable metadata write', context => {
  const setup = fixture(context)
  setup.state.flipControlAfterAsset = true
  const result = setup.run()
  assert.notEqual(result.status, 0)
  assert.ok(setup.writes().length > 0)
  assert.ok(setup.writes().every(event => event.args[1] === 'put-object' && !event.args.some(arg => arg.endsWith('.json'))))
  assert.equal(existsSync(setup.object('latest.json')), false)
})

test('a fixed catalog changed after package uploads blocks all subsequent metadata', context => {
  const setup = fixture(context)
  setup.state.corruptFixedCatalogAfterAsset = true
  const result = setup.run()
  assert.notEqual(result.status, 0)
  assert.ok(setup.writes().length > 0)
  assert.ok(setup.writes().every(event => event.args[1] === 'put-object' && !event.args.some(arg => arg.endsWith('.json'))))
  assert.equal(readFileSync(setup.object('release-catalog.json'), 'utf8'), 'Conflicting fixed catalog')
  assert.equal(existsSync(setup.object('latest.json')), false)
})

test('partial fixed metadata publication resumes without replacing immutable assets', context => {
  const setup = fixture(context)
  setup.state.failAfterWrite = 'tianshu/release-catalog.json'
  const first = setup.run()
  assert.notEqual(first.status, 0)
  assert.deepEqual(readFileSync(setup.object('release-catalog.json')), setup.catalogBytes)
  const count = setup.writes().filter(event => event.args[1] === 'put-object').length
  setup.state.failAfterWrite = undefined
  const result = setup.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(setup.writes().filter(event => event.args[1] === 'put-object').length, count)
  assert.equal(JSON.parse(readFileSync(setup.object('latest.json'))).version, '3.31.0')
})

test('published GitHub legacy manifest is rewritten without changing pinned catalog bytes', context => {
  const setup = fixture(context)
  setup.put('release-catalog.json', setup.catalogBytes)
  setup.put('latest.json', readFileSync(join(setup.home, 'github/latest.json')))
  const result = setup.run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(setup.object('release-catalog.json')), setup.catalogBytes)
  assert.ok(Object.values(JSON.parse(readFileSync(setup.object('latest.json'))).platforms).every(entry => entry.url.startsWith(oss)))
})

test('403 is not mistaken for object absence', context => {
  const setup = fixture(context)
  setup.state.probeStatus = {['tianshu/v3.31.0/' + setup.catalog.artifacts[0].fileName]: 403}
  const result = setup.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /HTTP 403/)
  assert.equal(setup.writes().length, 0)
})

test('oversized policy metadata stops before any upload', context => {
  const setup = fixture(context)
  setup.state.controlBody = ' '.repeat(256 * 1024 + 1)
  const result = setup.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Metadata exceeds 256 KiB/)
  assert.equal(setup.writes().length, 0)
})

test('external command diagnostics never escape to the console', context => {
  const setup = fixture(context)
  setup.state.ghFailure = true
  const result = setup.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GitHub release inspection failed; command output withheld/)
  assert.doesNotMatch(result.stdout + result.stderr, /Untrusted diagnostic sentinel/)
  assert.equal(setup.writes().length, 0)
})

test('a sensitive file option is refused before reading it or invoking external tools', context => {
  const setup = fixture(context), result = setup.run(['--catalog', '.env'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Only public JSON metadata/)
  assert.equal(setup.events().length, 0)
})

test('a competing immutable upload cannot be replaced', context => {
  const setup = fixture(context)
  setup.state.raceKey = 'tianshu/v3.31.0/' + setup.catalog.artifacts[0].fileName
  setup.state.raceBytes = 'Competing package bytes'
  const result = setup.run(['--assets-only'])
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(setup.object('v3.31.0/' + setup.catalog.artifacts[0].fileName), 'utf8'), setup.state.raceBytes)
  assert.equal(existsSync(setup.object('latest.json')), false)
})

test('environment dry run and local asset acquisition preserve source files', context => {
  const setup = fixture(context)
  for (const name of readdirSync(join(setup.home, 'github'))) if (name.startsWith('Tianshu_')) writeFileSync(join(setup.home, 'local-assets', name), readFileSync(join(setup.home, 'github', name)))
  const result = setup.run([], {DRY_RUN: '1', OSS_ASSET_DIR: join(setup.home, 'local-assets')})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(setup.writes().length, 0)
  assert.ok(setup.events().filter(event => event.command === 'gh' && event.args[1] === 'download').every(event => !event.args.some(arg => arg.startsWith('Tianshu_'))))
})

test('unexpected options fail without accessing the network or publisher', context => {
  const setup = fixture(context), result = setup.run(['--skip-signatures'])
  assert.notEqual(result.status, 0)
  assert.equal(setup.events().length, 0)
})

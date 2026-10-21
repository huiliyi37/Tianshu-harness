import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

// Physical mutation targets in an isolated mirror; never rewrite the shared checkout.
const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'wire-normalization-defects-'))
const mirror = join(temporary, 'repo')
const api = 'src/api/__tests__/wire-normalization.test.ts'
const integration = 'src/agent/__tests__/wire-normalization-continuity.test.ts'
const diagnostic = 'src/agent/__tests__/stream-abort-diagnostics.test.ts'
const desktop = 'desktop/src/runtime/__tests__/continuity-diagnostics.test.ts'
const cases = [
  ['historical-sanitize-skip', 'src/api/openai-client.ts', 'messages: prepared.messages,',
    'messages: this.mainPrefixProof ? this.mapWireMessages(request.messages, { toolsPresent: !!request.tools?.length, suppressStickyPreserve: reentrantDispatch }) : prepared.messages,', [integration]],
  ['system-suffix-missing', 'src/api/openai-client.ts', "if (system && typeof system.content === 'string') mapped[index] = { ...system, content: system.content + this.systemSuffix }", '', [api]],
  ['retry-tail-not-normalized', 'src/api/openai-client.ts', 'if (effectiveBody.messages !== body.messages) {\n        const normalized = normalizeWireMessages', 'if (false) {\n        const normalized = normalizeWireMessages', [api]],
  ['preserved-reasoning-lost-on-later-retry', 'src/api/openai-client.ts', 'if (preserveReasoningRequested && sourceMessages) {', 'if (preserveReasoningRequested && !preserveReasoningApplied && sourceMessages) {', [api]],
  ['copy-on-write-removed', 'src/utils/sanitize.ts', "if (typeof value === 'string') return sanitizeForJsonTransport(value) as T", "if (typeof value === 'string') return sanitizeForJsonTransport(value) as T\n  if (Array.isArray(value)) return value.map(sanitizeMessageContent) as T\n  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeMessageContent(child)])) as T", [api]],
  ['transport-evidence-disconnected', 'src/api/execution-continuity.ts', 'error.continuityEvidence = { ...history, normalization: scope.normalization, ...(stage ? { stage } : {}), ...error.continuityEvidence }', '', [diagnostic]],
  ['transform-version-disconnected', 'src/api/execution-continuity.ts', 'if (wireTransformVersion) next.wireTransformVersion = wireTransformVersion', '', [api]],
  ['silent-legacy-rebase', 'src/api/execution-continuity.ts', "const stableProjection = request.continuityEvidence?.sourcePrefix === 'same' && request.continuityEvidence.renderPrefix === 'same'", 'const stableProjection = false', [integration]],
  ['desktop-diagnostics-disconnected', 'desktop/src/state/event-reducer.ts', 'continuity: parseContinuityDiagnostics(ev.data.continuity),', '', [desktop]],
]
const copies = new Set([...cases.map(([, file]) => file), api, integration, diagnostic, desktop,
  'src/agent/__tests__/continuity-projection-fixture.ts'])
function linkTree(source, target, relative) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const path = join(source, entry.name), dest = join(target, entry.name), rel = `${relative}/${entry.name}`
    if (entry.isDirectory()) linkTree(path, dest, rel)
    else if (copies.has(rel)) copyFileSync(path, dest)
    else symlinkSync(path, dest)
  }
}
linkTree(join(root, 'src'), join(mirror, 'src'), 'src')
linkTree(join(root, 'desktop', 'src'), join(mirror, 'desktop', 'src'), 'desktop/src')
for (const name of ['package.json', 'tsconfig.json', 'node_modules', 'runtime-assets', 'docs', 'scripts']) symlinkSync(join(root, name), join(mirror, name))
for (const name of ['package.json', 'tsconfig.json', 'node_modules']) if (existsSync(join(root, 'desktop', name))) symlinkSync(join(root, 'desktop', name), join(mirror, 'desktop', name))
function run(name, files) {
  const result = spawnSync('rtk', ['proxy', process.execPath, '--preserve-symlinks', '--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
    cwd: mirror, encoding: 'utf8', timeout: 60_000, maxBuffer: 8_000_000, windowsHide: true,
    env: { ...process.env, RIVET_HOME: join(temporary, `home-${name}`), RIVET_SESSION_DIR: join(temporary, `sessions-${name}`), RIVET_TEST: '1' },
  })
  writeFileSync(join(temporary, `${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  return result
}
if (run('baseline', [api, integration, diagnostic, desktop]).status !== 0) throw new Error(`Mirror baseline failed: ${temporary}/baseline.log`)
console.log('mirror baseline: green')
const results = []
for (const [name, path, before, after, tests] of cases) {
  const file = join(mirror, path), source = readFileSync(file, 'utf8')
  if (!source.includes(before)) throw new Error(`Mutation anchor missing: ${name}`)
  try {
    writeFileSync(file, source.replace(before, after))
    const result = run(name, tests)
    const killed = result.status !== 0 && !result.error && /ERR_ASSERTION|AssertionError/.test(result.stdout ?? '')
    results.push({ name, killed, exitCode: result.status })
    console.log(`${name}: ${killed ? 'red as expected' : 'INVALID / SURVIVED'}`)
    if (!killed) throw new Error(`Expected assertion failure: ${temporary}/${name}.log`)
  } finally { writeFileSync(file, source) }
}
writeFileSync(join(temporary, 'results.json'), JSON.stringify({ baseline: 'green', results }, null, 2))
console.log(`Evidence: ${temporary}/results.json`)

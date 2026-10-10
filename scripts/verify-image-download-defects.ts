import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const output = await mkdtemp(join(tmpdir(), 'image-download-defects-'))
await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(output, 'node_modules'), 'dir')
await writeFile(join(output, 'package.json'), JSON.stringify({ type: 'module' }))
async function moduleCopy(relative: string, name: string, transform: (source: string) => string) {
  const source = new URL(relative, import.meta.url), original = await readFile(source, 'utf8')
  const anchored = transform(original).replace(/from (['"])(\.[^'"]+)\1/g, (_all, quote: string, specifier: string) => `from ${quote}${new URL(specifier.replace(/\.js$/, '.ts'), source).href}${quote}`)
  const target = join(output, `${name}.ts`)
  await writeFile(target, anchored)
  return pathToFileURL(target).href
}
const testPath = fileURLToPath(new URL('../src/api/__tests__/image-gen-network.test.ts', import.meta.url))
for (const defect of ['baseline', 'plain-fetch-download', 'generic-fetch-error', 'cancel-not-reaching-body']) {
  let guardedModule: string | undefined
  if (defect === 'cancel-not-reaching-body') guardedModule = await moduleCopy('../src/tools/net/http-fetch.ts', `${defect}-guarded`, source => source.replace('signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal', 'signal: controller.signal').replace('readBody(response, maxBytes, timeoutMs, opts.signal)', 'readBody(response, maxBytes, timeoutMs)'))
  const module = await moduleCopy('../src/api/image-gen-client.ts', defect, source => {
    if (defect === 'plain-fetch-download') {
      const start = source.indexOf('    const download = await httpFetchGuarded('), end = source.indexOf('    if (download.status', start)
      assert.ok(start > 0 && end > start)
      return source.slice(0, start) + "    const download = await withTimeout(fetchImpl, ref.value, { method: 'GET' }, timeoutMs, async response => ({ status: response.status, finalUrl: ref.value, bytes: new Uint8Array(await response.arrayBuffer()) }), options.signal)\n" + source.slice(end)
    }
    if (defect === 'generic-fetch-error') return source.replace('throw describeNetworkError(error, ref.value, !options.fetchImpl && !!resolveProxyForUrl(ref.value, options.proxy))', 'throw error')
    if (guardedModule) return source.replace("'../tools/net/http-fetch.js'", `'${guardedModule}'`)
    return source
  })
  const name = defect === 'generic-fetch-error' ? 'network errors retain nested' : defect === 'cancel-not-reaching-body' ? 'cancel interrupts a real proxy download body' : 'real configured proxy handles'
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern', name, testPath], { env: { ...process.env, RIVET_IMAGE_NETWORK_TEST_MODULE: module }, encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.ifError(run.error)
  assert.equal(run.signal, null)
  await writeFile(join(output, `${defect}.log`), run.stdout + run.stderr)
  if (defect === 'baseline') assert.equal(run.status, 0, run.stdout + run.stderr)
  else { assert.equal(run.status, 1, run.stdout + run.stderr); assert.match(run.stdout + run.stderr, /AssertionError|Image network request failed/) }
  console.log(`${defect}: ${defect === 'baseline' ? 'passes' : 'restored defect correctly fails'}`)
}
console.log(`Mutation evidence: ${output}`)

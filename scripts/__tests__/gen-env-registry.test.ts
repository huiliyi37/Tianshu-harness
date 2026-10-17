import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const loader = pathToFileURL(require.resolve('tsx')).href
const generator = fileURLToPath(new URL('../gen-env-registry.ts', import.meta.url))
const contract = fileURLToPath(new URL('../../src/config/env-registry-types.ts', import.meta.url))

test('registry generation retains its shared type boundary, descriptions and repeatable data', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-registry-generator-'))
  // Construct the fixture name so source-corpus audits do not mistake it for a real setting.
  const name = ['RIVET', 'GENERATOR', 'FIXTURE'].join('_')
  const output = join(root, 'src', 'config', 'env-registry.ts')
  try {
    mkdirSync(join(root, 'src', 'config'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(root, 'src', 'feature.ts'), `export const value = process.env.${name} ?? 'fixture-default'\n`)
    writeFileSync(join(root, 'src', 'config', 'env-registry-types.ts'), readFileSync(contract))
    writeFileSync(output, `export const ENV_REGISTRY = [{ name: '${name}', description: 'keep this operator note' }]\n`)
    const generate = () => {
      const run = spawnSync(process.execPath, ['--import', loader, generator], {
        cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      })
      assert.equal(run.status, 0, run.stdout + run.stderr)
      return readFileSync(output, 'utf8')
    }
    const first = generate()
    assert.match(first, /import type \{ EnvRegistryEntry \} from '\.\/env-registry-types\.js'/)
    assert.match(first, /export type \{ EnvRegistryEntry \} from '\.\/env-registry-types\.js'/)
    assert.doesNotMatch(first, /export interface EnvRegistryEntry/)
    assert.match(first, /description: 'keep this operator note'/)
    assert.match(first, /files: \['feature\.ts'\]/)
    const normalizeTime = (text: string) => text.replace(/自动生成于 [^，]+/u, '自动生成于 FIXED')
    assert.equal(normalizeTime(generate()), normalizeTime(first))
    const checked = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
      '--noEmit', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--target', 'ES2022', '--lib', 'ES2022', output], {
      cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    })
    assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

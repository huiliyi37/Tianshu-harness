import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '..')
const isolated = await mkdtemp(path.join(tmpdir(), 'tianshu-routing-defects-'))
const runtimePath = path.join(root, 'src/agent/worker-runtime.ts')
const policyPath = path.join(root, 'src/agent/worker-model-policy.ts')
const testPath = path.join(root, 'src/agent/__tests__/worker-model-policy.test.ts')
const absolutize = (source, filename) => source.replace(/from (['"])(\.[^'"]+)\1/g, (_match, quote, ref) => `from ${quote}${path.resolve(path.dirname(filename), ref)}${quote}`)
try {
  const runtime = await readFile(runtimePath, 'utf8'), policy = await readFile(policyPath, 'utf8'), test = await readFile(testPath, 'utf8')
  for (const defect of ['inherit-deletes-override', 'credentials-continue-recommendation', 'keyless-treated-as-missing-key']) {
    const policyCopy = path.join(isolated, 'policy.ts'), runtimeCopy = path.join(isolated, 'runtime.ts'), testCopy = path.join(isolated, 'policy.test.ts')
    let mutatedPolicy = policy, mutatedRuntime = runtime
    if (defect === 'inherit-deletes-override') {
      const anchor = "if (role) return { target: role, source: 'role' }"
      assert.ok(policy.includes(anchor))
      mutatedPolicy = policy.replace(anchor, "if (role && !('strategy' in role)) return { target: role, source: 'role' }")
    } else if (defect === 'credentials-continue-recommendation') {
      const anchor = 'binding = resolveModelBinding(deps.config.provider.providers, root)'
      assert.ok(runtime.includes(anchor))
      mutatedRuntime = runtime.replace(anchor, "binding = resolveModelBinding(deps.config.provider.providers, { provider: root.provider, model: deps.provider.models[0]!.id })")
    }
    if (defect === 'keyless-treated-as-missing-key') {
      const anchor = 'binding = resolveModelBinding(deps.config.provider.providers, policy.target)'
      assert.ok(runtime.includes(anchor))
      mutatedRuntime = runtime.replace(anchor, anchor + `; if (!binding.apiKey && !binding.auth) throw new ModelBindingUnavailable('missing_credentials')`)
    }
    await writeFile(policyCopy, absolutize(mutatedPolicy, policyPath))
    await writeFile(runtimeCopy, absolutize(mutatedRuntime, runtimePath).replace(path.join(root, 'src/agent/worker-model-policy.js'), policyCopy))
    await writeFile(testCopy, absolutize(test, testPath).replace(path.join(root, 'src/agent/worker-runtime.js'), runtimeCopy).replace(path.join(root, 'src/agent/worker-model-policy.js'), policyCopy))
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', testCopy], { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true })
    const log = result.stdout + result.stderr
    assert.notEqual(result.status, 0, `${defect} must fail`)
    assert.match(log, /AssertionError/, 'must fail a behavioral assertion, not an import or fixture error')
    assert.match(log, defect === 'inherit-deletes-override' ? /explicit follow bypasses fixed task routes/ : defect === 'keyless-treated-as-missing-key' ? /fixed keyless endpoint is an actual client binding/ : /invalid explicit targets terminate selection/)
    console.log(`${defect}: restored defect is red`)
  }
} finally { await rm(isolated, { recursive: true, force: true }) }

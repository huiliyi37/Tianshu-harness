import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { TestRunner } from './test-runner-options.js'
import { canonicalTestPath, testWorkspace } from './test-workspaces.js'

/** Yarn PnP resolution runs in a child: never install its loader in the agent. */
export function resolveTestModule(cwd: string, name: string): string | undefined {
  cwd = canonicalTestPath(cwd)
  const pnp = join(testWorkspace(cwd).root, '.pnp.cjs')
  if (!existsSync(pnp)) { try { return createRequire(join(cwd, 'package.json')).resolve(name) } catch { return undefined } }
  try {
    return execFileSync(process.execPath, ['--require', pnp, '-p', `require('node:module').createRequire(${JSON.stringify(join(cwd, 'package.json'))}).resolve(${JSON.stringify(name)})`],
      { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch { return undefined }
}
export function readTestPackageFile(cwd: string, file: string): string {
  cwd = canonicalTestPath(cwd)
  try { return readFileSync(file, 'utf8') } catch {
    const pnp = join(testWorkspace(cwd).root, '.pnp.cjs')
    if (!existsSync(pnp)) throw new Error('package metadata unavailable')
    return execFileSync(process.execPath, ['--require', pnp, '-e', `require('node:fs').writeSync(1, require('node:fs').readFileSync(${JSON.stringify(file)},'utf8'))`],
      { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  }
}
/** Resolve transitive runner dependencies from the runner issuer, including strict PnP maps. */
export function resolveRunnerDependency(cwd: string, issuer: string, name: string): string | undefined {
  cwd = canonicalTestPath(cwd)
  const pnp = join(testWorkspace(cwd).root, '.pnp.cjs')
  if (!existsSync(pnp)) { try { return createRequire(issuer).resolve(name) } catch { return undefined } }
  try { return execFileSync(process.execPath, ['--require', pnp, '-p', `require('node:module').createRequire(${JSON.stringify(issuer)}).resolve(${JSON.stringify(name)})`],
    { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() } catch { return undefined }
}
export function installedTestRunner(cwd: string, runner: TestRunner): { entry: string; version: string; packageFile?: string; reason?: string } {
  if (runner === 'node-test') return { entry: process.execPath, version: process.versions.node }
  const packageFile = resolveTestModule(cwd, runner + '/package.json')
  if (!packageFile) return { entry: '', version: '', reason: `项目未安装 ${runner}；不会自动下载，请先按项目约定安装依赖。` }
  try {
    const pkg = JSON.parse(readTestPackageFile(cwd, packageFile)) as { version: string; bin?: string | Record<string, string> }
    const major = Number(pkg.version.split('.')[0])
    const supported = runner === 'vitest' ? major >= 2 && major <= 5 : major === 29 || major === 30
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[runner]
    if (!bin || !supported) return { entry: '', version: pkg.version, packageFile, reason: `${runner} ${pkg.version} 尚无经过适配的完成证明。` }
    return { entry: resolve(dirname(packageFile), bin), version: pkg.version, packageFile }
  } catch { return { entry: '', version: '', packageFile, reason: `无法读取 ${runner} 的安装信息。` } }
}

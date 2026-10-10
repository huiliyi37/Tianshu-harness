import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

for (const prewarm of [false, true]) test(`an unusable pwsh executable falls back to Windows PowerShell (${prewarm ? 'prewarmed' : 'cold'})`, {
  skip: process.platform !== 'win32' && 'requires Windows executable probing',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-unusable-pwsh-'))
  try {
    writeFileSync(join(dir, 'pwsh.exe'), '')
    const module = pathToFileURL(resolve('src/platform.ts')).href
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { getShellCommand, prewarmShellProbes } from ${JSON.stringify(module)}; ${prewarm ? 'await prewarmShellProbes();' : ''} console.log(JSON.stringify(getShellCommand()))`,
    ], {
      env: { ...process.env, RIVET_USE_POWERSHELL: '1', PATH: `${dir};${process.env.PATH ?? ''}` },
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(JSON.parse(child.stdout).cmd, 'powershell.exe')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

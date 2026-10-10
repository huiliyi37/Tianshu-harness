import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { makeApp } from './_harness.js'

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('Tab completion stays responsive and late git results belong to their input request', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rivet-tab-async-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  execFileSync(git, ['init', '-q'], { cwd: root, timeout: 30_000 })
  writeFileSync(join(root, 'src.ts'), '')
  writeFileSync(join(root, 'src-test.ts'), '')
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 0.65\nexec '${git.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 })
  const oldPath = process.env.PATH
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL
  process.env.PATH = `${bin}:${oldPath ?? ''}`
  process.env.GIT_CONFIG_GLOBAL = join(root, 'absent-config')
  t.after(() => {
    process.env.PATH = oldPath
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal
    rmSync(root, { recursive: true, force: true })
  })
  const create = () => {
    const h = makeApp()
    h.app.setCwd(root)
    h.app.setInput('@src')
    return h
  }
  const inputValue = (app: unknown): string => (app as any).inputLine.value

  await t.test('real Tab returns immediately, receives delayed candidates and cycles them', async () => {
    const { app, stdin } = create()
    try {
      const start = performance.now()
      stdin.dataHandler!('\t')
      assert.ok(performance.now() - start < 300, 'Tab callback must not await git synchronously')
      for (let i = 0; i < 150 && inputValue(app) === '@src'; i++) await pause(20)
      assert.equal(inputValue(app), '@file:src.ts ')
      stdin.dataHandler!('\t')
      assert.equal(inputValue(app), '@file:src-test.ts ')
    } finally { app.dispose() }
  })

  for (const action of ['cwd', 'setInput'] as const) {
    await t.test(`completed candidate cycles cannot survive ${action}`, async () => {
      const { app, stdin } = create()
      try {
        stdin.dataHandler!('\t')
        for (let i = 0; i < 150 && inputValue(app) === '@src'; i++) await pause(20)
        assert.equal(inputValue(app), '@file:src.ts ')
        if (action === 'cwd') app.setCwd(bin)
        else app.setInput('replacement draft')
        const expected = inputValue(app)
        stdin.dataHandler!('\t')
        assert.equal(inputValue(app), expected, 'Tab must not reuse candidates belonging to the previous input or directory')
      } finally { app.dispose() }
    })
  }

  for (const action of ['edit', 'paste', 'cursor', 'cwd', 'dispose', 'replace-same-input'] as const) {
    await t.test(`late candidates do not overwrite after ${action}`, async () => {
      const { app, stdin, out } = create()
      try {
        stdin.dataHandler!('\t')
        if (action === 'edit') stdin.dataHandler!('x')
        if (action === 'paste') stdin.dataHandler!('\x1B[200~after\x1B[201~')
        if (action === 'cursor') stdin.dataHandler!('\x1B[D')
        if (action === 'cwd') app.setCwd(bin)
        if (action === 'dispose') app.dispose()
        if (action === 'replace-same-input') app.setInput('@src')
        const expected = inputValue(app)
        out.clear()
        await pause(800)
        assert.equal(inputValue(app), expected)
        if (action === 'dispose') assert.equal(out.chunks.length, 0, 'disposed TUI cannot redraw')
      } finally { app.dispose() }
    })
  }
})

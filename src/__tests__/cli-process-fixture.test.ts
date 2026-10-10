import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { cliFixtureEnv, cliProcessArgs } from './cli-process-fixture.js'

for (const built of [true, false]) {
  test(`CLI fixture executes ${built ? 'the built release' : 'the unbuilt TypeScript fallback'} from a neutral cwd`, () => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-cli-entry-'))
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'main.ts'), "const label: string = 'source'; console.log(label, process.argv.at(-1))")
      if (built) {
        mkdirSync(join(root, 'dist'))
        writeFileSync(join(root, 'dist', 'main.js'), "console.log('built', process.argv.at(-1))")
      }
      const result = spawnSync(process.execPath, cliProcessArgs(root, ['fixture-arg']), {
        cwd: root, env: cliFixtureEnv(root), encoding: 'utf8', timeout: 5000,
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), `${built ? 'built' : 'source'} fixture-arg`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

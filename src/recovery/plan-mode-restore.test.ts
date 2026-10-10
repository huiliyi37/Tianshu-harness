import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import type { Interface } from 'node:readline/promises'
import type { BootstrapContext } from '../bootstrap.js'
import { SessionPersist } from '../agent/session-persist.js'
import { checkPlanMode } from '../agent/plan-mode.js'
import { runRecoveryCli } from '../recovery-cli.js'

for (const variant of ['existing', 'windows-path', 'missing', 'off'] as const) {
  it(`restores the persisted planning write guard before accepting input: ${variant}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'recovery-planning-'))
    const relative = '.rivet/plans/draft-review.md'
    await mkdir(join(cwd, '.rivet/plans'), { recursive: true })
    if (variant !== 'missing') await writeFile(join(cwd, relative), '# Draft\n')
    const persist = new SessionPersist(`planning-${variant}`, cwd)
    persist.updateMetadata({ planModeState: variant === 'off' ? 'off' : 'planning', activePlanFilePath: variant === 'windows-path' ? relative.replaceAll('/', '\\') : relative })
    await persist.flushSessionBuffer()
    let state: 'off' | 'planning' = 'off'
    let active: string | undefined
    let writeAllowed: boolean | undefined
    let draftAllowed: boolean | undefined
    const ctx = { cwd, persist, agent: {
      enterPlanMode(options: { planFilePath?: string }) { state = 'planning'; active = options.planFilePath },
      async run() {
        writeAllowed = checkPlanMode(state, 'write_file', { cwd, targetFilePath: 'src/change.ts', activePlanFilePath: active }).allowed
        draftAllowed = checkPlanMode(state, 'write_file', { cwd, targetFilePath: relative, activePlanFilePath: active }).allowed
      },
    } } as unknown as BootstrapContext
    const lines = ['continue review', '/exit']
    const rl = { question: async () => lines.shift() ?? '/exit', close() {} } as unknown as Interface
    const output = new Writable({ write(_chunk, _encoding, done) { done() } })
    try {
      await runRecoveryCli(ctx, { rl, output })
      const restored = variant === 'existing' || variant === 'windows-path'
      assert.equal(writeAllowed, !restored, 'a resumed draft must keep ordinary source writes blocked')
      assert.equal(draftAllowed, true, 'the restored draft remains editable')
      assert.equal(active, restored ? relative : undefined)
    } finally {
      await persist.flushSessionBuffer()
      await rm(cwd, { recursive: true, force: true })
    }
  })
}

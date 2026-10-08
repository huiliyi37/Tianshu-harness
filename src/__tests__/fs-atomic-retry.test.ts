import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicAsync, writeFileAtomicDurableAsync } from '../fs-atomic.js'

for (const [name, write] of [['async', writeFileAtomicAsync], ['durable', writeFileAtomicDurableAsync]] as const) {
  for (const fault of ['transient', 'exhausted', 'permanent', 'non-windows'] as const) {
    test(`${name}: ${fault} rename keeps canonical bytes intact until complete publication`, async () => {
      const root = fs.mkdtempSync(join(tmpdir(), 'atomic-retry-')), path = join(root, 'state.json')
      fs.writeFileSync(path, 'old complete value')
      const original = promises.rename, platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      let attempts = 0
      Object.defineProperty(process, 'platform', { value: fault === 'non-windows' ? 'linux' : 'win32' })
      promises.rename = async (source, target) => {
        if (target === path) {
          attempts++
          if (fault !== 'transient' || attempts <= 2) {
            assert.equal(fs.readFileSync(path, 'utf8'), 'old complete value')
            throw Object.assign(new Error('synthetic publication refusal'), { code: fault === 'permanent' ? 'EROFS' : 'EPERM' })
          }
        }
        return original(source, target)
      }
      syncBuiltinESMExports()
      try {
        if (fault === 'transient') {
          await write(path, 'new complete value')
          assert.equal(fs.readFileSync(path, 'utf8'), 'new complete value')
        } else {
          await assert.rejects(write(path, 'new complete value'), { code: fault === 'permanent' ? 'EROFS' : 'EPERM' })
          assert.equal(fs.readFileSync(path, 'utf8'), 'old complete value')
          if (fault === 'exhausted') assert.ok(attempts > 1 && attempts <= 4, 'retry is finite')
          else assert.equal(attempts, 1, 'permanent and POSIX errors reject immediately')
        }
        assert.equal(fs.readdirSync(root).filter(file => !file.startsWith('._') && file.endsWith('.tmp')).length, 0)
      } finally {
        Object.defineProperty(process, 'platform', platform)
        promises.rename = original; syncBuiltinESMExports()
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }
}

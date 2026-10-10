import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { verificationArgv, classifyVerificationCommand, shellWord } from '../verification-command.js'

const loader = pathToFileURL(join(tmpdir(), '中文 空格 %25', 'loader.mjs')).href

test('literal quoted file URL imports retain encoded argv and complete Node targets', () => {
  const command = `node --import ${shellWord(loader)} --test ${shellWord('src/空 格.test.ts')}`
  assert.deepEqual(verificationArgv(command), ['node', '--import', loader, '--test', 'src/空 格.test.ts'])
  const parsed = classifyVerificationCommand(command)
  assert.equal(parsed.nodeTest, true)
  assert.deepEqual(parsed.targets, ['src/空 格.test.ts'])
})

for (const command of [
  `node --import ${loader} --test a.test.ts`,
  `node --import "${loader}" --test a.test.ts`,
  "node --import 'file:///fixture/%ZZ/loader.mjs' --test a.test.ts",
  "node --import 'file:///fixture/%FF/loader.mjs' --test a.test.ts",
  "node --import 'file:///fixture/%2F/loader.mjs' --test a.test.ts",
  "node --import 'file:///fixture/%VAR%/loader.mjs' --test a.test.ts",
  "node --import 'https://example.com/%20/loader.mjs' --test a.test.ts",
  "node --import 'file:///fixture/$VAR/loader.mjs' --test a.test.ts",
  "node --test 'src/100%25.test.ts'",
  "node --import 'file:///fixture/loader.mjs?%VAR%' --test a.test.ts",
  "node --import 'file:///fixture/loader.mjs#%ZZ' --test a.test.ts",
  "echo '%PATH%'",
]) {
  test(`percent expansion and invalid import URL remain blocked: ${command}`, () => {
    assert.equal(verificationArgv(command), null)
  })
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hostname, platform } from 'node:os'
import ts from 'typescript'
import { requestDeviceCode } from '../account.js'
import type { nativeDeviceMetadata } from '../device-metadata.js'

function fixture(system: string, name: string | Error): typeof nativeDeviceMetadata {
  const source = readFileSync(new URL('../device-metadata.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { nativeDeviceMetadata?: typeof nativeDeviceMetadata } = {}
  new Function('require', 'exports', compiled)((id: string) => {
    assert.equal(id, 'node:os')
    return { platform: () => system, hostname: () => { if (name instanceof Error) throw name; return name } }
  }, exports)
  return exports.nativeDeviceMetadata!
}

for (const [system, expected] of [['win32', 'windows'], ['darwin', 'macos'], ['linux', 'linux']]) {
  test(`native login metadata preserves ${system} instead of guessing from the browser`, () => {
    assert.deepEqual(fixture(system!, '天枢工作站')(undefined, 'desktop'), { deviceName: '天枢工作站', platform: expected, clientKind: 'desktop' })
  })
}

test('native metadata cleans controls and bounds Unicode names without splitting code points', () => {
  const metadata = fixture('darwin', 'Fallback')
  assert.equal(metadata('  工作站\u0000\n  ').deviceName, '工作站')
  assert.equal(Array.from(metadata('😀'.repeat(140)).deviceName!).length, 128)
  assert.deepEqual(fixture('other', new Error('unavailable'))(), { deviceName: null, platform: 'unknown', clientKind: 'cli' })
})

test('the actual device-create request sends OS, native hostname, purpose and fingerprint together', async () => {
  let payload: Record<string, unknown> | undefined
  await requestDeviceCode({ deviceFingerprint: 'fixture-device', clientKind: 'desktop', tuiVersion: '4.0', fetchImpl: async (_url, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ deviceCode: 'fixture', userCode: '123456', expiresIn: 300, pollInterval: 5, verifyUrl: 'https://fixture.invalid/authorize' })
  } })
  assert.deepEqual(payload, { tuiVersion: '4.0', deviceName: hostname(), platform: ({ win32: 'windows', darwin: 'macos', linux: 'linux' } as Record<string, string>)[platform()] ?? 'unknown', clientKind: 'desktop', deviceFingerprint: 'fixture-device', purpose: 'client-login' })
})

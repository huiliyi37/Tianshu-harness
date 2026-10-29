import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostname, platform } from 'node:os'
import { nativeDeviceMetadata } from '../device-metadata.js'

function nativeFixture(system: NodeJS.Platform, name = '研发工作站') {
  return { platform: () => system, hostname: () => name }
}

function expectedPlatform(): string {
  switch (platform()) {
    case 'win32': return 'windows'
    case 'darwin': return 'macos'
    case 'linux': return 'linux'
    default: return 'unknown'
  }
}

test('device metadata distinguishes Windows, macOS and Linux independently of the authorizing browser', () => {
  for (const [system, expected] of [['win32', 'windows'], ['darwin', 'macos'], ['linux', 'linux']] as const) {
    const metadata = nativeDeviceMetadata(undefined, 'desktop', nativeFixture(system))
    assert.equal(metadata.platform, expected)
    assert.equal(metadata.deviceName, '研发工作站')
    assert.equal(metadata.clientKind, 'desktop')
  }
})

test('device metadata reads the actual native hostname and operating system by default', () => {
  const metadata = nativeDeviceMetadata()
  assert.equal(metadata.platform, expectedPlatform())
  assert.equal(metadata.deviceName, Array.from(hostname().trim()).slice(0, 128).join(''))
  assert.equal(metadata.clientKind, 'cli')
})

test('a custom device name is preserved and avoids another hostname lookup', () => {
  let hostnameReads = 0
  const metadata = nativeDeviceMetadata('  我的 Mac\u0000  ', 'desktop', {
    platform: () => 'darwin',
    hostname: () => { hostnameReads++; throw new Error('must not be read') },
  })
  assert.equal(metadata.deviceName, '我的 Mac')
  assert.equal(hostnameReads, 0)
})

test('blank custom names fall back to the native hostname', () => {
  for (const name of ['', ' \r\n\u0000 ']) {
    assert.equal(nativeDeviceMetadata(name, 'cli', nativeFixture('win32', 'Fixture-PC')).deviceName, 'Fixture-PC')
  }
})

test('device names preserve Unicode, replace lone surrogates and enforce the backend limit without splitting emoji', () => {
  assert.equal(nativeDeviceMetadata('工作站\ud800A\udc00', 'cli', nativeFixture('linux')).deviceName, '工作站\uFFFDA\uFFFD')
  assert.equal(nativeDeviceMetadata('😀'.repeat(150), 'cli', nativeFixture('linux')).deviceName, '😀'.repeat(128))
})

test('unavailable hostname and unsupported native OS remain unknown instead of being invented', () => {
  const metadata = nativeDeviceMetadata(undefined, 'desktop', {
    platform: () => 'aix',
    hostname: () => { throw new Error('unavailable') },
  })
  assert.equal(metadata.deviceName, null)
  assert.equal(metadata.platform, 'unknown')
})

test('actual login requests include native device metadata and keep the persistent fingerprint and purpose unchanged', async () => {
  const { requestDeviceCode } = await import('../account.js')
  const sent: Record<string, unknown>[] = []
  for (const clientKind of ['cli', 'desktop'] as const) {
    const result = await requestDeviceCode({
      clientKind,
      deviceFingerprint: 'hardware-fixture-20261029',
      tuiVersion: '4.0-fixture',
      fetchImpl: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ deviceCode: 'metadata-fixture', userCode: '123456', expiresIn: 300, pollInterval: 5, verifyUrl: 'https://tianshuharness.com/auth/device' })
      },
    })
    const body = sent.at(-1)
    assert.equal(body?.deviceName, Array.from(hostname().trim()).slice(0, 128).join(''))
    assert.equal(body?.platform, expectedPlatform())
    assert.equal(body?.clientKind, clientKind)
    assert.equal(body?.deviceFingerprint, 'hardware-fixture-20261029')
    assert.equal(body?.purpose, 'client-login')
    assert.equal(body?.tuiVersion, '4.0-fixture')
    assert.equal(result.verifyUrl, 'https://tianshuharness.com/auth/device?code=123456')
  }
})

test('older login callers retain compatibility while receiving CLI and native defaults', async () => {
  const { requestDeviceCode } = await import('../account.js')
  let sent: Record<string, unknown> = {}
  await requestDeviceCode({
    deviceName: '  Fixture Desktop\n ',
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ deviceCode: 'metadata-fixture', userCode: '123456', verifyUrl: 'https://tianshuharness.com/auth/device' })
    },
  })
  assert.equal(sent.deviceName, 'Fixture Desktop')
  assert.equal(sent.clientKind, 'cli')
  assert.equal(sent.platform, expectedPlatform())
  assert.equal(sent.deviceFingerprint, null)
})

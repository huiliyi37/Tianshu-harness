import { hostname, platform } from 'node:os'

type NativeDeviceHost = Pick<typeof import('node:os'), 'hostname' | 'platform'>

const nativeHost: NativeDeviceHost = { hostname, platform }
const platforms = new Map([['win32', 'windows'], ['darwin', 'macos'], ['linux', 'linux']])

function cleanDeviceName(value: string): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\uD800-\uDFFF]/gu, '\uFFFD').trim()).slice(0, 128).join('')
}

export function nativeDeviceMetadata(deviceName?: string, clientKind: 'desktop' | 'cli' = 'cli', host: NativeDeviceHost = nativeHost) {
  let name = cleanDeviceName(deviceName ?? '')
  if (!name) {
    try { name = cleanDeviceName(host.hostname()) } catch {}
  }
  return {
    deviceName: name || null,
    platform: platforms.get(host.platform()) ?? 'unknown',
    clientKind,
  }
}

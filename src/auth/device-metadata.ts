import { hostname, platform } from 'node:os'

export function nativeDeviceMetadata(deviceName?: string, clientKind: 'desktop' | 'cli' = 'cli') {
  const clean = (value: string) => Array.from(Buffer.from(value.replace(/[\u0000-\u001f\u007f]/g, ''), 'utf8').toString('utf8').trim()).slice(0, 128).join('')
  let fallback = ''
  if (!deviceName || !clean(deviceName)) {
    try { fallback = hostname() } catch {}
  }
  const nativePlatform = platform()
  return {
    deviceName: clean(deviceName || '') || clean(fallback) || null,
    platform: ({ win32: 'windows', darwin: 'macos', linux: 'linux' } as Record<string, string>)[nativePlatform] || 'unknown',
    clientKind,
  }
}

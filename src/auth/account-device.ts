import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * 服务器 device-id 正则 `[A-Za-z0-9._:-]{8,128}`。
 *
 * 单点：落盘（device flow 登记的指纹）与路由（恢复请求透传的设备指纹）共用，
 * 两处各写一份就是下一次「一边放宽一边没放宽」的起点。
 */
export function isValidDeviceFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value)
}

export function parseNativeDeviceFingerprint(platform: string, output: string): string | undefined {
  const value = platform === 'darwin' ? /"IOPlatformUUID"\s*=\s*"([^"\n]+)"/.exec(output)?.[1]
    : platform === 'win32' ? /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1] : output.trim()
  const sane = value?.trim().replace(/[^A-Za-z0-9._:-]/g, '').slice(0,128)
  return isValidDeviceFingerprint(sane) ? sane : undefined
}

/** Same OS sources and casing as Rust machine-uid; the value is never logged. */
export function readNativeDeviceFingerprint(): string | undefined {
  try {
    if (process.platform === 'darwin') return parseNativeDeviceFingerprint('darwin',execFileSync('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice'],{encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore']}))
    if (process.platform === 'win32') return parseNativeDeviceFingerprint('win32',execFileSync('reg.exe',['query','HKLM\\SOFTWARE\\Microsoft\\Cryptography','/v','MachineGuid','/reg:64'],{encoding:'utf8',timeout:2000,windowsHide:true,stdio:['ignore','pipe','ignore']}))
    if (process.platform === 'linux') {
      for (const path of ['/var/lib/dbus/machine-id','/etc/machine-id']) {
        try {const id=parseNativeDeviceFingerprint('linux',readFileSync(path,'utf8'));if(id)return id} catch {}
      }
    }
  } catch { /* share the native persistent fallback below */ }
  return undefined
}

/** CLI and desktop share native hardware identity and the .device-id fallback. */
export function accountDeviceFingerprint(home: string, supplied?: unknown, nativeIdentity = readNativeDeviceFingerprint): string {
  if (supplied !== undefined && !isValidDeviceFingerprint(supplied)) throw new Error('invalid device fingerprint')
  const inherited = process.env.RIVET_PRO_DEVICE_ID
  if (isValidDeviceFingerprint(inherited) && supplied !== undefined && supplied !== inherited) throw new Error('device fingerprint mismatch')
  const native = isValidDeviceFingerprint(supplied) ? supplied : isValidDeviceFingerprint(inherited) ? inherited : nativeIdentity()
  const accountPath = join(home,'.account-device-id')
  if (isValidDeviceFingerprint(native)) {
    mkdirSync(home,{recursive:true})
    for (const path of [join(home,'.device-id'),accountPath]) {
      const temporary=`${path}.tmp-${randomUUID()}`
      try {writeFileSync(temporary,native,{mode:0o600,flag:'wx',flush:true});renameSync(temporary,path)}
      finally {try {unlinkSync(temporary)} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
    }
    return native
  }
  const path = join(home,'.device-id')
  const read = () => {
    for (let attempt=0;attempt<50;attempt++) {
      const id=readFileSync(path,'utf8').trim()
      if (isValidDeviceFingerprint(id)) return id
      if (id) throw new Error('invalid saved device fingerprint')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)
    }
    throw new Error('incomplete saved device fingerprint')
  }
  try {return read()} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  let candidate: string | undefined
  try {const old=readFileSync(accountPath,'utf8').trim();if(isValidDeviceFingerprint(old))candidate=old} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const id=candidate ?? randomUUID()
  mkdirSync(home,{recursive:true})
  try {writeFileSync(path,id,{mode:0o600,flag:'wx'});return id}
  catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')return read();throw error}
}

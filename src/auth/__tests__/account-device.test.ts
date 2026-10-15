import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountDeviceFingerprint, parseNativeDeviceFingerprint, readNativeDeviceFingerprint, isValidDeviceFingerprint } from '../account-device.js'

test('Windows MachineGuid 与 macOS IOPlatformUUID 使用和原生壳相同的值与大小写', () => {
  assert.equal(parseNativeDeviceFingerprint('win32','    MachineGuid    REG_SZ    ABCDEF12-1234-5678-9ABC-DEF123456789'), 'ABCDEF12-1234-5678-9ABC-DEF123456789')
  assert.equal(parseNativeDeviceFingerprint('darwin','    "IOPlatformUUID" = "ABCDEF12-1234-5678-9ABC-DEF123456789"'), 'ABCDEF12-1234-5678-9ABC-DEF123456789')
})
test('真实系统设备标识查询可持久化，查询失效与重启仍复用相同标识',()=>{
 const native=readNativeDeviceFingerprint()
 assert.ok(isValidDeviceFingerprint(native),'supported runner must provide a native identity')
 const home=mkdtempSync(join(tmpdir(),'account-device-native-'))
 try {
  assert.ok(accountDeviceFingerprint(home,undefined,readNativeDeviceFingerprint)===native)
  assert.ok(accountDeviceFingerprint(home,undefined,()=>undefined)===native)
 }finally{rmSync(home,{recursive:true,force:true})}
})
test('CLI-first fallback 与桌面原生备用文件共享设备标识，重启不再占一台', () => {
  const home=mkdtempSync(join(tmpdir(),'account-device-'))
  try {
    writeFileSync(join(home,'.device-id'),'device-native-fallback-fixture')
    assert.equal(accountDeviceFingerprint(home,undefined,()=>undefined),'device-native-fallback-fixture')
    assert.equal(accountDeviceFingerprint(home,undefined,()=>undefined),'device-native-fallback-fixture')
    assert.equal(readFileSync(join(home,'.device-id'),'utf8'),'device-native-fallback-fixture')
  } finally {rmSync(home,{recursive:true,force:true})}
})
test('独立 CLI 使用原生指纹；不能以旧随机账号 ID 重复占额', () => {
  const home=mkdtempSync(join(tmpdir(),'account-device-'))
  try {
    writeFileSync(join(home,'.account-device-id'),'old-random-device-fixture')
    assert.equal(accountDeviceFingerprint(home,undefined,()=> 'actual-native-fixture'),'actual-native-fixture')
    assert.equal(accountDeviceFingerprint(home,'actual-native-fixture',()=> 'actual-native-fixture'),'actual-native-fixture')
  } finally {rmSync(home,{recursive:true,force:true})}
})
test('确认原生指纹后硬件查询暂时失败，不能退回旧随机标识再占额',()=>{
 const home=mkdtempSync(join(tmpdir(),'account-device-'))
 try {
  writeFileSync(join(home,'.device-id'),'old-random-device-fixture')
  assert.equal(accountDeviceFingerprint(home,undefined,()=> 'actual-native-fixture'),'actual-native-fixture')
  assert.equal(accountDeviceFingerprint(home,undefined,()=>undefined),'actual-native-fixture')
 } finally {rmSync(home,{recursive:true,force:true})}
})

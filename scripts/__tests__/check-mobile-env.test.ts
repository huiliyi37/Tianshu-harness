import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMobileInstallEnv } from '../check-mobile-env.mjs'

describe('check-mobile-env（移动端安装守卫）', () => {
  it('裸 Termux（platform=android）→ fatal，指引 proot-distro', () => {
    const r = evaluateMobileInstallEnv({ platform: 'android', arch: 'arm64', env: {}, hasRg: true })
    assert.equal(r.level, 'fatal')
    const text = r.messages.join('\n')
    assert.match(text, /proot-distro/)
    assert.match(text, /@ast-grep\/napi/)
    assert.match(text, /ripgrep/)
  })

  it('裸 Termux + RIVET_ALLOW_MOBILE_INSTALL=1 → 降级为警告放行', () => {
    const r = evaluateMobileInstallEnv({
      platform: 'android', arch: 'arm64', env: { RIVET_ALLOW_MOBILE_INSTALL: '1' }, hasRg: true,
    })
    assert.equal(r.level, 'warn')
    assert.match(r.messages.join('\n'), /RIVET_ALLOW_MOBILE_INSTALL=1/)
  })

  it('proot（linux/arm64）无 ripgrep → 警告安装指引，不阻断', () => {
    const r = evaluateMobileInstallEnv({ platform: 'linux', arch: 'arm64', env: {}, hasRg: false })
    assert.equal(r.level, 'warn')
    assert.match(r.messages.join('\n'), /ripgrep/)
  })

  it('proot（linux/arm64）有 ripgrep → ok', () => {
    const r = evaluateMobileInstallEnv({ platform: 'linux', arch: 'arm64', env: {}, hasRg: true })
    assert.equal(r.level, 'ok')
    assert.equal(r.messages.length, 0)
  })

  it('桌面平台（darwin/x64、win32/x64）→ ok 静默', () => {
    for (const platform of ['darwin', 'win32']) {
      const r = evaluateMobileInstallEnv({ platform, arch: 'x64', env: {}, hasRg: true })
      assert.equal(r.level, 'ok')
    }
  })
})

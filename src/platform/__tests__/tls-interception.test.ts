import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectTlsInterception,
  findInterceptionCerts,
  formatTlsTrustLines,
  type TlsTrustProbe,
} from '../tls-interception.js'

/**
 * 真实形态的证书 fixture：openssl 预生成的自签证书（EC P-256，离线生成后硬编码，
 * 测试运行时不调 openssl——Windows CI 没有它）。PEM 体是 base64(DER)，subject 明文
 * 只存在于 DER 内、整段文本里搜不到——与生产 tls.getCACertificates() 的返回形态
 * 一致。此前测试用「BEGIN/END 之间塞明文 subject」的合成形态，自然界不存在，
 * 导致测试全绿而生产恒 0 命中（issue #288）。
 */
const KASPERSKY_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIB7zCCAZWgAwIBAgIUYC8khbQQtPheaus6uhVY/9sGe+8wCgYIKoZIzj0EAwIw
TTESMBAGA1UECgwJS2FzcGVyc2t5MTcwNQYDVQQDDC5LYXNwZXJza3kgQW50aS1W
aXJ1cyBQZXJzb25hbCBSb290IENlcnRpZmljYXRlMB4XDTI2MDkyODA0MTgyMFoX
DTI2MDkzMDA0MTgyMFowTTESMBAGA1UECgwJS2FzcGVyc2t5MTcwNQYDVQQDDC5L
YXNwZXJza3kgQW50aS1WaXJ1cyBQZXJzb25hbCBSb290IENlcnRpZmljYXRlMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYN8GivASP1/vmb+cIfdZ5N0IEvMUtYql
IWNM1Nec3nlpJ+5f0VJ2f5oENIst7KTZvi+jdZoB9JI5rK5QJfQkIKNTMFEwHQYD
VR0OBBYEFFeyOeUzwrUuL58nalT7rEiim+vlMB8GA1UdIwQYMBaAFFeyOeUzwrUu
L58nalT7rEiim+vlMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIh
AMuNZyUqP3mA5Xs78ucWDrCBEBUNSFtiKbTDtukWwxDLAiA+hoSGgMJnV/KPU+Wu
ZkjejnyuKjABuauJ9kKORLnp+A==
-----END CERTIFICATE-----`

const ZSCALER_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBtTCCAVugAwIBAgIUQxe6pIvsb/iiO0Cp+CCkHH8RSGYwCgYIKoZIzj0EAwIw
MDEUMBIGA1UECgwLWnNjYWxlciBJbmMxGDAWBgNVBAMMD1pzY2FsZXIgUm9vdCBD
QTAeFw0yNjA5MjgwNDE4MjBaFw0yNjA5MzAwNDE4MjBaMDAxFDASBgNVBAoMC1pz
Y2FsZXIgSW5jMRgwFgYDVQQDDA9ac2NhbGVyIFJvb3QgQ0EwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAQishB+tIrhw5TsVIzp3I5zbkQMEvGPDP1j/Sii2l5Y9qqu
3g5XooGy/NarpItTI/35s+p2FFSCkigeJPi3BZvto1MwUTAdBgNVHQ4EFgQUNQSD
CP19fS5JICJdBRKG79pw9aMwHwYDVR0jBBgwFoAUNQSDCP19fS5JICJdBRKG79pw
9aMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiBqEcYsgL/2ITJy
81I67H6hk4NAsb+gX26F6+QUlJSXbgIhAORNYsl0sx1D8ShFO3UHDwUFbsVqMGMK
caSaE/I3vRA9
-----END CERTIFICATE-----`

/** 非中间人厂商的公开 CA 形态（自签仿真，subject 同名公开根）。 */
const DIGICERT_PUBLIC_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIB4jCCAYegAwIBAgIUWxFVKBtulT6LrO+dNwANaVrTmtgwCgYIKoZIzj0EAwIw
RjELMAkGA1UEBhMCVVMxFTATBgNVBAoMDERpZ2lDZXJ0IEluYzEgMB4GA1UEAwwX
RGlnaUNlcnQgR2xvYmFsIFJvb3QgRzIwHhcNMjYwOTI4MDQxODIwWhcNMjYwOTMw
MDQxODIwWjBGMQswCQYDVQQGEwJVUzEVMBMGA1UECgwMRGlnaUNlcnQgSW5jMSAw
HgYDVQQDDBdEaWdpQ2VydCBHbG9iYWwgUm9vdCBHMjBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABJhslG13VGW+YNr4+LqpisQI4QaUuKnjMWE3j/ew56Agr4rGj7ln
OUNeC7FTfPWVDhmQyW4JVCORK0cI6dI9/QijUzBRMB0GA1UdDgQWBBSN0o8bhHKB
DVCybOzvKnI2DSQXyjAfBgNVHSMEGDAWgBSN0o8bhHKBDVCybOzvKnI2DSQXyjAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQCx+LN7jx3239U1goyj
QkDmiJQBIHwm93jx/fcutTh39AIhAKW0yEAXvhxDLZQCXGgH/3SFOgyvH0DxD5n0
Ry8fvvrU
-----END CERTIFICATE-----`

const ISRG_PUBLIC_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIB8jCCAZmgAwIBAgIUCEEbiSQWEC1p9uVjOH2/9UvP9TIwCgYIKoZIzj0EAwIw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoMIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDDAxJU1JHIFJvb3QgWDEwHhcNMjYwOTI4MDQxODIw
WhcNMjYwOTMwMDQxODIwWjBPMQswCQYDVQQGEwJVUzEpMCcGA1UECgwgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMMDElTUkcgUm9vdCBY
MTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABDS12pTLjzS8mpXVp8m4a+iYqxbA
hngfANsB02Yxu96BG2W/+k5LdqCzlAwSjHvual/bXJkr36UFxt/OOBqg1xqjUzBR
MB0GA1UdDgQWBBSQH6sM+ciwuL0uqhHz+X352503sDAfBgNVHSMEGDAWgBSQH6sM
+ciwuL0uqhHz+X352503sDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cA
MEQCIHbqRyVJdvUqAUc1ssPI6DSaiyf9NPZujpuj73xnJ0tpAiBA+bm3X/SRP0zy
bI0rfe1DlSj3/uyEdL5ltTM8s4bxVA==
-----END CERTIFICATE-----`

function probe(system: string[], bundled: string[], effective?: string[]): TlsTrustProbe {
  return {
    bundled: () => bundled,
    system: () => system,
    effective: () => effective ?? bundled,
  }
}

/** 多个拦截产品并存的系统证书存储：6 张同厂商（撑满展示上限）+ 1 张异厂商（排在上限之后）。 */
const MIXED_MITM_STORE = [
  ...Array.from({ length: 6 }, () => ZSCALER_ROOT_PEM),
  KASPERSKY_ROOT_PEM,
]

describe('findInterceptionCerts', () => {
  it('命中的是中间人厂商根证书（大小写不敏感）', () => {
    const { suspects, vendors, count } = findInterceptionCerts([
      KASPERSKY_ROOT_PEM,
      DIGICERT_PUBLIC_CA_PEM,
    ])
    assert.equal(count, 1)
    assert.deepEqual(vendors, ['Kaspersky'])
    assert.match(suspects[0]!, /Kaspersky/i)
  })

  it('真实 PEM 形态（subject 被 base64 编码进 DER）也能命中——生产 getCACertificates 即此形态（issue #288）', () => {
    // fixture 自检：PEM 文本里不得出现明文厂商名，否则就不是真实形态、
    // 旧实现（正则扫整段 PEM 文本）会跟着假绿。
    assert.doesNotMatch(KASPERSKY_ROOT_PEM, /kaspersky/i)
    const { suspects, vendors, count } = findInterceptionCerts([KASPERSKY_ROOT_PEM])
    assert.ok(count >= 1, '真实形态下应命中至少 1 张')
    assert.deepEqual(vendors, ['Kaspersky'])
    assert.match(suspects[0]!, /Kaspersky Anti-Virus Personal Root Certificate/)
  })

  it('公开 CA 不误报', () => {
    const { count } = findInterceptionCerts([DIGICERT_PUBLIC_CA_PEM, ISRG_PUBLIC_CA_PEM])
    assert.equal(count, 0)
  })

  it('命中数超过展示上限时截断 suspects 但保留真实计数', () => {
    const many = Array.from({ length: 8 }, () => ZSCALER_ROOT_PEM)
    const { suspects, vendors, count } = findInterceptionCerts(many)
    assert.equal(count, 8)
    assert.equal(suspects.length, 5)
    assert.deepEqual(vendors, ['Zscaler'])
  })

  // 上面那条用的是同一厂商的 8 张证书，所以「vendors 被展示上限一起卡掉」这个缺陷它测不出来：
  // 8 张全命中 Zscaler，去重后无论卡不卡都是 ['Zscaler']。真实系统证书存储里多个拦截产品
  // 并存是常态，而 getCACertificates('system') 的返回顺序由 OS 决定，不由我们决定。
  it('厂商清单不受展示上限影响——排在第 6 张之后的软件也要被点名', () => {
    const { suspects, vendors, count } = findInterceptionCerts(MIXED_MITM_STORE)
    assert.equal(count, 7, '计数应为全部命中')
    assert.equal(suspects.length, 5, 'subjects 仍按展示上限截断')
    // 用户去改哪个软件的设置，取决于这一条里有没有它的名字。
    assert.deepEqual(vendors, ['Zscaler', 'Kaspersky'], '第 6 张之后的卡巴斯基被展示上限吞掉——诊断会指错方向')
  })

  it('suspects 展示 X509 解析出的明文 subject 单行（不是 PEM 头，也不是 base64 数据行）', () => {
    const { suspects } = findInterceptionCerts([KASPERSKY_ROOT_PEM])
    assert.equal(suspects[0], 'O=Kaspersky, CN=Kaspersky Anti-Virus Personal Root Certificate')
  })

  it('解析失败的输入不炸——退回整段文本匹配保底，展示退回首行内容', () => {
    const unparsable = `-----BEGIN CERTIFICATE-----\nO=ESET, spol. s r.o., CN=ESET SSL Filter CA\nMIIB...\n-----END CERTIFICATE-----`
    const { suspects, vendors, count } = findInterceptionCerts([unparsable, 'not a cert', ''])
    assert.equal(count, 1)
    assert.deepEqual(vendors, ['ESET'])
    assert.equal(suspects[0], 'O=ESET, spol. s r.o., CN=ESET SSL Filter CA')
  })
})

describe('detectTlsInterception', () => {
  it('生效链长于内置链 ⇒ 判定为已信任系统 CA', () => {
    const report = detectTlsInterception(probe(['sys-a'], ['b1', 'b2'], ['b1', 'b2', 'sys-a']))
    assert.equal(report.trustsSystemCa, true)
    assert.equal(report.bundledCaCount, 2)
  })

  it('生效链等于内置链 ⇒ 判定为未信任系统 CA（默认形态）', () => {
    const report = detectTlsInterception(probe(['sys-a'], ['b1', 'b2']))
    assert.equal(report.trustsSystemCa, false)
  })

  it('系统存储不可读时退化为未检出，不抛错', () => {
    const report = detectTlsInterception({
      bundled: () => ['b1'],
      system: () => {
        throw new Error('system store unsupported')
      },
      effective: () => ['b1'],
    })
    assert.equal(report.systemStoreReadable, false)
    assert.deepEqual(report.suspects, [])
  })
})

describe('formatTlsTrustLines', () => {
  it('检出中间人且未信任系统 CA 时给出三条处置建议', () => {
    const report = detectTlsInterception(probe([KASPERSKY_ROOT_PEM], ['b1']))
    const lines = formatTlsTrustLines(report).join('\n')
    assert.match(lines, /Kaspersky/)
    assert.match(lines, /NODE_EXTRA_CA_CERTS/)
    assert.match(lines, /--use-system-ca/)
    assert.match(lines, /加密连接扫描/)
  })

  it('摘要行点名的厂商与计数口径一致——不指错要用户去改的那个软件', () => {
    const report = detectTlsInterception(probe(MIXED_MITM_STORE, ['bundled-a']))
    const [headline] = formatTlsTrustLines(report)
    assert.equal(report.suspectCount, 7)
    assert.match(headline!, /7 条/)
    assert.match(headline!, /Kaspersky/, '摘要行漏掉真正要用户去设置里排除的那个软件')
  })

  it('未检出时只报平安，不刷建议', () => {
    const lines = formatTlsTrustLines(detectTlsInterception(probe([DIGICERT_PUBLIC_CA_PEM], ['b1'])))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /未检出/)
  })

  it('系统存储不可读时明确说明跳过（不假装探过）', () => {
    const lines = formatTlsTrustLines({
      systemStoreReadable: false,
      systemCaCount: 0,
      trustsSystemCa: false,
      bundledCaCount: 1,
      suspects: [],
      suspectCount: 0,
      vendors: [],
    })
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /跳过/)
  })
})

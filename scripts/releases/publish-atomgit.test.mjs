/**
 * 回归测试：钉住 2026-10-08 首次真跑 AtomGit 发布时暴露的三处平台适配。
 *
 * 三个断言的共同点：**都不依赖网络**，靠注入 request（脚本本来就留了这个接缝），
 * 所以能用假响应精确复现平台行为，并在实现回退时立刻变红。
 *
 *   1. 上传必须显式带 Content-Length —— 预签名端点对 chunked PUT 返 411 Length Required
 *   2. 存在性探测不得用 HEAD —— AtomGit 附件入口对 HEAD 恒 404（同一 URL 的 GET 正常 206），
 *      用 HEAD 判存会把已上传的附件判成「不存在」，每次重跑都重传几百 MB
 *   3. 验收不得把 HEAD 404 当失败 —— 以 Range 206 为准，HEAD 只作记录
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { uploadImmutable, verifyDownload, atomgitManifest, publishMetadata, downloadURL, qualifyProof } from './publish-atomgit.mjs'

const BODY = Buffer.from('atomgit attachment body\n')
const SHA = createHash('sha256').update(BODY).digest('hex')
const EXPECTED = { size: BODY.length, sha256: SHA }

/** 假平台：existing 控制附件是否已存在；headStatus 模拟 AtomGit 对 HEAD 恒 404。 */
function makeHarness({ existing, headStatus = 404 } = {}) {
  const calls = { put: 0, head: 0, probe: 0, download: 0, putHeaders: undefined, probeMethod: undefined }
  const request = async (_url, opts = {}) => {
    const method = opts.method ?? 'GET'
    const range = opts.headers?.Range
    if (method === 'PUT') {
      calls.put += 1
      calls.putHeaders = opts.headers
      return new Response('success', { status: 200 })
    }
    if (method === 'HEAD') {
      calls.head += 1
      return new Response(null, { status: headStatus })
    }
    if (range === 'bytes=0-0') {
      calls.probe += 1
      calls.probeMethod = method
      return existing
        ? new Response(BODY.subarray(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${BODY.length}` } })
        : new Response(null, { status: 404 })
    }
    if (range === 'bytes=0-1023') {
      return new Response(BODY, { status: 206, headers: { 'content-range': `bytes 0-${BODY.length-1}/${BODY.length}` } })
    }
    calls.download += 1
    return new Response(BODY, { status: 200 })
  }
  return { request, calls }
}

function makeFile() {
  const dir = mkdtempSync(join(tmpdir(), 'atomgit-publish-'))
  const file = join(dir, 'artifact.bin')
  writeFileSync(file, BODY)
  return file
}

test('上传显式带 Content-Length（chunked PUT 会被预签名端点以 411 拒收）', async () => {
  const file = makeFile()
  const { request, calls } = makeHarness({ existing: false })
  const api = async () => ({ url: 'https://upload.example.test/put', headers: { 'Content-Type': 'application/octet-stream' } })

  await uploadImmutable(api, 'v0.0.0', file, EXPECTED, request)

  assert.equal(calls.put, 1, '应当发生一次上传')
  assert.equal(
    calls.putHeaders?.['Content-Length'],
    String(BODY.length),
    'PUT 必须携带真实长度——缺了就是 411',
  )
})

test('HEAD 网络失败不否决已完整验证的下载和 Range', async () => {
  const { request } = makeHarness({ existing: true })
  const proof = await verifyDownload('https://api.example.test/download', EXPECTED, (url, opts) => {
    if (opts.method === 'HEAD') throw new Error('HEAD unavailable')
    return request(url, opts)
  })
  assert.equal(proof.headStatus, null)
  assert.equal(proof.rangeSupported, true)
})

test('Range 必须核对总长度、区间、正文，拒绝伪成功或忽略 Range 的全量响应', async () => {
  for (const [body, status, header] of [[BODY,206,`bytes 0-1023/${BODY.length}`], [BODY,206,`bytes 0-${BODY.length-1}/999`], [Buffer.from('wrong'),206,`bytes 0-${BODY.length-1}/${BODY.length}`], [BODY,200,'']]) {
    const { request } = makeHarness({ existing: true })
    const proof = await verifyDownload('https://api.example.test/download', EXPECTED, (url, opts) => opts.headers?.Range === 'bytes=0-1023' ? new Response(body,{status,headers:{'content-range':header}}) : request(url,opts))
    assert.equal(proof.rangeSupported, false)
  }
})

function metadataFixture() {
  const version = '3.30.0'
  return { schemaVersion:1, revision:1, version, publishedAt:'2026-10-09T00:00:00Z', artifacts:['windows-x86_64','darwin-aarch64'].map(platform => {
    const fileName = `Tianshu_${version}_${platform.startsWith('windows') ? 'x64-setup.exe' : 'aarch64.app.tar.gz'}`
    return { platform, purpose:'update', fileName, ...EXPECTED, signature:'signed', sources:{atomgit:{...EXPECTED,url:downloadURL(`v${version}`,fileName),verified:true,anonymous:true,qualificationVerified:true,rangeSupported:true,verifiedAt:'2026-10-09T00:00:00Z'}} }
  }) }
}
test('已验收包重试时 HEAD 状态和时间变化不能改动不可变目录', () => {
  const previous={...metadataFixture().artifacts[0].sources.atomgit,headStatus:404}
  const next={...previous,headStatus:null,verifiedAt:'2026-10-10T00:00:00Z'}
  assert.deepEqual(qualifyProof(previous,next,false),previous)
  const unqualified={...previous,verified:false,qualificationVerified:false}
  assert.equal(qualifyProof(unqualified,next,false).verified,false)
  assert.equal(qualifyProof(unqualified,next,true).verified,true)
})
test('metadata-only 默认 dry run 展示全部平台且不要求本地安装包、不写文件', () => {
  const dir=mkdtempSync(join(tmpdir(),'atomgit-dry-run-'))
  try {
    const path=join(dir,'catalog.json');writeFileSync(path,JSON.stringify(metadataFixture()))
    const result=spawnSync(process.execPath,[join(import.meta.dirname,'publish-atomgit.mjs'),'--metadata-only','--catalog',path,'--assets',join(dir,'missing-assets')],{encoding:'utf8',timeout:5000,windowsHide:true})
    assert.equal(result.status,0,result.stderr)
    assert.match(result.stdout,/Dry run:.*windows-x86_64, darwin-aarch64/)
    assert.deepEqual(readdirSync(dir),['catalog.json'])
  } finally {rmSync(dir,{recursive:true,force:true})}
})
test('不可变清单覆盖全部平台；单个平台未准备好时禁止任何远端写入', async () => {
  const catalog = metadataFixture()
  assert.deepEqual(Object.keys(atomgitManifest(catalog).platforms), ['windows-x86_64','darwin-aarch64'])
  catalog.artifacts[1].sources.atomgit.verified = false
  let calls = 0
  await assert.rejects(publishMetadata(async () => { calls++ }, 'v3.30.0', tmpdir(), catalog, async () => { calls++ }), /All update platforms/)
  assert.equal(calls, 0)
})
test('仅补齐元数据，不再传安装包；读回 latest 和目录均为完整版本', async () => {
  const dir = mkdtempSync(join(tmpdir(),'atomgit-metadata-')), catalog = metadataFixture(), files = new Map(), uploads = []
  const api = async path => { const name = new URL(`https://fixture.test${path}`).searchParams.get('file_name'); uploads.push(name); return {url:`https://upload.example.test/${name}`} }
  const request = async (url, options = {}) => {
    const parsed = new URL(url), name = decodeURIComponent(parsed.hostname.startsWith('upload') ? parsed.pathname.slice(1) : parsed.pathname.split('/').at(-2))
    if (options.method === 'PUT') { const chunks=[]; for await (const chunk of options.body) chunks.push(chunk); files.set(name,Buffer.concat(chunks)); return new Response(null,{status:200}) }
    const body=files.get(name)
    if (!body) return new Response(null,{status:404})
    if (options.method === 'HEAD') return new Response(null,{status:404})
    if (options.headers?.Range) { const part=body.subarray(0,options.headers.Range==='bytes=0-0'?1:1024); return new Response(part,{status:206,headers:{'content-range':`bytes 0-${part.length-1}/${body.length}`}}) }
    return new Response(body)
  }
  const original = Buffer.from(JSON.stringify(catalog))
  await publishMetadata(api,'v3.30.0',dir,catalog,request,original)
  await publishMetadata(api,'v3.30.0',dir,catalog,request,original)
  assert.deepEqual(uploads,['latest.json','release-catalog.json'])
  assert.deepEqual(Object.keys(JSON.parse(files.get('latest.json')).platforms),['windows-x86_64','darwin-aarch64'])
  assert.deepEqual(JSON.parse(files.get('release-catalog.json')),catalog)
  assert.deepEqual(files.get('release-catalog.json'),original,'mirror must preserve the policy-pinned raw bytes including formatting')
})

test('存在性探测用 Range GET 而非 HEAD（HEAD 恒 404 会误判为不存在并重复上传）', async () => {
  const file = makeFile()
  const { request, calls } = makeHarness({ existing: true, headStatus: 404 })
  const api = async () => { throw new Error('附件已存在，不应再取 upload_url') }

  await uploadImmutable(api, 'v0.0.0', file, EXPECTED, request)

  assert.equal(calls.probe, 1, '存在性探测应发生一次')
  assert.equal(calls.probeMethod, 'GET', '探测方法必须是 GET（HEAD 恒 404）')
  assert.equal(calls.put, 0, '已存在时不得重复上传')
})

test('HEAD 恒 404 不影响验收——以 Range 206 为准，HEAD 只作记录', async () => {
  const { request } = makeHarness({ existing: true, headStatus: 404 })

  const proof = await verifyDownload('https://api.example.test/attach/download', EXPECTED, request)

  assert.equal(proof.headStatus, 404, '平台对 HEAD 恒 404（事实记录，不是失败）')
  assert.equal(proof.rangeSupported, true, 'Range 206 + content-range 才是验收依据')
  assert.equal(proof.sha256, SHA, '全量内容的 SHA-256 必须与本地一致')
})

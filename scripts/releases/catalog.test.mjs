import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chooseCatalog, selectSources, validateCatalog, assertCatalogUpdate } from './catalog.mjs'
import { generateCatalog } from './generate-catalog.mjs'
import { atomgitClient, uploadImmutable, verifyDownload, validateAcceptance } from './publish-atomgit.mjs'
const bytes = Buffer.from('signed installer fixture'), digest = createHash('sha256').update(bytes).digest('hex')
const entry = (source, verified = true) => ({ url: source === 'github' ? 'https://github.com/huiliyi37/Tianshu-harness/releases/download/v3.28.0/Tianshu_3.28.0_x64-setup.exe' : source === 'oss' ? 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/v3.28.0/Tianshu_3.28.0_x64-setup.exe' : 'https://api.atomgit.com/api/v5/repos/huiliyi37/Tianshu-harness/releases/v3.28.0/attach_files/Tianshu_3.28.0_x64-setup.exe/download', verified, verifiedAt:'2026-10-07T00:00:00Z', sha256:digest, size:bytes.length, anonymous:true })
const fixture = () => ({ schemaVersion:1, revision:1, version:'3.28.0', publishedAt:'2026-10-07T00:00:00Z', artifacts:[{ platform:'windows-x86_64', purpose:'update', fileName:'Tianshu_3.28.0_x64-setup.exe', size:bytes.length, sha256:digest, signature:'signed', sources:{ atomgit:entry('atomgit'), github:entry('github'), oss:entry('oss') } }] })
test('auto uses verified AtomGit then GitHub and never OSS', () => {
  const c = fixture(); assert.deepEqual(selectSources(c,'windows-x86_64','update').candidates.map(x=>x.source),['atomgit','github'])
  c.artifacts[0].sources.atomgit.verified = false
  assert.deepEqual(selectSources(c,'windows-x86_64','update').candidates.map(x=>x.source),['github'])
  assert.equal(selectSources(c,'windows-x86_64','update','atomgit').candidates.length,0)
  assert.deepEqual(selectSources(c,'windows-x86_64','update','auto',true).candidates.map(x=>x.source),['oss'])
  assert.equal(selectSources(c,'darwin-aarch64','update'),undefined)
})
test('select highest stable version before source priority; reject byte conflicts', () => {
  const c = fixture(), older = fixture(); older.version='3.27.0'; older.artifacts[0].fileName=older.artifacts[0].fileName.replace('3.28.0','3.27.0')
  for(const source of Object.values(older.artifacts[0].sources))source.url=source.url.replaceAll('3.28.0','3.27.0')
  assert.equal(chooseCatalog([older,c]).version,'3.28.0')
  assert.throws(()=>assertCatalogUpdate(c,older),/downgrade/)
  assert.doesNotThrow(()=>assertCatalogUpdate(c,fixture()))
  const modified=fixture();modified.notes='changed';assert.throws(()=>assertCatalogUpdate(c,modified),/higher revision/)
  const bad = fixture(); bad.revision=2; bad.artifacts[0].signature='different'; assert.throws(()=>chooseCatalog([c,bad]),/disagree/)
  c.version='3.29.0-beta'; assert.throws(()=>validateCatalog(c))
})
test('reject credential-bearing, temporary and foreign download entries', () => {
  for (const url of ['https://github.com/other/repo/releases/download/v1/a','https://github.com/huiliyi37/Tianshu-harness/releases/download/v1/a?token=x','http://github.com/huiliyi37/Tianshu-harness/releases/download/v1/a']) {
    const c=fixture();c.artifacts[0].sources.github.url=url;assert.throws(()=>validateCatalog(c))
  }
  const c=fixture();c.artifacts[0].sources.atomgit.anonymous=false;assert.throws(()=>validateCatalog(c),/anonymous/)
  const wrong=fixture();wrong.artifacts[0].fileName='Tianshu_3.28.0_x64.dmg';assert.throws(()=>validateCatalog(wrong),/platform or purpose/)
})
test('generator validates local bytes, remote digest and signature before publication', async () => {
  const dir=mkdtempSync(join(tmpdir(),'tianshu-catalog-'));try {
    const name=fixture().artifacts[0].fileName;writeFileSync(join(dir,name),bytes);writeFileSync(join(dir,name+'.sig'),'signed')
    const args={assets:dir,manifest:{version:'3.28.0',platforms:{'windows-x86_64':{url:entry('github').url,signature:'signed'}}},githubAssets:[{name,size:bytes.length,digest:`sha256:${digest}`} ]}
    const first=await generateCatalog(args)
    assert.equal(first.artifacts.length,2)
    assert.deepEqual(await generateCatalog({...args,previousCatalog:first}),first)
    await assert.rejects(generateCatalog({...args,githubAssets:[{name,size:bytes.length,digest:'sha256:'+'0'.repeat(64)}]}),/differs/)
    writeFileSync(join(dir,name+'.sig'),'wrong');await assert.rejects(generateCatalog(args),/signature differ/)
  } finally {rmSync(dir,{recursive:true,force:true})}
})
test('anonymous full download checks bytes; range never triggers a second full download', async () => {
  const calls=[]
  const request=async (url,opts)=>{calls.push(opts);return opts.method==='HEAD'?new Response(null,{status:200}):opts.headers?.Range?new Response(bytes,{status:206,headers:{'content-range':`bytes 0-${bytes.length-1}/${bytes.length}`}}):new Response(bytes)}
  const proof=await verifyDownload(entry('atomgit').url,{size:bytes.length,sha256:digest},request)
  assert.equal(proof.anonymous,true);assert.equal(proof.rangeSupported,true);assert.ok(calls.every(c=>!c.headers?.Authorization&&!c.headers?.Cookie))
  await assert.rejects(verifyDownload(entry('atomgit').url,{size:bytes.length,sha256:'0'.repeat(64)},request),/mismatch/)
})
test('existing different attachment cannot be overwritten on retry', async () => {
  let mutations=0
  await assert.rejects(uploadImmutable(async()=>{mutations++},'v3.28.0','fixture.exe',{size:bytes.length,sha256:'0'.repeat(64)},async(_,opts)=>opts.method==='HEAD'?new Response(null,{status:200}):new Response(bytes)),/mismatch/)
  assert.equal(mutations,0)
})
test('API preserves upload filename query and does not expose token in errors', async () => {
  const api=atomgitClient('private-fixture',async url=>{assert.equal(url.searchParams.get('file_name'),'a.exe');assert.equal(url.searchParams.get('access_token'),'private-fixture');return new Response(null,{status:429})})
  await assert.rejects(api('/releases/v3.28.0/upload_url?file_name=a.exe'),e=>e.status===429&&!e.message.includes('private-fixture'))
})
test('anonymous readback alone cannot qualify a default AtomGit route', () => {
  const c=fixture(),a=c.artifacts[0]
  assert.throws(()=>validateAcceptance({schemaVersion:1,version:c.version,platform:a.platform,sha256:a.sha256},c,a),/incomplete/)
  const acceptance={schemaVersion:1,version:c.version,platform:a.platform,sha256:a.sha256,tauriRedirectVerified:true,stableEntryVerified:true,disconnectRetryVerified:true,limitsObserved:'Upload size accepted; provider quota not publicly specified',networks:[{name:'network A',passed:true,checkedAt:c.publishedAt},{name:'network B',passed:true,checkedAt:c.publishedAt}]}
  assert.equal(validateAcceptance(acceptance,c,a),true)
  acceptance.networks[1].name='network A';assert.throws(()=>validateAcceptance(acceptance,c,a),/distinct/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonical, digest, bucket, validateControl, chooseControl, selectRelease, transition } from './update-control.mjs'
import { publishTransaction, readRemote, main } from './publish-update-control.mjs'
import { summarizeRouting } from './report-routing.mjs'
import { guardStablePublication } from './guard-stable-publication.mjs'

const fixture = () => ({ schemaVersion: 1, revision: 1, stable: { version: '3.29.2', catalogSha256: 'a'.repeat(64) }, candidate: { version: '3.30.0', catalogSha256: 'b'.repeat(64), platforms: { 'darwin-aarch64': { status: 'active', percentage: 0 }, 'windows-x86_64': { status: 'active', percentage: 0 } } }, revokedVersions: [] })
const catalog = () => ({ version: '3.30.0', artifacts: ['darwin-aarch64', 'windows-x86_64'].map(platform => ({ platform, purpose: 'update', sha256: 'c'.repeat(64) })) })
const evidence = () => ({ version: '3.30.0', platforms: Object.fromEntries(catalog().artifacts.map(a => [a.platform, { sha256: a.sha256, passed: true, checkedAt: '2026-10-09T00:00:00Z', conclusion: 'Installed signed package on a real test machine', realSignedUpgrade: true }])) })
test('cohorts are stable, nested, platform-specific and equal to Rust golden vector', () => {
  assert.equal(bucket('fixture', '3.30.0', 'darwin-aarch64'), 8371)
  assert.notEqual(bucket('fixture', '3.30.0', 'darwin-aarch64'), bucket('fixture', '3.30.0', 'windows-x86_64'))
  for (const percentage of [0, 1, 5, 20, 50, 100]) {
    const c = fixture(); c.candidate.platforms['darwin-aarch64'].percentage = percentage
    assert.equal(selectRelease(c, 'darwin-aarch64', 'fixture').channel, percentage > 83 ? 'candidate' : 'stable')
    assert.equal(selectRelease(c, 'darwin-aarch64', undefined).channel, 'stable')
  }
})
test('manual and preview selection never bypass pauses, missing platforms or revocation', () => {
  const c = fixture()
  assert.equal(selectRelease(c, 'darwin-aarch64', 'fixture', true).channel, 'preview')
  assert.equal(selectRelease(c, 'linux-x86_64', 'fixture', true).channel, 'stable')
  c.candidate.platforms['darwin-aarch64'].status = 'paused'
  assert.equal(selectRelease(c, 'darwin-aarch64', 'fixture', true).channel, 'stable')
  const revoked = transition(c, 'revoke')
  assert.equal(selectRelease(revoked, 'windows-x86_64', 'fixture', true).channel, 'stable')
  assert.throws(() => transition(revoked, 'resume'), /cannot reopen/)
})
test('control chooses revision, rejects conflicting content, rollback and lost revocations', () => {
  const c = fixture(), next = transition(c, 'pause')
  assert.equal(chooseControl([c, next]).revision, 2)
  assert.throws(() => chooseControl([c], next), /ROLLBACK/)
  const conflict = structuredClone(c); conflict.candidate.platforms['darwin-aarch64'].percentage = 1
  assert.throws(() => chooseControl([c, conflict]), /CONFLICT/)
  const revoked = transition(c, 'revoke'); next.revision = 3
  assert.throws(() => chooseControl([next], revoked), /REVOKED_REMOVED/)
  assert.throws(() => validateControl({ ...c, revision: 0 }))
  assert.throws(() => validateControl({ ...c, revokedVersions: Array(30000).fill('3.0.0') }))
})
test('release transitions require matching evidence and refuse reductions or premature promotion', () => {
  const c = fixture(), options = { catalog: catalog(), evidence: evidence(), percentage: 5 }
  assert.throws(() => transition(c, 'set-percentage', { ...options, evidence: undefined }), /Acceptance/)
  assert.throws(() => transition(c, 'set-percentage', { ...options, catalog: { ...catalog(), version: '3.31.0' } }), /version differs/)
  const five = transition(c, 'set-percentage', options)
  assert.throws(() => transition(five, 'set-percentage', { ...options, percentage: 1 }), /Pause/)
  assert.throws(() => transition(five, 'promote', options), /100%/)
  const hundred = transition(five, 'set-percentage', { ...options, percentage: 100 })
  const bad = evidence(); bad.platforms['windows-x86_64'].realSignedUpgrade = false
  assert.throws(() => transition(hundred, 'promote', { ...options, evidence: bad }), /Real signed/)
  const promoted = transition(hundred, 'promote', options)
  assert.equal(promoted.stable.version, '3.30.0'); assert.equal(promoted.candidate, undefined)
  const paused = transition(five, 'pause', { platforms: ['darwin-aarch64'] })
  assert.equal(paused.candidate.platforms['windows-x86_64'].status, 'active')
  assert.equal(transition(paused, 'resume', { platforms: ['darwin-aarch64'] }).candidate.platforms['darwin-aarch64'].percentage, 5)
})
test('dual-source publication is idempotent after a partial failure and confirms bytes', async () => {
  const tx = { next: fixture(), completed: {} }, stored = {}, uploads = [], saves = []; let fail = true
  const io = { read: async s => stored[s], upload: async (s, b) => { uploads.push(s); if (s === 'oss' && fail) throw new Error('offline'); stored[s] = b }, save: async t => saves.push(structuredClone(t)) }
  await assert.rejects(publishTransaction(tx, io), /offline/)
  assert.equal(tx.completed.github, true); assert.equal(tx.completed.oss, undefined)
  fail = false; await publishTransaction(tx, io)
  assert.deepEqual(uploads, ['github', 'oss', 'oss']); assert.equal(saves.at(-1).completed.oss, true)
  assert.equal(digest(stored.github), digest(stored.oss))
  await assert.rejects(publishTransaction({ next: fixture(), completed: {} }, { read: async () => Buffer.from(canonical({ ...fixture(), revision: 0 })), upload: async () => {}, save: async () => {} }), /Invalid update control/)
})
test('bounded local metadata service covers malformed bodies, missing sources and byte identity', async () => {
  const bytes = Buffer.from(canonical(fixture()) + '\n')
  const server = createServer((req, res) => { if (req.url === '/missing') { res.writeHead(404); res.end() } else if (req.url === '/huge') res.end(' '.repeat(256 * 1024 + 1)); else res.end(bytes) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try { assert.equal(digest(await readRemote(base)), digest(bytes)); assert.equal(await readRemote(base + '/missing'), undefined); await assert.rejects(readRemote(base + '/huge'), /256 KiB/) }
  finally { await new Promise(resolve => server.close(resolve)) }
})
test('production publisher isolates candidate operations from legacy writes and website refresh', () => {
  const source = readFileSync(new URL('./publish-update-control.mjs', import.meta.url), 'utf8')
  const promotion = source.slice(source.indexOf("if (operation === 'promote' && !transaction.completed.promotion)"), source.indexOf("} else if (operation !== 'promote')"))
  assert.ok(promotion.includes("'--prerelease=false'")); assert.ok(promotion.includes('publish-routing.mjs')); assert.ok(promotion.includes("'latest.json'"))
  const before = source.slice(0, source.indexOf("if (operation === 'promote' && !transaction.completed.promotion)"))
  assert.ok(!before.includes("run(process.execPath, ['scripts/releases/publish-routing.mjs'"))
  assert.ok(source.indexOf('if (!publish) return') < source.indexOf('saveFile(txPath, transaction)'))
  assert.ok(source.includes('Stable entry changed during candidate publication'))
})
test('local upgrade report keeps the last result per attempt and retains diagnostics', () => {
  const report=summarizeRouting([
    {event:'policy_selected',detail:{channel:'preview',policyRevision:2,platform:'darwin-aarch64'}},
    {event:'upgrade_attempt',detail:{attemptId:'a',status:'preparing',fromVersion:'3.29.2',toVersion:'3.30.0'}},
    {event:'upgrade_result',detail:{attemptId:'a',status:'installer_returned'}},
    {event:'upgrade_result',detail:{attemptId:'a',status:'confirmed'}},
    {event:'install_failed',detail:{code:'UPDATE_POLICY_PAUSED',stage:'policy'}},
  ])
  assert.equal(report.upgrades.length,1); assert.equal(report.upgrades[0].status,'confirmed')
  assert.equal(report.selections[0].policyRevision,2); assert.equal(report.failures[0].stage,'policy')
})
test('production dry run validates prerelease and creates no files or remote writes', async () => {
  const makeCatalog = version => ({ schemaVersion:1, revision:1, version, publishedAt:'2026-10-09T00:00:00Z', artifacts:['windows-x86_64','darwin-aarch64'].map(platform => {
    const fileName=`Tianshu_${version}_${platform.startsWith('windows') ? 'x64-setup.exe' : 'aarch64.app.tar.gz'}`
    return {platform,purpose:'update',fileName,size:100,sha256:'c'.repeat(64),signature:'test-signature',sources:{github:{url:`https://github.com/huiliyi37/Tianshu-harness/releases/download/v${version}/${fileName}`,verified:true,size:100,sha256:'c'.repeat(64),verifiedAt:'2026-10-09T00:00:00Z'}}}
  }) })
  const stableBytes=Buffer.from(JSON.stringify(makeCatalog('3.29.2'))), candidateBytes=Buffer.from(JSON.stringify(makeCatalog('3.30.0')))
  const control={schemaVersion:1,revision:1,stable:{version:'3.29.2',catalogSha256:digest(stableBytes)},revokedVersions:[]}
  const dir=mkdtempSync(join(tmpdir(),'tianshu-control-cli-')), oldCwd=process.cwd(), oldFetch=globalThis.fetch, oldLog=console.log
  let prerelease=true; const calls=[], messages=[]
  try {
    process.chdir(dir);writeFileSync('catalog.json',candidateBytes);writeFileSync('acceptance.json',JSON.stringify(evidence()))
    const before=readdirSync(dir)
    globalThis.fetch=async (url, options) => {
      assert.ok(!options?.method || options.method==='GET');calls.push(String(url))
      if (url.includes('/releases/tags/')) return new Response(JSON.stringify({draft:false,prerelease}))
      if (url.endsWith('update-control.json')) return new Response(JSON.stringify(control))
      if (url.includes('/v3.30.0/')) return new Response(candidateBytes)
      return new Response(stableBytes)
    }
    console.log = text => messages.push(text)
    await main(['stage','--catalog','catalog.json','--acceptance','acceptance.json','--platforms','windows-x86_64,darwin-aarch64'])
    assert.deepEqual(readdirSync(dir),before);assert.equal(JSON.parse(messages[0]).next.candidate.platforms['windows-x86_64'].percentage,0)
    prerelease=false;await assert.rejects(main(['stage','--catalog','catalog.json','--acceptance','acceptance.json','--platforms','windows-x86_64']),/prerelease/)
    assert.ok(calls.some(url=>url.includes('/releases/latest/download/latest.json')))
  } finally { globalThis.fetch=oldFetch;console.log=oldLog;process.chdir(oldCwd);rmSync(dir,{recursive:true,force:true}) }
})
test('old publishers cannot expose a candidate or replace a pinned stable catalog', async () => {
  const c=fixture(), fetcher=async () => new Response(JSON.stringify(c))
  await guardStablePublication('3.29.2',undefined,fetcher)
  await assert.rejects(guardStablePublication('3.30.0',undefined,fetcher),/controlled stable/)
  const shell=readFileSync(new URL('../upload-update-to-oss.sh',import.meta.url),'utf8')
  assert.ok(shell.indexOf('guard-stable-publication.mjs') < shell.indexOf('"$OSSUTIL" cp'))
  assert.ok(shell.indexOf('候选资产上传完成') < shell.indexOf('cp "$WORK/latest-oss.json"'))
})

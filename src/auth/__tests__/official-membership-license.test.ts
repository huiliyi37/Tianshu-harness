import { after, test as nodeTest } from 'node:test'
const test: typeof nodeTest = process.env.R5B_NATIVE_FIXTURE === '1' ? (() => {}) as typeof nodeTest : nodeTest
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyProGrant, verifyGrantSignature, validateOfficialMembershipClaims } from '../../config/pro-grant.js'
import { makeTestSigner, signGrant } from '../../config/__tests__/grant-fixtures.js'
import { resolveProLicense, __setProGrantPublicKeyForTests } from '../../config/pro-license.js'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { buildAccountRoutes } from '../../server/account-routes.js'
import { createRouter } from '../../server/index.js'

const previousAccountApi = process.env.RIVET_ACCOUNT_API
const previousAccountAnonKey = process.env.RIVET_ACCOUNT_ANON_KEY
process.env.RIVET_ACCOUNT_API = 'https://membership-fixture.invalid'
process.env.RIVET_ACCOUNT_ANON_KEY = 'synthetic-anon'
after(() => {
  if (previousAccountApi === undefined) delete process.env.RIVET_ACCOUNT_API
  else process.env.RIVET_ACCOUNT_API = previousAccountApi
  if (previousAccountAnonKey === undefined) delete process.env.RIVET_ACCOUNT_ANON_KEY
  else process.env.RIVET_ACCOUNT_ANON_KEY = previousAccountAnonKey
})

test('normal account routes expose a private membership activation boundary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'membership-route-'))
  try {
    const router = createRouter(buildAccountRoutes({ rivetHome: home, apiToken: 'fixture-bearer' }))
    const result = await router('POST', '/account/activate-model-membership', { requestId: '00000000-0000-4000-8000-000000000001' }, { authorization: 'Bearer fixture-bearer' })
    assert.equal(result.status, 401, 'ordinary renderer Bearer cannot read the private grant route')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('official membership cannot unlock generic raw, env or legacy-file gates, even with forged owner context', () => {
  const home = mkdtempSync(join(tmpdir(), 'membership-generic-'))
  const old = { ...process.env }
  const signer = makeTestSigner(), now = Date.now()
  const token = signGrant({ product: 'tianshu-desktop', deviceId: 'fixture-device-12345', tier: 'pro',
    source: 'official-membership', subject: '11111111-1111-4111-8111-111111111111',
    accountSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', membershipRevision: '1',
    iat: now - 60000, exp: now, lic: now + 86400000, maxOfflineMs: 0 }, signer.privateKey)
  try {
    assert.equal(verifyProGrant(token, { publicKeyB64: signer.publicKeyB64, now,
      ...{ trustedContext: { subject: '11111111-1111-4111-8111-111111111111' } } }).ok, false,
    'new-source exp is strict; legacy 10 minute maxOfflineMs=0 grace must not apply')
    process.env.RIVET_HOME = home
    __setProGrantPublicKeyForTests(signer.publicKeyB64)
    writeFileSync(join(home, 'license.json'), JSON.stringify({ token, lastVerifiedAt: now }))
    delete process.env.RIVET_DESKTOP
    assert.equal(resolveProLicense(DEFAULT_CONFIG).enabled, false)
    process.env.RIVET_DESKTOP = '1'; process.env.RIVET_PRO_GRANT = token
    assert.equal(resolveProLicense(DEFAULT_CONFIG).enabled, false)
  } finally {
    __setProGrantPublicKeyForTests(null)
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
    Object.assign(process.env, old)
    rmSync(home, { recursive: true, force: true })
  }
})

import { createServer } from 'node:http'
import { createHmac, randomUUID, createPrivateKey, createPublicKey } from 'node:crypto'
import fs, { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { accountDeviceFingerprint } from '../account-device.js'
import { accountStore, checkDeviceOnce, saveAccountToken } from '../account.js'
import { createOfficialModelBroker, type OfficialIdentityRef } from '../official-model-auth.js'
import { createOfficialMembershipService } from '../official-membership-license.js'
import { OfficialError } from '../../models/official-contract.js'
import { createSecretCipher, decodeSecret, encodeSecret } from '../secure-store.js'
import { isProFeatureEnabled } from '../../config/pro-license.js'
import { startServer } from '../../server/index.js'
import { spawn } from 'node:child_process'

const ownerA = '11111111-1111-4111-8111-111111111111', ownerB = '22222222-2222-4222-8222-222222222222'
const device = 'fixture-device-12345', privateBridge = 'synthetic-native-only-capability-0000000000000000000000'
async function membershipFixture(nativeDevice?: string) {
  const device=nativeDevice ?? 'fixture-device-12345'
  const home = mkdtempSync(join(tmpdir(), 'membership-real-')), signer = makeTestSigner()
  if(nativeDevice){
    signer.privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,73)]),format:'der',type:'pkcs8'})
    signer.publicKeyB64=(createPublicKey(signer.privateKey).export({format:'der',type:'spki'}) as Buffer).subarray(-32).toString('base64')
  }
  const credentials = new Map<string, { subject: string; sid: string }>()
  const grants = new Map<string, { grant: string; expiresAt: string }>(), calls: string[] = []
  let deny = false, revision = '1', clock = Date.now(), beforeReply: ((rid: string) => Promise<void>) | undefined
  let responseFailure: undefined | { code: string; status: number; retryable: boolean }
  const server = createServer(async (req, res) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    const login = req.url?.endsWith('/tui-auth-check')
    if (!(login ? req.headers.apikey === 'synthetic-anon' : credentials.has(bearer))) { res.writeHead(401); res.end('{}'); return }
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (login) {
      const source = { subject: body.deviceCode === 'B' ? ownerB : ownerA, sid: randomUUID() }
      const first = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
      const second = Buffer.from(JSON.stringify({ sub: source.subject, session_id: source.sid, role: 'authenticated', type: 'access', exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url')
      const token = `${first}.${second}.${createHmac('sha256', 'synthetic-account-key').update(`${first}.${second}`).digest('base64url')}`
      credentials.set(token, source)
      res.end(JSON.stringify({ status: 'approved', accessToken: token, refreshToken: `synthetic-refresh-${source.sid}`, expiresIn: 3600 })); return
    }
    if (!req.url?.endsWith('/tui-model-membership-grant') || Object.keys(body).join() !== 'requestId') { res.writeHead(400); res.end('{}'); return }
    const rid = body.requestId as string, source = credentials.get(bearer)!
    calls.push(rid)
    const failure = responseFailure ?? (deny ? { code: 'entitlement_unavailable', status: 403, retryable: false } : undefined)
    if (!failure && !grants.has(rid)) {
      const claims = { product: 'tianshu-desktop', deviceId: device, tier: 'pro', source: 'official-membership', subject: source.subject, accountSessionId: source.sid, membershipRevision: revision, iat: clock, exp: clock + 60000, lic: clock + 86400000, maxOfflineMs: 0 }
      grants.set(rid, { grant: signGrant(claims, signer.privateKey), expiresAt: new Date(claims.exp).toISOString() })
    }
    await beforeReply?.(rid)
    res.writeHead(failure?.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: 1, requestId: rid, ...(failure ? { error: { code: failure.code, message: failure.code, retryable: failure.retryable } } : { data: grants.get(rid) }) }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const fetchImpl: typeof fetch = (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, 'https://membership-fixture.invalid'); return fetch(endpoint + url.pathname, init) }
  accountDeviceFingerprint(home, device)
  const broker = createOfficialModelBroker({ home, fetchImpl })
  const service = createOfficialMembershipService({ home, broker, publicKeyB64: signer.publicKeyB64, now: () => clock })
  const login = async (name = 'A') => {
    const store = accountStore(home), intent = store.beginLogin(device)
    saveAccountToken(store, await checkDeviceOnce(name, { fetchImpl }), { intent, deviceId: device })
    return broker.captureOfficialIdentity()!
  }
  return { home, signer, broker, service, login, calls, grants, fetchImpl,
    setDeny(v: boolean) { deny = v }, setClock(v: number) { clock = v }, getClock() { return clock },
    setFailure(v: typeof responseFailure) { responseFailure = v }, before(fn: typeof beforeReply) { beforeReply = fn },
    async close() { service.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(home, { recursive: true, force: true }) } }
}

test('official_membership_unlocks_real_feature_gate: signed owner, all features, zero-balance independence, strict expiry and legacy union', async () => {
  const f = await membershipFixture(), oldHome = process.env.RIVET_HOME
  try {
    process.env.RIVET_HOME = f.home; __setProGrantPublicKeyForTests(f.signer.publicKeyB64)
    assert.equal(isProFeatureEnabled(DEFAULT_CONFIG, 'teamMax'), false)
    const identity = await f.login()
    for (const tier of ['lite', 'pro', 'max']) {
      const result = await f.service.activate(identity, randomUUID())
      assert.ok(result.grant, tier)
      for (const feature of ['computerUse','chatGateway','teamMax','councilMultiRound','unattendedAutomation','spark'] as const) assert.equal(isProFeatureEnabled(DEFAULT_CONFIG, feature), true, `${tier}/${feature}`)
      const cfg = structuredClone(DEFAULT_CONFIG); cfg.pro = { ...cfg.pro!, features: { ...cfg.pro?.features, teamMax: false } }
      assert.equal(isProFeatureEnabled(cfg, 'teamMax'), false)
    }
    assert.equal(readFileSync(join(f.home, 'membership-license.json'),'utf8').includes('official-membership'), false)
    const observed = f.service.readCurrent()!
    f.setClock(Date.parse(observed.expiresAt)); assert.equal(f.service.readCurrent(), null)
    assert.equal(isProFeatureEnabled(DEFAULT_CONFIG, 'teamMax'), false, 'expired read removes the token, retaining its operation fence')
    const permanent = signGrant({ product: 'tianshu-desktop', deviceId: device, tier: 'pro', iat: Date.now(), exp: Date.now()+60000, lic: null }, f.signer.privateKey)
    writeFileSync(join(f.home,'license.json'), JSON.stringify({ token: permanent, lastVerifiedAt: 0 }))
    assert.equal(isProFeatureEnabled(DEFAULT_CONFIG,'teamMax'), true)
    accountStore(f.home).clearAccount(); f.service.clear()
    assert.equal(isProFeatureEnabled(DEFAULT_CONFIG,'teamMax'), true, 'logout never deletes independent legacy permission')
    assert.equal(readFileSync(join(f.home,'license.json'),'utf8').includes(permanent), true)
  } finally { __setProGrantPublicKeyForTests(null); process.env.RIVET_HOME = oldHome; await f.close() }
})

test('sealed authority rejects reconstructed refs and asynchronous current callbacks', async () => {
  const f = await membershipFixture()
  try {
    const identity = await f.login()
    assert.throws(() => f.broker.withCurrentOfficialIdentity({ ...identity }, () => true), /account_changed/)
    assert.throws(() => f.broker.withCurrentOfficialIdentity(identity, () => Promise.resolve(true)), /service_error/)
    assert.throws(() => f.broker.withCurrentOfficialIdentity(identity, () => ({ then() {} })), /service_error/)
    await f.service.activate(identity, randomUUID())
    const ciphertext = readFileSync(join(f.home,'membership-license.json'))
    await f.login('B'); assert.equal(f.service.readCurrent(), null)
    writeFileSync(join(f.home,'membership-license.json'),ciphertext); await f.login('A')
    assert.equal(f.service.readCurrent(), null, 'same subject re-login does not revive the previous SID/incarnation')
    await assert.rejects(f.service.activate(identity,randomUUID()),/account_changed/)
  } finally { await f.close() }
})

test('late same-owner success cannot replace a newer inactive operation; late failure cannot remove a newer grant', async () => {
  const f = await membershipFixture()
  try {
    const identity = await f.login(), otherBroker = createOfficialModelBroker({home:f.home,fetchImpl:f.fetchImpl}), otherIdentity=otherBroker.captureOfficialIdentity()!, other = createOfficialMembershipService({home:f.home,broker:otherBroker,publicKeyB64:f.signer.publicKeyB64,now:()=>f.getClock()})
    let release!:()=>void, entered!:()=>void
    const wait = new Promise<void>(r=>{entered=r}), hold = new Promise<void>(r=>{release=r}), oldRID=randomUUID()
    f.before(async rid=>{if(rid===oldRID){entered();await hold}})
    const old=f.service.activate(identity,oldRID); await wait
    await assert.rejects(other.activate(otherIdentity,randomUUID()),/service_error/, 'live operation cannot be replaced')
    f.setClock(f.getClock()+26000); f.setDeny(true)
    await assert.rejects(other.activate(otherIdentity,randomUUID()),/entitlement_unavailable/)
    release(); await assert.rejects(old,/account_changed/); assert.equal(other.readCurrent(),null)
    f.setDeny(false);f.before(undefined)
    await other.activate(otherIdentity,randomUUID())
    f.setFailure({code:'auth_required',status:401,retryable:false})
    const failedRID=randomUUID(), hold2=new Promise<void>(r=>{release=r}), wait2=new Promise<void>(r=>{entered=r})
    f.before(async rid=>{if(rid===failedRID){entered();await hold2}})
    const failed=f.service.activate(identity,failedRID); await wait2
    f.setClock(f.getClock()+26000); f.setFailure(undefined)
    const newer=await other.activate(otherIdentity,randomUUID())
    release();await assert.rejects(failed,/auth_required/)
    assert.equal(other.readCurrent()?.grant,newer.grant)
    other.dispose()
  } finally { await f.close() }
})

test('uncertain retry keeps request ID; actual private routes keep grants out of ordinary renderer access', async () => {
  const f=await membershipFixture()
  let http: Awaited<ReturnType<typeof startServer>>|undefined
  try {
    const routes=buildAccountRoutes({rivetHome:f.home,apiToken:'fixture-bearer',membership:f.service,membershipBridgeToken:privateBridge})
    http=await startServer(0,routes,'fixture-bearer',{membershipBridgeToken:privateBridge})
    const identity=await f.login()
    f.setFailure({code:'service_error',status:503,retryable:true})
    let count=0;f.before(async()=>{if(++count===1)f.setFailure(undefined)})
    const rid=randomUUID(); await f.service.activate(identity,rid)
    assert.deepEqual(f.calls,[rid,rid]);f.before(undefined)
    const url=`http://127.0.0.1:${http.port}`
    const denied=await fetch(url+'/account/activate-model-membership',{method:'POST',headers:{Authorization:'Bearer fixture-bearer'},body:'{invalid-json'})
    assert.equal(denied.status,401,'private auth precedes body parsing')
    const origin=await fetch(url+'/account/model-membership-current',{headers:{Authorization:'Bearer fixture-bearer','X-Tianshu-Membership-Bridge':privateBridge,Origin:'http://tauri.localhost'}})
    assert.equal(origin.status,401)
    const headers={Authorization:'Bearer fixture-bearer','X-Tianshu-Membership-Bridge':privateBridge,'Content-Type':'application/json'}
    const current=await fetch(url+'/account/model-membership-current',{headers});assert.equal(current.status,200)
    const got=await fetch(url+'/account/activate-model-membership',{method:'POST',headers,body:JSON.stringify({requestId:randomUUID()})})
    assert.equal(got.status,200);const data=await got.json() as {data:{grant:string;owner:{accountSessionId:string}}}
    assert.equal(data.data.owner.accountSessionId,identity.accountSessionId);assert.ok(data.data.grant)
    const extra=await fetch(url+'/account/activate-model-membership',{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),subject:ownerB})})
    assert.equal(extra.status,400)
  } finally { if(http){await new Promise<void>((resolve,reject)=>http!.close(e=>e?reject(e):resolve()))};await f.close() }
})


test('shared signed vectors deny generic promotion and match the dedicated signed schema', () => {
  const corpus=JSON.parse(readFileSync(new URL('./fixtures/official-membership-vectors.json',import.meta.url),'utf8'))
  for(const v of corpus.vectors){
    const sig=verifyGrantSignature(v.token,corpus.publicKeyB64)
    assert.equal(sig.ok && validateOfficialMembershipClaims(sig.claims,{now:v.now},corpus.owner).ok,v.valid,v.name)
    assert.equal(verifyProGrant(v.token,{publicKeyB64:corpus.publicKeyB64,now:v.now}).ok,false,`generic ${v.name}`)
  }
})
test('a real separate CLI process logout fences restart reads and an in-flight install', async () => {
  const f=await membershipFixture()
  try {
    const identity=await f.login();await f.service.activate(identity,randomUUID())
    const ciphertext=readFileSync(join(f.home,'membership-license.json'))
    const restarted=createOfficialMembershipService({home:f.home,publicKeyB64:f.signer.publicKeyB64,now:()=>f.getClock()})
    assert.ok(restarted.readCurrent(),'fresh broker may read the current sealed grant')
    let release!:()=>void,entered!:()=>void
    const held=new Promise<void>(r=>{release=r}),wait=new Promise<void>(r=>{entered=r})
    f.before(async()=>{entered();await held})
    const installing=f.service.activate(identity,randomUUID());await wait
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',"import {accountStore} from './src/auth/account.ts'; accountStore(process.env.RIVET_HOME).clearAccount()"],{env:{...process.env,RIVET_HOME:f.home},stdio:['ignore','pipe','pipe']})
    let errors='';child.stderr.on('data',c=>{errors+=c})
    assert.equal(await new Promise<number|null>(r=>child.on('close',r)),0,errors)
    assert.equal(restarted.readCurrent(),null)
    release();await assert.rejects(installing,/account_changed/)
    writeFileSync(join(f.home,'membership-license.json'),ciphertext)
    assert.equal(restarted.readCurrent(),null,'old ciphertext cannot restore a logged-out account')
    restarted.dispose()
  }finally{await f.close()}
})


// Private native-unit harness: actual HTTP routes, TokenStore, broker and service; no renderer/API control route.
if(process.env.R5B_NATIVE_FIXTURE === '1'){
  const {createInterface}=await import('node:readline')
  const f=await membershipFixture(process.env.R5B_NATIVE_DEVICE!)
  const routes=buildAccountRoutes({rivetHome:f.home,apiToken:'fixture-bearer',membership:f.service,membershipBridgeToken:privateBridge})
  const http=await startServer(0,routes,'fixture-bearer',{membershipBridgeToken:privateBridge})
  let identity=await f.login()
  process.stdout.write(JSON.stringify({home:f.home,port:http.port,bearer:'fixture-bearer',secret:privateBridge,publicKey:f.signer.publicKeyB64})+'\n')
  const lines=createInterface({input:process.stdin})
  for await(const line of lines){
    try{
      if(line==='activate') { f.setClock(Date.now());await f.service.activate(identity,randomUUID()) }
      if(line==='logout') { accountStore(f.home).clearAccount();f.service.clear() }
      if(line==='relogin') { identity=await f.login('B') }
      if(line==='expire') { f.setClock(f.getClock()+60000);f.service.readCurrent() }
      if(line==='legacy') {const token=signGrant({product:'tianshu-desktop',deviceId:process.env.R5B_NATIVE_DEVICE,tier:'pro',iat:Date.now(),exp:Date.now()+60000,lic:null},f.signer.privateKey);writeFileSync(join(f.home,'license.json'),JSON.stringify({token,lastVerifiedAt:Date.now()}))}
      if(line==='stop')break
      process.stdout.write(JSON.stringify({ok:true})+'\n')
    }catch{process.stdout.write(JSON.stringify({ok:false})+'\n')}
  }
  lines.close();await new Promise<void>(r=>http.close(()=>r()));await f.close()
}

test('first CLI refresh never follows a changed synthetic environment into another home', async t => {
  const f=await membershipFixture(), other=await membershipFixture(), env={...process.env}
  const originalRead=fs.readFileSync;let reads=0,requests=0
  try {
    const otherIdentity=await other.login();await other.service.activate(otherIdentity,randomUUID())
    const identity=await f.login();await f.service.activate(identity,randomUUID())
    t.mock.method(fs,'readFileSync',((...args:Parameters<typeof fs.readFileSync>)=>{if(String(args[0]).startsWith(f.home)||String(args[0]).startsWith(other.home))reads++;return Reflect.apply(originalRead,fs,args)}) as typeof fs.readFileSync);syncBuiltinESMExports()
    t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('unexpected refresh after environment replacement')})
    process.env.RIVET_HOME=f.home;delete process.env.RIVET_DESKTOP;__setProGrantPublicKeyForTests(f.signer.publicKeyB64)
    t.mock.timers.enable({apis:['setTimeout']})
    assert.equal(isProFeatureEnabled(DEFAULT_CONFIG,'teamMax'),true)
    const calls=f.calls.length, otherCalls=other.calls.length,baselineReads=reads,baselineRequests=requests
    process.env.RIVET_HOME=other.home
    t.mock.timers.tick(30000);await new Promise<void>(r=>setImmediate(r))
    assert.equal(f.calls.length,calls);assert.equal(other.calls.length,otherCalls)
    t.mock.timers.tick(60000);await new Promise<void>(r=>setImmediate(r))
    assert.equal(f.calls.length,calls);assert.equal(other.calls.length,otherCalls)
    assert.equal(reads,baselineReads,'timer never reads either synthetic account source after environment replacement')
    assert.equal(requests,baselineRequests,'timer sends no external request after environment replacement')
  }finally{t.mock.timers.reset();t.mock.restoreAll();syncBuiltinESMExports();__setProGrantPublicKeyForTests(null);for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);await f.close();await other.close()}
})
test('actual server close aborts only its owned refresh and preserves installed membership and sibling service', async () => {
  const f=await membershipFixture();let http:Awaited<ReturnType<typeof startServer>>|undefined
  try{
    const identity=await f.login();const installed=await f.service.activate(identity,randomUUID())
    const siblingBroker=createOfficialModelBroker({home:f.home,fetchImpl:f.fetchImpl})
    const sibling=createOfficialMembershipService({home:f.home,broker:siblingBroker,publicKeyB64:f.signer.publicKeyB64,now:()=>f.getClock()})
    http=await startServer(0,buildAccountRoutes({rivetHome:f.home,apiToken:'fixture-bearer',membership:f.service,membershipBridgeToken:privateBridge}),'fixture-bearer',{membershipBridgeToken:privateBridge})
    let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>{entered=r}),hold=new Promise<void>(r=>{release=r})
    f.before(async()=>{entered();await hold})
    const pending=f.service.activate(identity,randomUUID());const rejected=assert.rejects(pending,/account_changed|service_error/);await wait
    await new Promise<void>(r=>http!.close(()=>r()));http=undefined;await rejected;release();f.before(undefined)
    assert.equal(sibling.readCurrent()?.grant,installed.grant,'shutdown retains the independently valid installed grant')
    f.setClock(f.getClock()+26000)
    await sibling.activate(siblingBroker.captureOfficialIdentity()!,randomUUID())
    assert.ok(sibling.readCurrent(),'another service remains usable after owner shutdown');sibling.dispose()
  }finally{if(http)await new Promise<void>(r=>http!.close(()=>r()));await f.close()}
})

test('epoch clear, changed device, plaintext replay and backend fallback close only membership', async () => {
  const f=await membershipFixture(), backend=process.env.RIVET_TOKEN_STORE
  try{
    let identity=await f.login();const result=await f.service.activate(identity,randomUUID())
    const ciphertext=readFileSync(join(f.home,'membership-license.json'))
    await f.broker.clearOfficialAccess(identity);assert.equal(f.service.readCurrent(),null)
    writeFileSync(join(f.home,'membership-license.json'),ciphertext);assert.equal(f.service.readCurrent(),null)
    identity=f.broker.captureOfficialIdentity()!;await f.service.activate(identity,randomUUID())
    accountDeviceFingerprint(f.home,'different-fixture-device');assert.equal(f.service.readCurrent(),null)
    accountDeviceFingerprint(f.home,device)
    writeFileSync(join(f.home,'membership-license.json'),JSON.stringify({...result,owner:identity,epoch:0,version:1}))
    assert.equal(f.service.readCurrent(),null)
    process.env.RIVET_TOKEN_STORE='plaintext'
    await assert.rejects(f.service.activate(f.broker.captureOfficialIdentity()!,randomUUID()),/service_error|account_changed/)
    assert.doesNotThrow(()=>f.service.start(),'unavailable encrypted membership must not break normal server startup')
  }finally{process.env.RIVET_TOKEN_STORE=backend;await f.close()}
})


test('actual server survives unavailable membership backend and preserves independent legacy gate', async () => {
  const f=await membershipFixture(), old={...process.env}
  let http:Awaited<ReturnType<typeof startServer>>|undefined
  try {
    const identity=await f.login();await f.service.activate(identity,randomUUID())
    process.env.RIVET_HOME=f.home;process.env.RIVET_DESKTOP='1';process.env.RIVET_TOKEN_STORE='plaintext'
    delete process.env.RIVET_PRO_GRANT;__setProGrantPublicKeyForTests(f.signer.publicKeyB64)
    http=await startServer(0,buildAccountRoutes({rivetHome:f.home,apiToken:'fixture-bearer'}),'fixture-bearer')
    const result=await fetch(`http://127.0.0.1:${http.port}/account/model-membership-current`,{headers:{Authorization:'Bearer fixture-bearer'}})
    assert.equal(result.status,401,'normal server remains responsive and private authentication stays enforced')
    assert.equal(isProFeatureEnabled(DEFAULT_CONFIG,'teamMax'),false)
    const legacy=signGrant({product:'tianshu-desktop',deviceId:device,tier:'pro',iat:Date.now(),exp:Date.now()+60000,lic:null},f.signer.privateKey)
    writeFileSync(join(f.home,'license.json'),JSON.stringify({token:legacy,lastVerifiedAt:Date.now()}))
    process.env.RIVET_PRO_GRANT=legacy
    assert.equal(isProFeatureEnabled(DEFAULT_CONFIG,'teamMax'),true,'independent legacy permission remains usable')
    rmSync(join(f.home,'license.json'))
    assert.equal(isProFeatureEnabled(DEFAULT_CONFIG,'teamMax'),false,'removing the retained legacy license still revokes desktop access')
    await new Promise<void>((resolve,reject)=>http!.close(e=>e?reject(e):resolve()));http=undefined
  }finally{
    if(http)await new Promise<void>(r=>http!.close(()=>r()))
    __setProGrantPublicKeyForTests(null);for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);await f.close()
  }
})

async function deniedRefreshFixture(run: (f: { service: ReturnType<typeof createOfficialMembershipService>; restart: () => void; forgetDenialReason: () => void; allow: () => void; denySource: () => void; advance: () => Promise<void>; calls: () => number }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'membership-denied-refresh-'))
  const signer = makeTestSigner(), previousBackend = process.env.RIVET_TOKEN_STORE
  const previousSet = globalThis.setTimeout, previousClear = globalThis.clearTimeout
  const scheduled = new Map<object, () => void>()
  let clock = Date.now(), calls = 0, failure: 'entitlement_unavailable' | 'auth_required' | null = 'entitlement_unavailable'
  const identity: OfficialIdentityRef = { subject: ownerA, accountSessionId: randomUUID(), deviceId: device, generation: 1, incarnation: randomUUID() }
  const broker = {
    captureOfficialIdentity: () => identity,
    withCurrentOfficialIdentity: <T>(own: typeof identity, callback: (epoch: number) => T): T => { assert.equal(own, identity); return callback(1) },
    async requestOfficialMembershipGrant(own: typeof identity, _requestId: string) {
      assert.equal(own, identity); calls++
      if (failure) throw new OfficialError(failure, failure === 'auth_required' ? 401 : 403, false)
      const grant = signGrant({ product: 'tianshu-desktop', deviceId: device, tier: 'pro', source: 'official-membership', subject: identity.subject, accountSessionId: identity.accountSessionId, membershipRevision: '2', iat: clock, exp: clock + 60000, lic: clock + 86400000, maxOfflineMs: 0 }, signer.privateKey)
      return { grant, expiresAt: new Date(clock + 60000).toISOString() }
    },
  }
  const create = () => createOfficialMembershipService({ home, broker, publicKeyB64: signer.publicKeyB64, now: () => clock })
  let service: ReturnType<typeof createOfficialMembershipService>
  try {
    process.env.RIVET_TOKEN_STORE = 'local-key'
    globalThis.setTimeout = ((callback: () => void, _ms: number) => { const timer = { unref() { return timer } }; scheduled.set(timer, callback); return timer }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((timer: object) => { scheduled.delete(timer) }) as unknown as typeof clearTimeout
    service = create()
    const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
    const control = {
      get service() { return service },
      restart() { service.dispose(); service = create(); service.start() },
      forgetDenialReason() {
        const file = join(home, 'membership-license.json'), cipher = createSecretCipher(home, 'local-key')
        const legacy = JSON.parse(decodeSecret(cipher, readFileSync(file, 'utf8'))!)
        delete legacy.operation.denialCode; delete legacy.operation.retryAt
        writeFileSync(file, encodeSecret(cipher, JSON.stringify(legacy)))
      },
      allow() { failure = null }, denySource() { failure = 'auth_required' }, calls: () => calls,
      async advance() { clock += 30000; const entry = scheduled.entries().next().value; assert.ok(entry, 'bounded background timer exists'); scheduled.delete(entry[0]); entry[1](); await settle() },
    }
    service.start(); await settle()
    await run(control)
  } finally {
    service!?.dispose()
    globalThis.setTimeout = previousSet; globalThis.clearTimeout = previousClear
    if (previousBackend === undefined) delete process.env.RIVET_TOKEN_STORE; else process.env.RIVET_TOKEN_STORE = previousBackend
    rmSync(home, { recursive: true, force: true })
  }
}

test('CLI same-owner membership absence recovers after purchase through its bounded background timer', async () => {
  await deniedRefreshFixture(async f => {
    assert.equal(f.calls(), 1); assert.equal(f.service.readCurrent(), null)
    f.allow(); await f.advance()
    assert.equal(f.calls(), 2, 'current no-membership observation cannot permanently suppress later purchases')
    assert.ok(f.service.readCurrent()?.grant, 'actual signed grant is verified and stored without manual activation')
  })
})

test('CLI persisted no-membership observation can recover a same-owner renewal after restart', async () => {
  await deniedRefreshFixture(async f => {
    assert.equal(f.calls(), 1)
    await f.advance(); f.allow(); f.restart()
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await f.advance()
    assert.ok(f.service.readCurrent()?.grant, 'restart must not make temporary membership absence permanent')
  })
})

test('CLI source authentication denial remains suppressed under the same source', async () => {
  await deniedRefreshFixture(async f => {
    f.denySource(); await f.service.activate(f.service.captureIdentity()!, randomUUID()).catch(() => {})
    const before = f.calls(); f.allow()
    for (let i = 0; i < 3; i++) await f.advance()
    assert.equal(f.calls(), before, 'invalid source needs reauthentication rather than automatic grant requests')
    assert.equal(f.service.readCurrent(), null)
  })
})

test('CLI older encrypted denied records without a reason allow a bounded fresh membership probe', async () => {
  await deniedRefreshFixture(async f => {
    assert.equal(f.calls(), 1)
    f.forgetDenialReason(); f.allow(); await f.advance()
    assert.equal(f.calls(), 2)
    assert.ok(f.service.readCurrent()?.grant, 'existing users are not stuck in the prior denied schema')
  })
})

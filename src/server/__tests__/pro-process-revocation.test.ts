import { it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '../index.js'
import { createRoutes } from '../routes.js'
import { runWorkerSessionOop } from '../../agent/worker-process/parent.js'
import type { WorkerSessionConfig } from '../../agent/worker-session.js'
import { buildGrantPayload, makeTestSigner, signGrant } from '../../config/__tests__/grant-fixtures.js'
import { ToolRegistry } from '../../tools/registry.js'
import { __setProGrantPublicKeyForTests } from '../../config/pro-license.js'
import { withProviderRequirement } from '../../api/execution-continuity.js'
import { proModulePresent } from '../../api/pro-registry.js'
import type { ExecutionBackend } from '../execution-backend.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'

// Public builds omit the isolated backend; a present but broken module must still fail.
it('native deny ACK covers an existing detached worker, startup replay and missing child ACK', { timeout: 30000, skip: !proModulePresent() && 'closed-source Pro modules are not distributed in public builds' }, async () => {
  const { createIsolatedBackend } = await import(new URL('../../pro/runtime/backend.js', import.meta.url).href) as {
    createIsolatedBackend(options: { engineEntry: string }): ExecutionBackend
  }
  const home = mkdtempSync(join(tmpdir(), 'managed-pro-denial-'))
  const saved = new Map(['RIVET_HOME', 'RIVET_DESKTOP', 'RIVET_PRO_GRANT', 'RIVET_PRO_DEVICE_ID'].map(key => [key, process.env[key]]))
  const signer = makeTestSigner()
  const deviceId = 'synthetic-device-managed'
  const grant = signGrant(buildGrantPayload({ deviceId }), signer.privateKey)
  __setProGrantPublicKeyForTests(signer.publicKeyB64)
  Object.assign(process.env, { RIVET_HOME: home, RIVET_DESKTOP: '1', RIVET_PRO_GRANT: grant, RIVET_PRO_DEVICE_ID: deviceId })
  const replay = () => writeFileSync(join(home, 'license.json'), JSON.stringify({ token: grant, lastVerifiedAt: Date.now() }))
  replay()
  let sends = 0
  const upstream = createServer((_request, response) => {
    sends++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address() as { port: number }
  const base = new URL('../../', import.meta.url)
  const fixture = join(home, 'worker.mjs')
  writeFileSync(fixture, `
import { createInterface } from 'node:readline';
import { __setProGrantPublicKeyForTests, denyRuntimeProAuthorization } from ${JSON.stringify(new URL('config/pro-license.ts', base).href)};
import { acknowledgeManagedProDenial, withManagedProAuthorization } from ${JSON.stringify(new URL('api/managed-pro-authorization.ts', base).href)};
import { runWorkerSessionOop } from ${JSON.stringify(new URL('agent/worker-process/parent.ts', base).href)};
import { ToolRegistry } from ${JSON.stringify(new URL('tools/registry.ts', base).href)};
import { OpenAIClient } from ${JSON.stringify(new URL('api/openai-client.ts', base).href)};
__setProGrantPublicKeyForTests(${JSON.stringify(signer.publicKeyB64)});
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let init, ignore=false, nested, releaseNested;
const lines = createInterface({input:process.stdin});
lines.on('line', async line => {
 const message=JSON.parse(line);
 if(message.t==='pro-deny' && !ignore) await acknowledgeManagedProDenial(()=>send({t:'pro-denied',id:message.id}));
 if(message.t==='init') {
  init=message.payload; ignore=init.config.order.id==='no-ack'; if(init.proAuthorization?.denied) await denyRuntimeProAuthorization();
  if(init.config.order.id==='existing') {
   let ready; const started=new Promise(resolve=>ready=resolve); let release=false;
   const config={...init.config,order:{id:'nested',objective:'synthetic'},toolRegistry:new ToolRegistry(),onActivity:()=>ready(),onSteerDrain:()=>{if(!release)return null;release=false;return 'probe'}};
   nested=withManagedProAuthorization(init.proAuthorization,()=>runWorkerSessionOop(config,{getMemoryBlock:()=>undefined,stallMsOverride:10000,entryOverride:{execArgs:process.execArgv,script:process.argv[1]}}));
   releaseNested=()=>{release=true;config.onSteerDrain?.()}; await started;
  }
  send({t:'activity',kind:'thinking',detail:'ready'});
  if(ignore) send({t:'result',run:{result:{status:'completed',summary:'unconfirmed process still alive'},messages:[],transcript:{},usage:{}}});
 }
 if(message.t==='steer') {
  if(nested) { releaseNested(); const result=await nested; if(!JSON.parse(result.result.summary).denied) throw Error('nested paid request escaped'); }
  const options={baseUrl:'http://127.0.0.1:${address.port}/v1',apiKey:'synthetic-key',model:'synthetic-model',maxTokens:16,maxRetries:0,thinking:'disabled'};
  const callbacks={onTextDelta(){},onThinkingDelta(){},onContentBlock(){},onStopReason(){},onError(){}};
  const request={messages:[{role:'user',content:'synthetic task'}],model:'synthetic-model',max_tokens:16};
  let denied=false;
  try { await withManagedProAuthorization(init.proAuthorization,()=>new OpenAIClient({...options,providerName:['existing','nested'].includes(init.config.order.id)?'deepseek':'deepseek-spark'}).stream(request,callbacks)); } catch(error) { if(error.name!=='ProAuthorizationError') throw error; denied=true; }
  await new OpenAIClient({...options,providerName:'deepseek'}).stream(request,callbacks);
  send({t:'result',run:{result:{status:'completed',summary:JSON.stringify({denied})},messages:[],transcript:{},usage:{}}});
  await acknowledgeManagedProDenial(()=>send({t:'pro-drained'})); process.stdout.end(()=>process.exit(0));
 }
 if(message.t==='abort') process.exit(0);
});
`)
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const engineFixture = join(home, 'engine.ts')
  writeFileSync(engineFixture, `
import { __setProGrantPublicKeyForTests } from ${JSON.stringify(new URL('config/pro-license.ts', base).href)};
import { acknowledgeManagedProDenial, withManagedProAuthorization } from ${JSON.stringify(new URL('api/managed-pro-authorization.ts', base).href)};
import { OpenAIClient } from ${JSON.stringify(new URL('api/openai-client.ts', base).href)};
__setProGrantPublicKeyForTests(${JSON.stringify(signer.publicKeyB64)});
let initial, release;
process.on('message',async frame=>{
 const send=value=>process.send({...frame,...value});
 if(frame.type==='pro-deny') { await acknowledgeManagedProDenial(()=>send({type:'pro-denied'})); return; }
 if(frame.type==='init') { initial=frame.proAuthorization; send({type:'result',value:true}); return; }
 if(frame.method==='setReasoningEffort') { release?.(); send({type:'result',value:true}); return; }
 if(frame.method==='run') {
  const gate=new Promise(resolve=>release=resolve);
  send({type:'callback',id:'ready',method:'onText',args:['ready']}); await gate;
  let denied=false;
  try { await withManagedProAuthorization(initial,()=>new OpenAIClient({baseUrl:'http://127.0.0.1:${address.port}/v1',providerName:'deepseek',apiKey:'synthetic-key',model:'synthetic-model',maxTokens:16,maxRetries:0,thinking:'disabled'}).stream({messages:[{role:'user',content:'synthetic'}],model:'synthetic-model',max_tokens:16},{onTextDelta(){},onThinkingDelta(){},onContentBlock(){},onStopReason(){},onError(){}})); } catch(error) { if(error.name!=='ProAuthorizationError') throw error; denied=true; }
  send({type:'result',value:{denied}});
 }
});
process.on('disconnect',()=>process.exit(0));
`)
  const backend = createIsolatedBackend({ engineEntry: engineFixture })
  const api = await startServer(0, createRoutes({ running: true, apiToken: 'synthetic-managed-api' }), 'synthetic-managed-api')
  const revoke = () => fetch(`http://127.0.0.1:${api.port}/runtime/pro-deny`, { method: 'POST', headers: { authorization: 'Bearer synthetic-managed-api' } })
  const children: ReturnType<typeof spawn>[] = []
  function worker(id: string) {
    let release = false
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const config = {
      order: { id, objective: 'synthetic task' }, cwd: home, maxTurns: 1, contextWindow: 8192, compact: { enabled: false, model: 'synthetic-model' },
      runtimeDecision: { isWrite: false }, toolRegistry: new ToolRegistry(), onActivity: () => ready(),
      onSteerDrain: () => { if (!release) return null; release = false; return 'probe' },
    } as unknown as WorkerSessionConfig
    const result = runWorkerSessionOop(config, {
      getMemoryBlock: () => undefined, stallMsOverride: 10000, entryOverride: { execArgs: ['--import', loader], script: fixture },
      spawnOverride: (args, script) => {
        const child = spawn(process.execPath, [...args, script], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: process.env })
        children.push(child)
        return child
      },
    })
    return { started, result, release: () => { release = true; config.onSteerDrain?.() } }
  }
  try {
    const engine = await withProviderRequirement('deepseek-spark', () => backend.createAgent(home, 'synthetic-engine', undefined, undefined, undefined))
    let engineReady!: () => void
    const engineStarted = new Promise<void>(resolve => { engineReady = resolve })
    const engineResult = engine.run('synthetic', { onText: () => engineReady() } as unknown as AgentCallbacks)
    void engineResult.catch(() => {})
    await engineStarted
    const existing = withProviderRequirement('deepseek-spark', () => worker('existing'))
    await existing.started
    const racing = worker('racing')
    assert.equal((await revoke()).status, 200)
    replay()
    engine.setReasoningEffort?.('low')
    assert.deepEqual(await engineResult, { denied: true })
    existing.release()
    await racing.started
    racing.release()
    assert.deepEqual(JSON.parse((await existing.result).result.summary), { denied: true })
    assert.deepEqual(JSON.parse((await racing.result).result.summary), { denied: true })
    assert.equal(sends, 3)
    const starting = worker('starting')
    replay()
    await starting.started
    starting.release()
    assert.deepEqual(JSON.parse((await starting.result).result.summary), { denied: true })
    assert.equal(sends, 4)
    const unresponsive = worker('no-ack')
    await unresponsive.started
    assert.equal((await unresponsive.result).result.status, 'completed')
    assert.notEqual((await revoke()).status, 200)
  } finally {
    await backend.close().catch(() => {})
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
    await new Promise<void>(resolve => api.close(() => resolve()))
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    __setProGrantPublicKeyForTests(null)
    rmSync(home, { recursive: true, force: true })
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUpdateRestartRoutes } from '../update-restart-routes.js'
const headers = {authorization:'Bearer test-update-token'}
function fixture() { let busy=true, cancelled=0;const routes=buildUpdateRestartRoutes({updateRestartActivity:()=>({sessions:busy?1:0,tasks:1}),prepareUpdateRestart:async(force,signal)=>{signal.throwIfAborted();if(busy&&!force)throw new Error('UPDATE_BUSY')},cancelUpdateRestart:()=>{cancelled++}},'test-update-token');return {routes,getCancelled:()=>cancelled} }
test('update preparation endpoints require authentication',async()=>{const {routes}=fixture();const r=await routes['POST /runtime/update-prepare']!({}, {}, {} as any);assert.equal(r.status,401)})
test('busy preparation rejects without force, force succeeds and cancellation unlocks',async()=>{const {routes,getCancelled}=fixture();assert.equal((await routes['POST /runtime/update-prepare']!({}, {}, headers)).status,409);assert.equal((await routes['POST /runtime/update-prepare']!({force:true}, {}, headers)).status,200);assert.equal((await routes['POST /runtime/update-prepare']!({force:true}, {}, headers)).status,409);assert.equal((await routes['POST /runtime/update-cancel']!({}, {}, headers)).status,200);assert.ok(getCancelled()>0)})
test('busy timeout maps to 409 with its own code, not the save-failure bucket',async()=>{const routes=buildUpdateRestartRoutes({updateRestartActivity:()=>({sessions:1,tasks:0}),prepareUpdateRestart:async()=>{throw new Error('UPDATE_BUSY_TIMEOUT')},cancelUpdateRestart:()=>{}},'test-update-token');const r=await routes['POST /runtime/update-prepare']!({}, {}, headers);assert.equal(r.status,409);assert.equal((r.body as {error:string}).error,'UPDATE_BUSY_TIMEOUT')})
test('allowUnsaved flag reaches the manager and save failures report failedSessions',async()=>{let seen:unknown;const routes=buildUpdateRestartRoutes({updateRestartActivity:()=>({sessions:0,tasks:0,failedSessions:2}),prepareUpdateRestart:async(_f,_s,opts)=>{seen=opts},cancelUpdateRestart:()=>{}},'test-update-token');const r=await routes['POST /runtime/update-prepare']!({allowUnsaved:true}, {}, headers);assert.equal(r.status,200);assert.deepEqual(seen,{allowUnsaved:true})})

test('save diagnostics carry the stage, retryability and pending event count', async () => {
  const routes = buildUpdateRestartRoutes({ updateRestartActivity: () => ({ sessions: 0, tasks: 0, failedSessions: 2, pendingEvents: 7 }),
    prepareUpdateRestart: async () => { throw new Error('UPDATE_PERSISTENCE_FAILED') }, cancelUpdateRestart: () => {} }, 'test-update-token')
  const result = await routes['POST /runtime/update-prepare']!({}, {}, headers)
  assert.equal(result.status, 503)
  assert.deepEqual(result.body, { error: 'UPDATE_SAVE_FAILED', stage: 'runtime_save', retryable: true, sessions: 0, tasks: 0, failedSessions: 2, pendingEvents: 7 })
})

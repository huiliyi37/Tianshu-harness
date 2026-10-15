import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {configSchema} from '../../config/schema.js'
import {TokenLedgerService} from '../service.js'
import {readTokenLedgerSettings} from '../settings.js'

const roots:string[]=[]
after(()=>roots.forEach(root=>rmSync(root,{recursive:true,force:true})))
const time=Date.parse('2026-10-14T01:05:00.000Z')
async function pages(){const module=await import('../snapshot-pages.js').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error});assert.equal(typeof (module as {snapshotPages?:unknown}).snapshotPages,'function');return (module as typeof import('../snapshot-pages.js')).snapshotPages}
function snapshot(count=3001){return {version:2 as const,deviceId:'synthetic',deviceName:'test',sentAt:new Date(time).toISOString(),totals:{requests:count,input:count,output:0,cacheRead:0,cacheCreate:0,cost:0},days:[],hours:Array.from({length:count},(_,index)=>({hour:new Date(time-index*3600000).toISOString().slice(0,13)+':00:00.000Z',model:'test',provider:'test',input:1,output:0}))}}
function fixture(count=3001,extra:Record<string,unknown>={}){
  const root=mkdtempSync(join(tmpdir(),'hour-pages-'));roots.push(root);const sessionsRoot=join(root,'sessions'),directory=join(sessionsRoot,'project','session');mkdirSync(directory,{recursive:true})
  writeFileSync(join(directory,'cache-log.jsonl'),Array.from({length:count},(_,index)=>JSON.stringify({t:time-index*3600000,turn:index,model:'test',provider:'test',input:1,output:0,cacheRead:0,cacheCreate:0})).join('\n')+'\n')
  const config=configSchema.parse({provider:{default:'test',providers:{}},tokenLedger:{forum:{apiKey:'synthetic-key',endpoint:'https://ledger.example.com/v1/token-usage',...extra}}})
  return {root,config,file:join(directory,'cache-log.jsonl'),create:(fetchImpl:any)=>new TokenLedgerService(config,{sessionsRoot,statePath:join(root,'ledger.json'),now:()=>time+1000,fetchImpl})}
}
test('3001 hours are split without dropping or duplicating any bucket',async()=>{
  const split=await pages(),value=snapshot(),result=split(value)
  assert.equal(result.length,2);assert.equal(result.flatMap(page=>page.hours||[]).length,3001)
  assert.equal(new Set(result.flatMap(page=>(page.hours||[]).map(record=>record.hour))).size,3001)
  assert(result.every(page=>(page.hours?.length||0)<=3000&&Buffer.byteLength(JSON.stringify(page))<=2000000))
  assert(result.every(page=>page.totals.input===3001))
})
test('UTF-8 body bounds and 2001 daily buckets are enforced without truncation',async()=>{
  const split=await pages(),value:any=snapshot(7000);value.hours=value.hours.map((record:any)=>({...record,model:'鲸'.repeat(128),provider:'鱼'.repeat(128)}))
  value.days=Array.from({length:2001},(_,index)=>({date:'2026-10-14',model:'day-'+index,requests:1,input:1,output:0,cacheRead:0,cacheCreate:0,cost:0}))
  const result=split(value);assert(result.length>2);assert.equal(result.flatMap(page=>page.hours||[]).length,7000);assert.equal(result.flatMap(page=>page.days).length,2001)
  assert(result.every(page=>page.days.length<=2000&&(page.hours?.length||0)<=3000&&Buffer.byteLength(JSON.stringify(page))<=2000000))
})
test('hourly service posts version2 on the existing endpoint with complete coverage',async()=>{
  const f=fixture(1),calls:any[]=[],service=f.create(async(url:string,init:any)=>{calls.push({url,body:JSON.parse(init.body)});return {status:200,text:async()=>'{"ok":true,"stale":false}'}})
  const result=await service.syncNow();assert.equal(result.ok,true);assert.equal(calls[0]?.body.version,2);assert.equal(calls[0]?.body.hours[0]?.input,1)
  assert.equal(calls[0]?.url,'https://ledger.example.com/v1/token-usage');assert.equal(service.status().hourlyCoverage.state,'complete');assert.equal(service.status().pending,false)
})
test('failed second page remains pending and resumes after restart with fresh send timestamps',async()=>{
  const f=fixture(),calls:any[]=[];let failing=true
  const fetch=async(_url:string,init:any)=>{const body=JSON.parse(init.body);calls.push(body);return {status:failing&&calls.length>1?400:200,text:async()=>'{"ok":true,"stale":false}'}}
  const first=f.create(fetch);assert.equal((await first.syncNow()).ok,false);assert.equal(first.status().pending,true);assert.equal(first.status().syncProgress?.nextPage,1)
  failing=false;const restored=f.create(fetch);assert.equal((await restored.syncNow()).ok,true);assert.equal(restored.status().pending,false)
  assert.equal(calls.length,3);assert.equal(calls[0].hours.length,3000);assert.equal(calls[2].hours.length,1);assert(Date.parse(calls[2].sentAt)>Date.parse(calls[1].sentAt))
})
test('a configuration change fences off all following pages and never acknowledges the old target',async()=>{
  const f=fixture(),calls:any[]=[];let service:TokenLedgerService
  service=f.create(async(url:string,init:any)=>{calls.push(JSON.parse(init.body));service.reconfigure(configSchema.parse({...f.config,tokenLedger:{...f.config.tokenLedger,forum:{...f.config.tokenLedger.forum,apiKey:'new-synthetic-key'}}}));return {status:200,text:async()=>'{"ok":true,"stale":false}'}})
  assert.equal((await service.syncNow()).ok,false);assert.equal(calls.length,1);assert.equal(service.status().pending,true)
})
test('default auto-sync interval is one minute while explicit preferences and opt-out are preserved',async()=>{
  const f=fixture(1),calls:any[]=[];const service=f.create(async()=>{calls.push(1);return {status:200,text:async()=>'{"ok":true,"stale":false}'}})
  assert.equal(readTokenLedgerSettings(f.config).forum.intervalMinutes,1)
  const explicit=configSchema.parse({...f.config,tokenLedger:{...f.config.tokenLedger,forum:{...f.config.tokenLedger.forum,intervalMinutes:45}}})
  assert.equal(readTokenLedgerSettings(explicit).forum.intervalMinutes,45);assert.equal(service.startAutoSync(),false);await service.shutdownFlush();assert.equal(calls.length,0)
})
test('unknown accepted response retries the same counters with a fresh monotonic timestamp',async()=>{
  const f=fixture(1),calls:any[]=[]
  const service=f.create(async(_url:string,init:any)=>{calls.push(JSON.parse(init.body));if(calls.length===1)throw new Error('synthetic response lost');return {status:200,text:async()=>'{"ok":true,"stale":false}'}})
  assert.equal((await service.syncNow()).ok,true);assert.equal(calls.length,2)
  assert.deepEqual(calls[0].hours,calls[1].hours);assert(Date.parse(calls[1].sentAt)>Date.parse(calls[0].sentAt));assert.equal(service.status().pending,false)
})
test('active fixed batches complete under continuous local consumption and keep newer usage pending',async()=>{
  const f=fixture(),calls:any[]=[];let service:TokenLedgerService
  service=f.create(async(_url:string,init:any)=>{calls.push(JSON.parse(init.body));appendFileSync(f.file,JSON.stringify({t:time,turn:10000+calls.length,model:'test',provider:'test',input:7,output:0,cacheRead:0,cacheCreate:0})+'\n');await service.refresh();return {status:200,text:async()=>'{"ok":true,"stale":false}'}})
  assert.equal((await service.syncNow()).ok,true);assert.equal(calls.length,2);assert.equal(service.status().pending,true);assert.equal(service.status().syncProgress,null)
  assert(calls[0].hours.some((row:any)=>row.hour==='2026-10-14T01:00:00.000Z'))
})
test('failed batches resume confirmed progress despite newly accumulated usage',async()=>{
  const f=fixture(6001),firstHours:string[]=[];let calls=0
  const service=f.create(async(_url:string,init:any)=>{const body=JSON.parse(init.body);calls++;if(calls===1)firstHours.push(body.hours[0].hour);return {status:calls===1?200:400,text:async()=>'{"ok":true,"stale":false}'}})
  for(let round=0;round<3;round++){calls=0;const result=await service.syncNow();assert.equal(result.ok,round===2);appendFileSync(f.file,JSON.stringify({t:time,turn:20000+round,model:'test',provider:'test',input:1,output:0,cacheRead:0,cacheCreate:0})+'\n')}
  assert.equal(new Set(firstHours).size,3)
})
test('newest hours are prioritized even when the input is oldest first',async()=>{
  const split=await pages(),value=snapshot(6001);value.hours.reverse();const result=split(value)
  assert.equal(result[0]?.hours?.[0]?.hour,'2026-10-14T01:00:00.000Z')
})

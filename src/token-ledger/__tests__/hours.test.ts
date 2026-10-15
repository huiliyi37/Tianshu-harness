import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,unlinkSync,truncateSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {TokenLedgerStore} from '../store.js'

const roots:string[]=[]
after(()=>roots.forEach(root=>rmSync(root,{recursive:true,force:true})))
const time=Date.parse('2026-10-14T01:05:00.000Z')
const row=(over:Record<string,unknown>={})=>JSON.stringify({t:time,turn:1,model:'test',provider:'test',input:100,output:10,cacheRead:80,cacheCreate:0,...over})
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'hour-ledger-'));roots.push(root)
  const sessionsRoot=join(root,'sessions'),statePath=join(root,'state.json'),directory=join(sessionsRoot,'project','session')
  mkdirSync(directory,{recursive:true});const file=join(directory,'cache-log.jsonl')
  const store=()=>new TokenLedgerStore({sessionsRoot,statePath,now:()=>time+10000000})
  return {root,file,statePath,store,write:(values:string[])=>writeFileSync(file,values.join('\n')+'\n')}
}
function legacy(path:string){const state=JSON.parse(readFileSync(path,'utf8'));delete state.hours;delete state.hourlyMigration;writeFileSync(path,JSON.stringify(state));return state}

test('hours use UTC timestamps and cache-inclusive input exactly once',async()=>{
  const f=fixture();f.write([row(),row({t:time+3600000,input:20,output:0,cacheRead:0})]);const store=f.store();await store.refresh()
  assert.equal(typeof store.hourRecords,'function')
  assert.deepEqual(store.hourRecords().map(record=>[record.hour,record.input+record.output]),[['2026-10-14T01:00:00.000Z',110],['2026-10-14T02:00:00.000Z',20]])
  assert.equal(store.totals().input,120);assert.equal(store.hourlyCoverage().state,'complete')
})
test('UTC buckets do not depend on the computer timezone',async()=>{
  const hours=await import('../hours.js').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error})
  assert.equal(typeof (hours as {utcHour?:unknown}).utcHour,'function')
  const module=new URL('../hours.ts',import.meta.url).href
  const values=['UTC','Asia/Shanghai','America/New_York'].map(TZ=>execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {utcHour} from ${JSON.stringify(module)};process.stdout.write(utcHour(${time}));`],{env:{...process.env,TZ},encoding:'utf8'}))
  assert.deepEqual(values,['2026-10-14T01:00:00.000Z','2026-10-14T01:00:00.000Z','2026-10-14T01:00:00.000Z'])
})
test('legacy consumed logs backfill hours without increasing daily usage or changing identity',async()=>{
  const f=fixture();f.write([row(),row({input:20,output:0,cacheRead:0})]);const old=f.store();await old.refresh();const before=legacy(f.statePath)
  const store=f.store();await store.refresh();await store.refresh();await f.store().refresh()
  assert.equal(typeof store.hourRecords,'function');assert.equal(store.deviceId,before.deviceId)
  assert.equal(store.totals().input,120);assert.equal(store.hourRecords()[0]?.input,120)
  assert.equal(JSON.parse(readFileSync(f.statePath,'utf8')).days[Object.keys(before.days)[0]!].test?.input??store.totals().input,120)
})
test('legacy duplicate attempts are backfilled only once and new append still increments',async()=>{
  const f=fixture(),attempt=row({requestId:'request',attemptId:'attempt',event:'stream_attempt_aborted'})
  f.write([attempt,attempt]);const original=f.store();await original.refresh();legacy(f.statePath)
  const store=f.store();await store.refresh();appendFileSync(f.file,attempt+'\n'+row({t:time+3600000,input:7,output:0,cacheRead:0})+'\n');await store.refresh()
  assert.equal(typeof store.hourRecords,'function');assert.equal(store.hourRecords().reduce((sum,item)=>sum+item.input,0),107)
  assert.equal(store.totals().input,107)
})
test('missing and truncated consumed logs are partial and never synthesized from daily totals',async()=>{
  for(const missing of [true,false]){const f=fixture();f.write([row(),row()]);await f.store().refresh();legacy(f.statePath);if(missing)unlinkSync(f.file);else truncateSync(f.file,4)
    const store=f.store();await store.refresh();assert.equal(typeof store.hourRecords,'function');assert.deepEqual(store.hourRecords(),[]);assert.equal(store.hourlyCoverage().state,'partial');assert.equal(store.totals().input,200)
  }
})
test('two store instances share atomic hours and consumption cursors',async()=>{
  const f=fixture();f.write([row()]);const first=f.store(),second=f.store();await Promise.all([first.refresh(),second.refresh()]);const restored=f.store()
  assert.equal(typeof restored.hourRecords,'function');assert.equal(restored.hourRecords()[0]?.input,100);assert.equal(restored.totals().input,100)
  appendFileSync(f.file,row({input:5,output:0,cacheRead:0})+'\n');await Promise.all([first.refresh(),second.refresh()]);assert.equal(f.store().hourRecords()[0]?.input,105)
})
test('unsafe hour totals abort the whole transaction without publishing daily increments',async()=>{
  const f=fixture();f.write([row({input:Number.MAX_SAFE_INTEGER,output:0,cacheRead:0}),row({input:1,output:0,cacheRead:0})]);const store=f.store()
  await assert.rejects(store.refresh(),/safe integer/)
  assert.equal(f.store().totals().input,0);assert.deepEqual(f.store().hourRecords(),[])
})
test('historical records exceeding the preserved ledger are not backfilled',async()=>{
  const f=fixture();f.write([row()]);await f.store().refresh();const state=legacy(f.statePath)
  for(const buckets of Object.values(state.days) as Record<string,{input:number,cacheRead:number}>[])for(const record of Object.values(buckets)){record.input=50;record.cacheRead=0}
  writeFileSync(f.statePath,JSON.stringify(state));const store=f.store();await store.refresh()
  assert.deepEqual(store.hourRecords(),[]);assert.equal(store.hourlyCoverage().state,'partial');assert.equal(store.totals().input,50)
})
test('corrupt hourly data fails closed rather than resetting the original daily ledger',async()=>{
  const f=fixture();f.write([row()]);await f.store().refresh();const state=JSON.parse(readFileSync(f.statePath,'utf8'));state.hours=null
  writeFileSync(f.statePath,JSON.stringify(state));const before=readFileSync(f.statePath,'utf8')
  await assert.rejects(f.store().refresh(),/Invalid stored hourly/);assert.equal(readFileSync(f.statePath,'utf8'),before)
})
test('ambiguous duplicate attempts crossing hours remain missing instead of moving charged usage',async()=>{
  const f=fixture();f.write([row({t:Date.parse('2026-10-14T00:59:00Z'),requestId:'same',attemptId:'same'})]);const original=f.store();await original.refresh()
  appendFileSync(f.file,row({t:Date.parse('2026-10-14T01:01:00Z'),requestId:'same',attemptId:'same'})+'\n');await original.refresh();legacy(f.statePath)
  const migrated=f.store();await migrated.refresh();assert.equal(migrated.totals().input,100);assert.deepEqual(migrated.hourRecords(),[]);assert.equal(migrated.hourlyCoverage().state,'partial')
})

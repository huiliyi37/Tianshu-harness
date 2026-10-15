import {parseUsageRows,attemptDedupeKey,type CacheUsageRow} from '../cache/usage-aggregator.js'
import type {TokenHourModelRecord,TokenLedgerState} from './types.js'

const safe=(value:number)=>Number.isSafeInteger(value)&&value>=0
export function safeCounter(value:number):number {
  if(!safe(value))throw new RangeError('Hourly usage exceeds safe integer range')
  return value
}
export function utcHour(timestamp:number):string {
  if(!Number.isFinite(timestamp))throw new RangeError('Invalid hourly timestamp')
  const value=new Date(Math.floor(timestamp/3600000)*3600000).toISOString()
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value))throw new RangeError('Invalid hourly timestamp')
  return value
}
export function foldHour(state:TokenLedgerState,row:CacheUsageRow):void {
  const hour=utcHour(row.t),provider=row.provider||'',key=JSON.stringify([provider,row.model])
  if(!row.model||row.model.length>128||provider.length>128)throw new RangeError('Invalid hourly model')
  safeCounter(row.input);safeCounter(row.output);safeCounter(row.input+row.output)
  const buckets=(state.hours??={})[hour]??=((state.hours!)[hour]={})
  const previous=buckets[key],input=safeCounter((previous?.input||0)+row.input),output=safeCounter((previous?.output||0)+row.output)
  safeCounter(input+output);buckets[key]={hour,model:row.model,provider,input,output}
}
export function hourRecordsOf(state:TokenLedgerState):TokenHourModelRecord[] {
  const records:TokenHourModelRecord[]=[]
  if(state.hours===undefined)return records
  if(!state.hours||typeof state.hours!=='object'||Array.isArray(state.hours))throw new Error('Invalid stored hourly ledger')
  for(const [hour,buckets] of Object.entries(state.hours)){
    if(!buckets||typeof buckets!=='object'||Array.isArray(buckets))throw new Error('Invalid stored hourly ledger')
    for(const [key,record] of Object.entries(buckets)){
      if(!record||record.hour!==hour||utcHour(Date.parse(hour))!==hour||typeof record.model!=='string'||!record.model||record.model.length>128||typeof record.provider!=='string'||record.provider.length>128||key!==JSON.stringify([record.provider,record.model]))throw new Error('Invalid stored hourly ledger')
      safeCounter(record.input);safeCounter(record.output);safeCounter(record.input+record.output);records.push({...record})
    }
  }
  return records.sort((left,right)=>left.hour.localeCompare(right.hour)||left.model.localeCompare(right.model)||left.provider.localeCompare(right.provider))
}
export function withinLifetime(state:TokenLedgerState,additional:TokenHourModelRecord[]=[]):boolean {
  const limits=new Map<string,{input:number,output:number}>(),actual=new Map<string,{input:number,output:number}>()
  for(const buckets of Object.values(state.days))for(const row of Object.values(buckets)){
    const key=JSON.stringify([row.provider||'',row.model]),previous=limits.get(key)||{input:0,output:0}
    limits.set(key,{input:safeCounter(previous.input+row.input),output:safeCounter(previous.output+row.output)})
  }
  for(const row of [...hourRecordsOf(state),...additional]){
    const key=JSON.stringify([row.provider,row.model]),previous=actual.get(key)||{input:0,output:0},input=safeCounter(previous.input+row.input),output=safeCounter(previous.output+row.output),limit=limits.get(key)
    if(!limit||input>limit.input||output>limit.output)return false
    actual.set(key,{input,output})
  }
  return true
}

export function provenHistoricalRows(content:string):{rows:CacheUsageRow[];ambiguous:boolean} {
  const identified=new Map<string,{row:CacheUsageRow;signature:string}>(),ambiguous=new Set<string>(),unidentified:CacheUsageRow[]=[]
  for(const line of content.split(/\r?\n/)){
    const row=parseUsageRows(line)[0]
    if(!row)continue
    const record=JSON.parse(line) as Record<string,unknown>,key=attemptDedupeKey(record)
    if(key===undefined){unidentified.push(row);continue}
    const signature=JSON.stringify([utcHour(row.t),row.model,row.provider||'',row.input,row.output,row.cacheRead,row.cacheCreate]),previous=identified.get(key)
    if(previous&&previous.signature!==signature)ambiguous.add(key)
    identified.set(key,{row,signature})
  }
  return {rows:[...unidentified,...[...identified].filter(([key])=>!ambiguous.has(key)).map(([,entry])=>entry.row)],ambiguous:ambiguous.size>0}
}

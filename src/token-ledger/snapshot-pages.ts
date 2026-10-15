import type {TokenUsageSnapshot,TokenHourModelRecord,TokenDayModelRecord} from './types.js'
import {safeCounter} from './hours.js'

export function snapshotPages(snapshot:TokenUsageSnapshot):TokenUsageSnapshot[] {
  for(const field of ['requests','input','output','cacheRead','cacheCreate'] as const)safeCounter(snapshot.totals[field])
  safeCounter(snapshot.totals.input+snapshot.totals.output)
  if(snapshot.totals.cacheRead+snapshot.totals.cacheCreate>snapshot.totals.input||!Number.isFinite(snapshot.totals.cost)||snapshot.totals.cost<0)throw new RangeError('Invalid snapshot totals')
  const pages:TokenUsageSnapshot[]=[],encoder=new TextEncoder(),size=(value:unknown)=>encoder.encode(JSON.stringify(value)).length
  const empty=():TokenUsageSnapshot=>({...snapshot,days:[],...(snapshot.version===2?{hours:[]}:{})})
  let page=empty(),bytes=size(page)
  if(bytes>2000000)throw new RangeError('Snapshot header exceeds upload limit')
  const add=(kind:'hours'|'days',record:TokenHourModelRecord|TokenDayModelRecord,limit:number)=>{
    let records=(kind==='hours'?page.hours:page.days)!
    let extra=size(record)+(records.length?1:0)
    if(records.length>=limit||bytes+extra>2000000){pages.push(page);page=empty();bytes=size(page);records=(kind==='hours'?page.hours:page.days)!;extra=size(record)}
    if(bytes+extra>2000000)throw new RangeError('Snapshot record exceeds upload limit')
    if(kind==='hours')page.hours!.push({...record} as TokenHourModelRecord)
    else page.days.push({...record} as TokenDayModelRecord)
    bytes+=extra
  }
  for(const record of [...snapshot.hours||[]].sort((left,right)=>right.hour.localeCompare(left.hour)||left.model.localeCompare(right.model)||left.provider.localeCompare(right.provider)))add('hours',record,3000)
  for(const record of snapshot.days)add('days',record,2000)
  if(page.days.length||page.hours?.length||!pages.length)pages.push(page)
  return pages
}

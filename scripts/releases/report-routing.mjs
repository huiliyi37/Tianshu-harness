import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
export function summarizeRouting(rows) {
const sources = Object.fromEntries(['atomgit','github','oss'].map(source => [source,{ selected:0, fallback:0, completed:0, failed:0, cancelled:0, receivedBytes:0 }]))
for (const row of rows) {
  const result = Object.hasOwn(sources,row.source) ? sources[row.source] : undefined; if (!result) continue
  if (row.event === 'selected') result.selected++
  else if (row.event === 'fallback') result.fallback++
  else if (['download_complete','network_failure','no_progress_30s','integrity_failed','cancelled'].includes(row.event)) {
    if (row.event === 'download_complete') result.completed++
    else if (row.event === 'cancelled') result.cancelled++
    else result.failed++
    if (Number.isSafeInteger(row.receivedBytes) && row.receivedBytes >= 0) result.receivedBytes += row.receivedBytes
  }
}
const selections = rows.filter(r => r.event === 'policy_selected').map(r => r.detail)
const attempts = new Map()
for (const r of rows) if (['upgrade_attempt','upgrade_result'].includes(r.event) && r.detail?.attemptId) attempts.set(r.detail.attemptId,r.detail)
const failures = rows.filter(r => ['install_failed','check_failed','restart_failed'].includes(r.event)).map(r => r.detail)
return { sources, selections, upgrades:[...attempts.values()], failures, measurement:'Local client observations only; installer return is not upgrade confirmation. Website clicks and OSS billed egress require separate provider ledgers.' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file=process.argv[2]
  if (!file) { console.error('Usage: node scripts/releases/report-routing.mjs <update-downloads.jsonl>'); process.exit(1) }
  const rows=readFileSync(file,'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  console.log(JSON.stringify(summarizeRouting(rows),null,2))
}

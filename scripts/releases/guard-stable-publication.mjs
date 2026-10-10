import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTROL_URLS, validateControl, assertPinnedCatalog } from './update-control.mjs'
import { readRemote } from './publish-update-control.mjs'

export async function guardStablePublication(version, bytes, fetcher = fetch) {
  for (const url of CONTROL_URLS) {
    const body = await readRemote(url, fetcher)
    if (!body) continue // Bootstrap remains compatible before control is initialized.
    const control = validateControl(JSON.parse(body))
    if (control.stable.version !== version) throw new Error('This version is not the controlled stable release; use assets-only upload or controlled promotion')
    if (bytes) assertPinnedCatalog(control, bytes)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) guardStablePublication(process.argv[2]).catch(error => { console.error(error.message); process.exitCode=1 })

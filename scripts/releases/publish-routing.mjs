import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { validateCatalog, assertCatalogUpdate, CATALOG_URLS } from './catalog.mjs'
import { validateReleaseNotes } from './release-notes.mjs'
import { guardStablePublication } from './guard-stable-publication.mjs'

const publish = process.argv.includes('--publish')
const catalog = validateCatalog(JSON.parse(readFileSync('release-catalog.json','utf8')))
await guardStablePublication(catalog.version, readFileSync('release-catalog.json'))
const manifest = JSON.parse(readFileSync('latest.json','utf8'))
if (catalog.version !== manifest.version) throw new Error('Manifest/catalog versions differ')
if (!catalog.artifacts.every(a => a.sources.github?.verified)) throw new Error('GitHub artifacts must be verified before publishing the catalog')
if (process.argv.includes('--enable-legacy-atomgit')) {
  const windows = catalog.artifacts.find(a => a.platform === 'windows-x86_64' && a.purpose === 'update')
  if (!windows?.sources.atomgit?.verified || windows.sources.atomgit.anonymous !== true) throw new Error('Windows anonymous download must pass before redirecting old clients')
  if (windows.signature !== manifest.platforms['windows-x86_64']?.signature) throw new Error('Legacy signature differs from catalog')
}
async function existingCatalog(url) {
  const r = await fetch(url,{signal:AbortSignal.timeout(15000)})
  if (r.status === 404) return
  if (!r.ok) throw new Error(`Cannot check existing catalog: HTTP ${r.status}`)
  const old = validateCatalog(await r.json())
  assertCatalogUpdate(old,catalog)
}
const github = `https://github.com/huiliyi37/Tianshu-harness/releases/download/v${catalog.version}/release-catalog.json`
await existingCatalog(github)
await existingCatalog(CATALOG_URLS[0])
if (!publish) {
  console.log(`Dry run: publish v${catalog.version} catalog to GitHub/OSS and dispatch website refresh. Legacy endpoint remains unchanged unless --enable-legacy-atomgit is supplied.`)
} else {
  const work = mkdtempSync(join(tmpdir(),'tianshu-routing-'))
  const run = (cmd,args,options={}) => execFileSync(cmd,args,{stdio:['ignore','pipe','pipe'],...options,windowsHide: true})
  try {
    if (catalog.releaseNotesUrl) {
      if (!process.argv.includes('--release-notes-reviewed')) throw new Error('Release notes require publisher review before upload')
      const notes = validateReleaseNotes(JSON.parse(readFileSync(`docs/releases/summaries/${catalog.version}.json`,'utf8')),catalog.version)
      const file = join(work,'release-notes.json'); writeFileSync(file,JSON.stringify(notes,null,2)+'\n')
      const existing = await fetch(catalog.releaseNotesUrl,{signal:AbortSignal.timeout(15000)})
      if (existing.ok && JSON.stringify(validateReleaseNotes(await existing.json(),catalog.version)) !== JSON.stringify(notes)) throw new Error('Immutable release notes changed')
      if (!existing.ok && existing.status !== 404) throw new Error('Cannot verify release notes')
      if (existing.status === 404) run('gh',['release','upload',`v${catalog.version}`,file,'--repo','huiliyi37/Tianshu-harness'])
      run(process.env.OSSUTIL_BIN ?? 'ossutil',['cp',file,`oss://tianshu-update/tianshu/v${catalog.version}/release-notes.json`,'-f'])
    }
    // Only tiny metadata is overwritten. Installer bytes are uploaded by their dedicated immutable publisher.
    run('gh',['release','upload',`v${catalog.version}`,'release-catalog.json','--repo','huiliyi37/Tianshu-harness','--clobber'])
    run(process.env.OSSUTIL_BIN ?? 'ossutil',['cp','release-catalog.json','oss://tianshu-update/tianshu/release-catalog.json','--meta','Cache-Control:no-cache','-f'])
    if (process.argv.includes('--enable-legacy-atomgit')) {
      const legacy = structuredClone(manifest)
      for (const [platform,p] of Object.entries(legacy.platforms)) {
        const a = catalog.artifacts.find(a=>a.platform===platform&&a.purpose==='update')
        const atomgit = a.sources.atomgit
        p.url = atomgit?.verified ? atomgit.url : a.sources.oss?.url ?? p.url
      }
      const file=join(work,'latest.json');writeFileSync(file,JSON.stringify(legacy,null,2)+'\n')
      run(process.env.OSSUTIL_BIN ?? 'ossutil',['cp',file,'oss://tianshu-update/tianshu/latest.json','--meta','Cache-Control:no-cache','-f'])
    }
    // Website repo remote is resolved by its local checkout; no deployment credential is printed.
    const arg = process.argv.indexOf('--website')
    const website = resolve(arg >= 0 ? process.argv[arg+1] : process.env.TIANSHU_WEBSITE_DIR ?? '../tianshu-website')
    const remote=run('git',['-C',website,'remote','get-url','origin']).toString().trim()
    const repo=remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
    if (!repo) throw new Error('Website GitHub repository cannot be resolved')
    const body=join(work,'dispatch.json');writeFileSync(body,JSON.stringify({event_type:'tianshu-release',client_payload:{version:catalog.version,revision:catalog.revision}}))
    run('gh',['api',`repos/${repo}/dispatches`,'--method','POST','--input',body])
    console.log(`Published v${catalog.version} catalog and requested website refresh`)
  } catch { console.error('Routing publication incomplete; retry checks existing metadata first. Check GitHub/OSS permissions and website dispatch access.');process.exitCode=1 }
  finally { rmSync(work,{recursive:true,force:true}) }
}

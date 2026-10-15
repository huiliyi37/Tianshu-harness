import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateCatalog, chooseCatalog } from './catalog.mjs'
import { validateReleaseNotes } from './release-notes.mjs'
import { writeCatalog } from './check-workspace-metadata.mjs'

export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function generateCatalog({ manifest, assets, revision = 1, githubAssets = [], evidence = {}, previousCatalog, releaseNotes }) {
  if (previousCatalog) validateCatalog(previousCatalog)
  if (releaseNotes) validateReleaseNotes(releaseNotes, manifest.version)
  const artifacts = []
  const append = async (platform, purpose, fileName, signature) => {
    const path = join(assets, fileName), remote = githubAssets.find(a => a.name === fileName)
    const local = existsSync(path)
    const digest = local ? await sha256(path) : remote?.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1]
    if (!digest) throw new Error(`Missing local artifact or authoritative GitHub SHA-256: ${fileName}`)
    const size = local ? statSync(path).size : remote.size
    if (remote && (remote.size !== size || remote.digest !== `sha256:${digest}`)) throw new Error(`GitHub artifact differs from local file: ${fileName}`)
    const previous = previousCatalog?.version === manifest.version ? previousCatalog.artifacts.find(a => a.platform === platform && a.purpose === purpose) : undefined
    if (previous && (previous.sha256 !== digest || previous.size !== size || previous.signature !== signature)) throw new Error(`Immutable artifact changed: ${fileName}`)
    const verifiedAt = previous?.sources.github?.verifiedAt ?? new Date().toISOString()
    const github = { url: `https://github.com/huiliyi37/Tianshu-harness/releases/download/v${manifest.version}/${fileName}`, verified: Boolean(remote), verifiedAt, size, sha256: digest }
    // OSS remains a manual backup until anonymous full-download evidence is supplied.
    const sources = { ...previous?.sources, github }
    sources.oss ??= { url: `https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/v${manifest.version}/${fileName}`, verified: false }
    for (const source of ['atomgit', 'oss']) {
      const proof = evidence[fileName]?.[source]
      if (proof) sources[source] = proof
    }
    artifacts.push({ platform, purpose, fileName, size, sha256: digest, ...(signature ? { signature } : {}), sources })
  }
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const fileName = basename(new URL(entry.url).pathname)
    const sig = join(assets, fileName + '.sig')
    if (existsSync(sig) && readFileSync(sig, 'utf8').trim() !== entry.signature.trim()) throw new Error(`Manifest and local signature differ: ${fileName}`)
    await append(platform, 'update', fileName, entry.signature)
    await append(platform, 'install', platform.startsWith('darwin') ? fileName.replace('.app.tar.gz', '.dmg') : fileName)
  }
  const catalog = validateCatalog({ schemaVersion: 1, revision, version: manifest.version, publishedAt: manifest.pub_date ?? previousCatalog?.publishedAt ?? new Date().toISOString(), notes: manifest.notes ?? '', ...(releaseNotes ? { releaseNotesUrl: `https://github.com/huiliyi37/Tianshu-harness/releases/download/v${manifest.version}/release-notes.json` } : previousCatalog?.releaseNotesUrl ? { releaseNotesUrl: previousCatalog.releaseNotesUrl } : {}), artifacts })
  if (previousCatalog?.version === manifest.version) chooseCatalog([catalog,previousCatalog])
  return catalog
}
export async function main() {
  const value = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1] }
  const manifest = JSON.parse(readFileSync(value('--manifest') ?? 'latest.json', 'utf8'))
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const response = await fetch(`https://api.github.com/repos/huiliyi37/Tianshu-harness/releases/tags/v${manifest.version}`, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'tianshu-release-catalog', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
  if (!response.ok) throw new Error(`GitHub release metadata unavailable: ${response.status}`)
  const release = await response.json()
  const evidence = value('--evidence') ? JSON.parse(readFileSync(value('--evidence'), 'utf8')) : {}
  const out = value('--out') ?? 'release-catalog.json'
  const previousCatalog = existsSync(out) ? JSON.parse(readFileSync(out,'utf8')) : undefined
  const notesFile = value('--notes') ?? `docs/releases/summaries/${manifest.version}.json`
  const releaseNotes = existsSync(notesFile) ? JSON.parse(readFileSync(notesFile,'utf8')) : undefined
  const catalog = await generateCatalog({ manifest, assets: resolve(value('--assets') ?? 'release'), revision: Number(value('--revision') ?? previousCatalog?.revision ?? 1), githubAssets: release.assets, evidence, previousCatalog, releaseNotes })
  writeCatalog(out, catalog)
  console.log(`Validated v${catalog.version}: ${catalog.artifacts.length} artifacts; unverified sources cannot be selected`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })

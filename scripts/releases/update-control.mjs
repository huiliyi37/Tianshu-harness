import { createHash } from 'node:crypto'
import { stableVersion, compareVersion, validateCatalog } from './catalog.mjs'

export const CONTROL_URLS = [
  'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/update-control.json',
  'https://github.com/huiliyi37/Tianshu-harness/releases/download/update-control/update-control.json',
]
export const CONTROL_LIMIT = 256 * 1024
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const canonical = value => JSON.stringify(sort(value))
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value }
const target = platform => /^(windows|darwin|linux)-(x86_64|aarch64)$/.test(platform)
function keys(value, allowed) { if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unknown update control field') }
function release(value) {
  if (!value || !stableVersion(value.version) || !/^[a-f0-9]{64}$/.test(value.catalogSha256)) throw new Error('Invalid controlled release')
}
export function validateControl(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.revokedVersions) || new Set(value.revokedVersions).size !== value.revokedVersions.length || !value.revokedVersions.every(stableVersion)) throw new Error('Invalid update control')
  release(value.stable)
  keys(value, ['schemaVersion','revision','stable','candidate','revokedVersions'])
  keys(value.stable, ['version','catalogSha256'])
  if (value.revokedVersions.includes(value.stable.version)) throw new Error('Stable release cannot be revoked')
  if (value.candidate) {
    release(value.candidate)
    keys(value.candidate, ['version','catalogSha256','platforms'])
    if (compareVersion(value.candidate.version, value.stable.version) <= 0 || !value.candidate.platforms || !Object.keys(value.candidate.platforms).length) throw new Error('Invalid candidate')
    for (const [platform, rule] of Object.entries(value.candidate.platforms)) {
      if (!target(platform) || !['active', 'paused', 'revoked'].includes(rule?.status) || !Number.isInteger(rule.percentage) || rule.percentage < 0 || rule.percentage > 100) throw new Error('Invalid rollout rule')
      keys(rule, ['status','percentage'])
    }
    if (value.revokedVersions.includes(value.candidate.version) && Object.values(value.candidate.platforms).some(r => r.status !== 'revoked')) throw new Error('Revoked candidate cannot reopen')
  }
  if (Buffer.byteLength(canonical(value)) > CONTROL_LIMIT) throw new Error('Update control exceeds 256 KiB')
  return value
}
export function assertPinnedCatalog(control, bytes) {
  validateControl(control)
  const catalog = validateCatalog(JSON.parse(bytes))
  for (const r of [control.stable, control.candidate].filter(Boolean)) if (r.version === catalog.version && r.catalogSha256 !== digest(bytes)) throw new Error('Controlled catalog bytes are immutable; finish or revoke rollout before replacing metadata')
}
export function chooseControl(values, previous) {
  const valid = values.map(validateControl).sort((a, b) => b.revision - a.revision)
  if (!valid.length) throw new Error('UPDATE_POLICY_UNAVAILABLE')
  const next = valid[0]
  for (const other of valid) if (other.revision === next.revision && canonical(other) !== canonical(next)) throw new Error('UPDATE_POLICY_CONFLICT')
  if (previous) {
    validateControl(previous)
    if (next.revision < previous.revision || (next.revision === previous.revision && canonical(next) !== canonical(previous))) throw new Error('UPDATE_POLICY_ROLLBACK')
    if (!previous.revokedVersions.every(v => next.revokedVersions.includes(v))) throw new Error('UPDATE_POLICY_REVOKED_REMOVED')
    if (compareVersion(next.stable.version, previous.stable.version) < 0) throw new Error('UPDATE_POLICY_ROLLBACK')
    for (const old of [previous.stable, previous.candidate].filter(Boolean)) for (const current of [next.stable, next.candidate].filter(Boolean)) if (old.version === current.version && old.catalogSha256 !== current.catalogSha256) throw new Error('UPDATE_POLICY_CATALOG_CHANGED')
  }
  return next
}
export function bucket(id, version, platform) { return createHash('sha256').update(`${id}\n${version}\n${platform}`).digest().readUInt32BE(0) % 10000 }
export function selectRelease(control, platform, id, preview = false) {
  validateControl(control)
  const c = control.candidate, r = c?.platforms[platform]
  const hit = c && r?.status === 'active' && !control.revokedVersions.includes(c.version) && (preview || (id && bucket(id, c.version, platform) < r.percentage * 100))
  return { release: hit ? c : control.stable, channel: hit ? (preview ? 'preview' : 'candidate') : 'stable', policyRevision: control.revision,
    availabilityReason: hit ? (preview ? 'preview' : 'rollout_selected') : !c ? 'stable' : !r ? 'platform_excluded' : r.status !== 'active' ? r.status : 'rollout_not_selected' }
}
export function validateEvidence(evidence, catalog, platforms, realUpgrade = false) {
  for (const platform of platforms) {
    const a = catalog.artifacts.find(a => a.platform === platform && a.purpose === 'update'), e = evidence?.platforms?.[platform]
    if (!a || !e || evidence.version !== catalog.version || e.sha256 !== a.sha256 || e.passed !== true || typeof e.conclusion !== 'string' || !e.conclusion.trim() || !Number.isFinite(Date.parse(e.checkedAt))) throw new Error(`Acceptance required: ${platform}`)
    if (realUpgrade && e.realSignedUpgrade !== true) throw new Error(`Real signed upgrade required: ${platform}`)
  }
}
export function transition(current, operation, options = {}) {
  validateControl(current)
  const next = structuredClone(current), c = next.candidate
  if (operation === 'stage') {
    const catalog = validateCatalog(options.catalog)
    if (c && !next.revokedVersions.includes(c.version)) throw new Error('Finish or revoke the current candidate first')
    if (next.revokedVersions.includes(catalog.version)) throw new Error('Revoked release cannot reopen')
    validateEvidence(options.evidence, catalog, options.platforms)
    if (!options.platforms?.length) throw new Error('Choose candidate platforms')
    next.candidate = { version: catalog.version, catalogSha256: options.catalogSha256, platforms: Object.fromEntries(options.platforms.map(p => [p, { status: 'active', percentage: 0 }])) }
  } else {
    if (!c) throw new Error('No candidate')
    if (next.revokedVersions.includes(c.version)) throw new Error('Revoked release cannot reopen')
    if (['set-percentage','promote'].includes(operation) && options.catalog?.version !== c.version) throw new Error('Candidate catalog version differs')
    const platforms = options.platforms?.length ? options.platforms : Object.keys(c.platforms)
    if (platforms.some(p => !c.platforms[p])) throw new Error('Platform is not staged')
    if (operation === 'set-percentage') {
      if (!Number.isInteger(options.percentage) || options.percentage < 0 || options.percentage > 100) throw new Error('Percentage must be an integer from 0 to 100')
      validateEvidence(options.evidence, options.catalog, platforms)
      for (const p of platforms) {
        if (c.platforms[p].status !== 'active' || options.percentage < c.platforms[p].percentage) throw new Error('Pause rollout instead of reducing percentage')
        c.platforms[p].percentage = options.percentage
      }
    } else if (operation === 'pause' || operation === 'resume') {
      for (const p of platforms) c.platforms[p].status = operation === 'pause' ? 'paused' : 'active'
    } else if (operation === 'revoke') {
      next.revokedVersions.push(c.version)
      for (const r of Object.values(c.platforms)) r.status = 'revoked'
    } else if (operation === 'promote') {
      const all = Object.keys(c.platforms)
      if (!all.some(p => p.startsWith('windows-')) || !all.some(p => p.startsWith('darwin-'))) throw new Error('Promotion requires Windows and macOS signed upgrade evidence')
      if (all.some(p => c.platforms[p].status !== 'active' || c.platforms[p].percentage !== 100)) throw new Error('All staged platforms must reach 100%')
      const published = options.catalog.artifacts.filter(a => a.purpose === 'update').map(a => a.platform)
      if (published.some(p => !all.includes(p))) throw new Error('All published platforms must be staged')
      validateEvidence(options.evidence, options.catalog, published, true)
      next.stable = { version: c.version, catalogSha256: c.catalogSha256 }; delete next.candidate
    } else throw new Error('Unknown rollout operation')
  }
  next.revision++
  return validateControl(next)
}

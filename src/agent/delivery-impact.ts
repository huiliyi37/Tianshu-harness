import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { tmpdir } from 'node:os'
import { MeridianIndexer, isMeridianIndexablePath } from '../repo/meridian-indexer.js'
import { analyzeImpact, type ImpactResult, type ImpactStep } from '../repo/meridian-impact.js'
import { candidateTypecheckCoverage, isPureTypeOnlyImportEdge, type TypecheckProof } from '../repo/type-only-import.js'
import { buildImportGraphAsync } from './import-graph.js'
import { isTestEntry as testPath } from '../repo/test-entry.js'

export interface DeliveryImpact extends Partial<ImpactResult> { resolved: boolean; reason?: string; requiredTests: string[]; advisoryTests: string[] }
const exec = promisify(execFile)

/** Recompute from current dirty ownership; history is diagnostic, never obligation. */
export async function resolveDeliveryImpact(cwd: string, files: readonly string[], indexer?: MeridianIndexer | null, typecheckProof?: TypecheckProof): Promise<DeliveryImpact> {
  if (!files.length) return { resolved: true, policyVersion: 1, requiredTests: [], advisoryTests: [], reasons: {} }
  try {
    if (indexer?.getDb().available) {
      // Checking only changed files misses a newly added importer. Reconcile the
      // existing indexable scope, without widening languages or traversal hops.
      const result = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
      const current = new Set(result.stdout.split('\0').filter(path => path && isMeridianIndexablePath(path) && existsSync(resolve(cwd, path))))
      for (const path of indexer.getDb().getAllFiles()) if (!current.has(path)) indexer.removeFile(path)
      for (const path of current) {
        const source = readFileSync(resolve(cwd, path), 'utf8')
        if (/\bimport\b/.test(source) && !indexer.getDb().getSymbolsForFile(path).length) await indexer.invalidateFile(path)
        else await indexer.indexFile(path)
        const hash = createHash('sha256').update(readFileSync(resolve(cwd, path))).digest('hex').slice(0, 16)
        if (indexer.getDb().needsParse(path, hash)) throw new Error('index changed during reconciliation')
      }
      const impact = analyzeImpact(indexer.getDb(), [...files], { cwd, typecheckProof })
      if (!impact.requiredTests || !impact.advisoryTests) throw new Error('missing impact policy')
      return { ...impact, resolved: true, requiredTests: impact.requiredTests, advisoryTests: impact.advisoryTests }
    }
  } catch { /* An unavailable or stale index is not affirmative no-impact evidence. */ }
  try {
    if (files.some(path => /\.(?:py|go)$/.test(path))) throw new Error('fallback language unsupported')
    const graph = await buildImportGraphAsync(cwd, { requireComplete: true })
    if (!graph) throw new Error('static import graph incomplete')
    const checkedFiles = candidateTypecheckCoverage(cwd, typecheckProof)
    const canDemoteTypeOnly = checkedFiles !== null
    const required = new Set(files.filter(testPath))
    const advisory = new Set<string>()
    const reasons: Record<string, ImpactStep[]> = {}
    let frontier = files.map(path => ({ file: resolve(cwd, path), path: [] as ImpactStep[], requiredPath: true }))
    const visited = new Set(frontier.map(item => `required\0${item.file}`))
    for (let hop = 0; hop < 3; hop++) {
      const next: typeof frontier = []
      for (const item of frontier) for (const dependent of graph.reverse.get(item.file) ?? []) {
        const path = relative(cwd, dependent).replaceAll('\\', '/')
        const source = relative(cwd, item.file).replaceAll('\\', '/')
        const typeOnly = canDemoteTypeOnly && isPureTypeOnlyImportEdge(cwd, path, source, typecheckProof, checkedFiles!)
        const nextRequired = item.requiredPath && !typeOnly
        const visitKey = `${nextRequired ? 'required' : 'conditional'}\0${dependent}`
        if (visited.has(visitKey)) continue
        visited.add(visitKey)
        const proof = [...item.path, { from: source, to: path, kind: 'imports', confidence: 'extracted', ...(typeOnly ? { typeOnly: true } : {}) }]
        next.push({ file: dependent, path: proof, requiredPath: nextRequired })
        if (testPath(path)) {
          if (nextRequired) { required.add(path); advisory.delete(path); reasons[path] = proof }
          else if (!required.has(path)) { advisory.add(path); if (!reasons[path]) reasons[path] = proof }
        }
      }
      frontier = next
    }
    return { resolved: true, policyVersion: canDemoteTypeOnly ? 2 : 1, requiredTests: [...required].sort(), advisoryTests: [...advisory].sort(), reasons }
  } catch {
    return { resolved: false, requiredTests: [], advisoryTests: [], reason: 'impact_unresolved: 索引与完整静态导入图均不可用。' }
  }
}

/** Reconcile a private copy of Meridian against the candidate, never the shared live index. */
export async function resolveCandidateDeliveryImpact(candidateCwd: string, files: readonly string[], liveIndexer?: MeridianIndexer | null, proof?: TypecheckProof): Promise<DeliveryImpact> {
  let temporary: string | undefined
  let candidateIndexer: MeridianIndexer | undefined
  try {
    try {
      if (liveIndexer?.getDb().available) {
        temporary = mkdtempSync(join(tmpdir(), 'rivet-candidate-impact-'))
        if (await liveIndexer.getDb().backupTo(join(temporary, 'meridian.db'))) {
          candidateIndexer = new MeridianIndexer(candidateCwd, temporary)
        }
      }
    } catch {
      candidateIndexer?.getDb().close()
      candidateIndexer = undefined
    }
    // The existing complete static graph is the only fallback. If it cannot
    // prove the candidate's impact, resolveDeliveryImpact returns unresolved.
    return await resolveDeliveryImpact(candidateCwd, files, candidateIndexer, proof)
  } finally {
    candidateIndexer?.getDb().close()
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}

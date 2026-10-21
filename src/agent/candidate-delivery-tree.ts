import { randomUUID } from 'node:crypto'
import { gitCommand } from '../tools/git-command.js'
import { candidateSnapshotRef } from './candidate-snapshot-ref.js'
import { createVerificationSnapshot, type VerificationSnapshot } from './verification-snapshot.js'

export interface CandidateDeliveryTree {
  path: string
  ref: string
  files: string[]
  buildMs: number
  isCurrent(): boolean
  destroy(): void
}

/** Materialize and verify exactly HEAD plus selected live files. */
export async function openCandidateDeliveryTree(cwd: string, files: readonly string[], signal?: AbortSignal): Promise<CandidateDeliveryTree> {
  const started = Date.now()
  const selected = [...new Set(files)].sort()
  if (!selected.length || selected.some(file => typeof file !== 'string' || !file.trim())) throw new Error('deliveryFiles 必须是非空文件路径列表')
  signal?.throwIfAborted()
  const before = candidateSnapshotRef(cwd, selected)
  const headResult = await gitCommand(cwd, ['rev-parse', 'HEAD'], { signal, timeoutMs: 10_000 })
  const head = headResult.status === 0 ? headResult.stdout.trim() : ''
  if (!before || !/^[a-f0-9]{40,64}$/i.test(head) || !before.startsWith(`${head.slice(0, 12)}+`)) {
    throw new Error('无法确认候选文件的安全路径或当前 HEAD')
  }
  let snapshot: VerificationSnapshot | undefined
  try {
    snapshot = await createVerificationSnapshot({ baseCwd: cwd, sessionId: `candidate-${randomUUID()}`, baselineHead: head, ownedFiles: selected })
    signal?.throwIfAborted()
    if (candidateSnapshotRef(cwd, selected) !== before || candidateSnapshotRef(snapshot.path, selected) !== before) {
      throw new Error('构建快照时候选文件或 HEAD 发生变化')
    }
    return { path: snapshot.path, ref: before, files: selected, buildMs: Date.now() - started,
      isCurrent: () => candidateSnapshotRef(cwd, selected) === before,
      destroy: () => snapshot!.destroy() }
  } catch (error) {
    snapshot?.destroy()
    throw error
  }
}

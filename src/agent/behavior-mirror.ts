import type { TrajectoryEntry } from './trajectory.js'
import { basenamePortable } from '../utils/safe-path.js'

function isDietNoInfoReadResult(content: string): boolean {
  return content.includes('[diet:redundant]') || content.includes('[diet:useless]')
}

function detectReadLoop(entries: TrajectoryEntry[]): string | null {
  const readNoInfo = entries.filter(e =>
    e.tool === 'read_file'
    && isDietNoInfoReadResult(e.resultSummary),
  )
  const counts = new Map<string, number>()
  for (const e of readNoInfo) counts.set(e.target, (counts.get(e.target) ?? 0) + 1)
  for (const [target, count] of counts) {
    if (count >= 2) {
      const name = basenamePortable(target)
      return `read_loop: warn — read_file for ${name} returned diet no-info placeholders ${count} times. If you still need this file's content, use read_section with a precise line range instead of re-reading the whole file. grep or repo_graph may also work.`
    }
  }
  return null
}

export function detectMirror(entries: TrajectoryEntry[]): string | null {
  const readLoop = detectReadLoop(entries)
  if (readLoop) return readLoop

  if (entries.length < 3) return null

  // Priority 1: repeated error class (2+ same errorClass)
  const errors = entries.filter(e => e.errorClass)
  const errorCounts = new Map<string, number>()
  for (const e of errors) errorCounts.set(e.errorClass!, (errorCounts.get(e.errorClass!) ?? 0) + 1)
  for (const [cls, count] of errorCounts) {
    if (count >= 2) return `Same error (${cls}) has occurred ${count} times. Is the current approach the right path? What is the root cause?`
  }

  // Priority 2: repeated edits to same file (3+ edits)
  const edits = entries.filter(e => e.tool === 'edit_file' || e.tool === 'write_file')
  const fileCounts = new Map<string, number>()
  for (const e of edits) fileCounts.set(e.target, (fileCounts.get(e.target) ?? 0) + 1)
  for (const [file, count] of fileCounts) {
    if (count >= 3) {
      const name = basenamePortable(file)
      return `You have edited ${name} ${count} times. What is the root cause? Would a higher-level fix be more effective?`
    }
  }

  // Priority 3: unverified edits (3+ consecutive edit/write without test/bash)
  const recent = entries.slice(-5)
  const writeOps = recent.filter(e => e.tool === 'edit_file' || e.tool === 'write_file')
  const verifyOps = recent.filter(e => e.tool === 'bash' || e.tool === 'run_tests')
  if (writeOps.length >= 3 && verifyOps.length === 0) {
    return `You have modified ${writeOps.length} files without running tests or verification. Consider validating your changes before continuing.`
  }

  return null
}

/**
 * swebench-worker — worker thread for parallel SWE-bench inference.
 *
 * Each worker handles one instance at a time: clone repo → run agent →
 * extract patch → report back. The main thread manages the queue.
 */

import { parentPort, workerData } from 'node:worker_threads'
import type { SwebenchInstance, RunRecord } from './swebench-run.js'

// We import dynamically to avoid duplicating the agent bootstrap per worker
// (the agent itself does its own lazy-loading via runAgentInDir).

const { join } = await import('node:path')
const { existsSync, mkdirSync } = await import('node:fs')
const { execFileSync } = await import('node:child_process')
const { sanitizeSegment, runGit } = await import('./swebench-helpers.js')

if (!parentPort) throw new Error('Worker must be spawned with worker_threads')

const opts = workerData as {
  workRoot: string
  maxTurns: number
  modelId?: string
  domain?: string
}

// Ensure work root exists
if (!existsSync(opts.workRoot)) {
  mkdirSync(opts.workRoot, { recursive: true })
}

parentPort.on('message', async (msg: { type: 'run'; instance: SwebenchInstance } | { type: 'done' }) => {
  if (msg.type === 'done') {
    process.exit(0)
  }

  if (msg.type !== 'run') return
  const instance = msg.instance

  const record: RunRecord = {
    instance_id: instance.instance_id,
    status: 'running',
    startedAt: new Date().toISOString(),
  }

  try {
    const workDir = join(opts.workRoot, sanitizeSegment(instance.instance_id))

    // Clone repo — 数据集字段不可信，参数数组执行（同 swebench-run.ts）
    if (!existsSync(join(workDir, '.git'))) {
      const url = `${process.env.GITHUB_MIRROR || 'https://github.com'}/${instance.repo}.git`
      mkdirSync(workDir, { recursive: true })
      runGit(workDir, ['init'])
      runGit(workDir, ['remote', 'add', 'origin', url])
      runGit(workDir, ['fetch', '--depth', '50', 'origin', instance.base_commit], 300_000)
      runGit(workDir, ['checkout', '-b', 'main', instance.base_commit])
      runGit(workDir, ['tag', 'swebench-base'])
    } else {
      runGit(workDir, ['checkout', '--', '.'])
      runGit(workDir, ['clean', '-fd'])
    }

    // Run agent
    const { runAgentInDir, buildSwebenchPrompt } = await import('./swebench-run.ts')
    const prompt = buildSwebenchPrompt(instance)
    const result = await runAgentInDir(workDir, prompt, opts.maxTurns, opts.modelId, opts.domain)

    record.exitCode = result.exitCode
    record.agentText = result.json?.text ?? ''

    try {
      const patch = execFileSync(
        'git', ['diff', 'swebench-base'],
        { cwd: workDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      )
      if (patch.trim()) {
        record.patch = patch
        record.status = 'completed'
      } else {
        record.status = 'failed'
        record.error = result.json?.error ?? `Agent exited with code ${result.exitCode}`
      }
    } catch (err) {
      record.status = 'failed'
      record.error = (err as Error).message
    }

    record.endedAt = new Date().toISOString()
    parentPort!.postMessage(record)
  } catch (outerErr) {
    record.status = 'failed'
    record.error = (outerErr as Error).message
    record.endedAt = new Date().toISOString()
    parentPort!.postMessage(record)
  }
})

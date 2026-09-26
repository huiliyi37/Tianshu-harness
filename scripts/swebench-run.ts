/**
 * swebench-run — Tianshu SWE-bench Verified inference runner
 *
 * Loads SWE-bench Verified dataset, runs Tianshu agent headless on each
 * instance (clone repo → agent → git diff → patch), and writes
 * predictions.jsonl for official SWE-bench evaluation.
 *
 * Usage:
 *   tsx scripts/swebench-run.ts --dataset <path.parquet> [options]
 */

import { parseArgs } from 'node:util'
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { sanitizeSegment, runGit } from './swebench-helpers.js'

// ── Types ──────────────────────────────────────────────────────

export interface SwebenchInstance {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  test_patch: string
  version: string
}

export interface RunRecord {
  instance_id: string
  status: 'running' | 'completed' | 'failed'
  patch?: string
  error?: string
  startedAt: string
  endedAt?: string
  exitCode?: number
  agentText?: string
}

export interface RunnerOptions {
  datasetPath: string
  outputPath: string
  progressPath: string
  workRoot: string
  maxInstances: number
  maxTurns: number
  parallel: number
  dryRun: boolean
  modelId?: string
  domain?: string  // star domain (tianliang/yaoguang/etc.) for prompt enrichment
}

// ── Dataset loading ────────────────────────────────────────────

const SWEBENCH_VERIFIED_URL =
  'https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified/resolve/main/data/test-00000-of-00001.parquet'

export async function loadDataset(datasetPath: string): Promise<SwebenchInstance[]> {
  // Support JSONL as input format (simpler, no parquet deps)
  if (datasetPath.endsWith('.jsonl') || datasetPath.endsWith('.json')) {
    return loadDatasetFromJsonl(datasetPath)
  }

  // Parquet path (requires parquet-wasm)
  const { readParquet } = await import('parquet-wasm')
  const buf = readFileSync(datasetPath)
  const table = readParquet(buf)

  const instances: SwebenchInstance[] = []
  for (const batch of table.recordBatches()) {
    const schema = batch.schema
    const fieldNames = schema.fields.map((f: { name: string }) => f.name)
    const idIdx = fieldNames.indexOf('instance_id')
    const repoIdx = fieldNames.indexOf('repo')
    const commitIdx = fieldNames.indexOf('base_commit')
    const problemIdx = fieldNames.indexOf('problem_statement')
    const testPatchIdx = fieldNames.indexOf('test_patch')
    const versionIdx = fieldNames.indexOf('version')

    if (idIdx < 0 || repoIdx < 0 || commitIdx < 0 || problemIdx < 0 || testPatchIdx < 0 || versionIdx < 0) {
      throw new Error('Missing required columns in SWE-bench parquet file. Found: ' + fieldNames.join(', '))
    }

    // Use column(index) to access data — parquet-wasm RecordBatch API
    const idCol = batch.column(idIdx)
    const repoCol = batch.column(repoIdx)
    const commitCol = batch.column(commitIdx)
    const problemCol = batch.column(problemIdx)
    const testPatchCol = batch.column(testPatchIdx)
    const versionCol = batch.column(versionIdx)

    for (let i = 0; i < batch.numRows; i++) {
      instances.push({
        instance_id: String(idCol.get(i)),
        repo: String(repoCol.get(i)),
        base_commit: String(commitCol.get(i)),
        problem_statement: String(problemCol.get(i)),
        test_patch: String(testPatchCol.get(i)),
        version: String(versionCol.get(i)),
      })
    }
  }

  return instances
}

function loadDatasetFromJsonl(path: string): SwebenchInstance[] {
  const content = readFileSync(path, 'utf-8')
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SwebenchInstance)
}

export async function downloadDataset(cachePath: string): Promise<string> {
  if (existsSync(cachePath)) {
    console.log(`Using cached dataset: ${cachePath}`)
    return cachePath
  }
  console.log(`Downloading SWE-bench Verified from HuggingFace...`)
  const res = await fetch(SWEBENCH_VERIFIED_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const dir = dirname(cachePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  await writeFile(cachePath, buf)
  console.log(`Downloaded to ${cachePath} (${(buf.length / 1024).toFixed(1)} KB)`)
  return cachePath
}

// ── Progress persistence ───────────────────────────────────────

export function loadProgress(progressPath: string): string[] {
  if (!existsSync(progressPath)) return []
  const content = readFileSync(progressPath, 'utf-8')
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) as RunRecord }
      catch { return null }
    })
    .filter((r): r is RunRecord => r !== null && r.status === 'completed')
    .map(r => r.instance_id)
}

export function appendProgress(progressPath: string, record: RunRecord): void {
  const dir = dirname(progressPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(progressPath, JSON.stringify(record) + '\n')
}

export function appendPrediction(outputPath: string, record: RunRecord): void {
  if (record.status !== 'completed' || !record.patch) return
  const dir = dirname(outputPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const prediction = {
    instance_id: record.instance_id,
    model_name_or_path: 'tianshu-agent-v1',
    model_patch: record.patch,
  }
  appendFileSync(outputPath, JSON.stringify(prediction) + '\n')
}

// ── Helpers ────────────────────────────────────────────────────

const GITHUB_MIRROR = process.env.GITHUB_MIRROR || 'https://github.com'

export function buildSwebenchPrompt(instance: SwebenchInstance): string {
  return `You are working in the ${instance.repo} repository (version ${instance.version}).
Your task is to fix the following GitHub issue by making the necessary code changes.

## Issue

${instance.problem_statement}

## Instructions

1. Read the relevant source files to understand the codebase
2. Identify the root cause of the issue
3. Make the minimal code changes needed to fix it
4. Use the edit_file tool to apply your changes
5. After making changes, use deliver_task to confirm completion

Important: Do NOT run tests. The test environment is not available. Just make the fix and deliver.

Fix the issue described above. Make only the changes necessary to resolve it.`
}

// ── Agent adapter ──────────────────────────────────────────────

import type { HeadlessRunResult } from '../src/headless.js'

export async function runAgentInDir(
  cwd: string,
  prompt: string,
  maxTurns: number,
  modelId?: string,
  domain?: string,
): Promise<HeadlessRunResult> {
  // Lazy-load agent internals to keep script importable without agent deps
  const { runHeadless } = await import('../src/headless.js')
  const { AgentLoop } = await import('../src/agent/loop.js')
  const { SessionContext } = await import('../src/agent/context.js')
  const { createDefaultToolRegistry } = await import('../src/tools/default-registry.js')
  const { createAgentConfig, createMainAgentConfigInput } = await import('../src/agent/create-agent-config.js')
  const { loadConfig } = await import('../src/config/manager.js')
  const { setTargetConventions, applyConfiguredGitBashPath } = await import('../src/platform.js')

  const cfg = loadConfig()
  setTargetConventions(cfg.editor.platform, cfg.editor.eol)
  applyConfiguredGitBashPath(cfg.env.gitBashPath)

  const prov = cfg.provider.providers[cfg.provider.default]
  if (!prov) throw new Error(`Provider '${cfg.provider.default}' not configured in ~/.rivet/config.json`)
  const key = prov.apiKey ?? process.env[prov.apiKeyEnv ?? '']
  if (!key) throw new Error(`API key not set. Export ${prov.apiKeyEnv ?? 'API_KEY'} or run: rivet config setup`)

  const model = modelId
    ? prov.models.find(m => m.id === modelId || m.alias === modelId)
    : prov.models[prov.models.length - 1]
  if (!model) throw new Error(`Model '${modelId ?? 'default'}' not found in provider '${cfg.provider.default}'`)
  if (modelId) console.log(`  Using model: ${model.id} (alias: ${model.alias ?? 'none'})`)
  const sessionId = crypto.randomUUID()

  // Inject star domain for prompt enrichment (天梁=execution, 瑶光=verification, etc.)
  let domainDef: { id: string; name: string; volatileBlock: string; motto: string } | undefined
  if (domain) {
    const { starDomainRegistry } = await import('../src/agent/star-domain-registry.js')
    const def = starDomainRegistry.get(domain)
    if (def) {
      domainDef = { id: def.id, name: def.name, volatileBlock: def.volatileBlock, motto: def.motto }
    } else {
      console.warn(`  Warning: unknown domain '${domain}', available: ${starDomainRegistry.getDomainIds().join(', ')}`)
    }
  }

  return runHeadless({
    prompt,
    json: true,
    streamJson: false,
    createAgent: () => {
      const toolRegistry = createDefaultToolRegistry([], { desktopTools: cfg.agent.desktopTools })
      const agentCfg = createAgentConfig(createMainAgentConfigInput({
        apiKey: key,
        model: {
          id: model.id,
          maxTokens: model.maxTokens,
          contextWindow: model.contextWindow,
          reasoningEffort: model.reasoningEffort,
        },
        cwd,
        provider: prov,
        allProviders: cfg.provider.providers,
        config: cfg,
        approvalMode: 'dangerously-skip-permissions',
        sessionId,
        toolDefinitions: toolRegistry.getDefinitions(),
        sessionMemoryBlock: undefined,
        auth: undefined,
      }))
      const session = new SessionContext()
      const agent = new AgentLoop({ ...agentCfg, toolRegistry, maxTurns }, session, cwd)

      // Inject star domain
      if (domainDef) {
        agent.setSessionDomain(domainDef)
      }

      return agent
    },
  })
}

// ── CLI ────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`swebench-run — Tianshu SWE-bench inference runner

Usage: tsx scripts/swebench-run.ts --dataset <path> [options]

Options:
  --dataset, -d <path>     Path to SWE-bench Verified parquet file
  --output, -o <path>      predictions.jsonl output (default: ./predictions.jsonl)
  --progress <path>        Progress file for resume (default: ./swebench-progress.jsonl)
  --work-root <path>       Git clone working directory (default: /tmp/swebench-work)
  --max-instances <n>      Max instances to run (0=all, default: 0)
  --max-turns <n>          Max agent turns per instance (default: 100)
  --parallel <n>           Number of parallel instances (default: 1)
  --model <id|alias>       Override model selection (default: last in config)
  --domain <name>          Star domain for prompt enrichment (tianliang/yaoguang/tianshu)
  --dry-run                Load dataset + print summary, skip agent
  --help, -h               Show this help
`)
}

export function parseRunnerArgs(argv: string[]): {
  opts: RunnerOptions
  help: boolean
  error?: string
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      dataset: { type: 'string', short: 'd' },
      output: { type: 'string', short: 'o', default: './predictions.jsonl' },
      progress: { type: 'string', default: './swebench-progress.jsonl' },
      'work-root': { type: 'string', default: join(tmpdir(), 'swebench-work') },
      'max-instances': { type: 'string', default: '0' },
      'max-turns': { type: 'string', default: '100' },
      parallel: { type: 'string', default: '1' },
      model: { type: 'string' },
      domain: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  })

  if (values.help) return { opts: null as any, help: true }
  if (!values.dataset) return { opts: null as any, help: false, error: '--dataset is required' }

  return {
    help: false,
    opts: {
      datasetPath: values.dataset,
      outputPath: values.output,
      progressPath: values.progress,
      workRoot: values['work-root'],
      maxInstances: parseInt(values['max-instances'], 10) || 0,
      maxTurns: parseInt(values['max-turns'], 10) || 100,
      parallel: parseInt(values.parallel, 10) || 1,
      modelId: values.model || undefined,
      domain: values.domain || undefined,
      dryRun: values['dry-run'],
    },
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const parsed = parseRunnerArgs(process.argv.slice(2))
  if (parsed.help) { showHelp(); return }
  if (parsed.error) {
    console.error(`Error: ${parsed.error}\nUse --help for usage info.`)
    process.exit(1)
  }

  const opts = parsed.opts

  console.log(`Loading dataset from ${opts.datasetPath}...`)
  const instances = await loadDataset(opts.datasetPath)
  console.log(`Loaded ${instances.length} instances`)

  if (opts.dryRun) {
    console.log('First 3 instances:')
    for (const inst of instances.slice(0, 3)) {
      console.log(`  ${inst.instance_id}: ${inst.repo}@${inst.base_commit?.slice(0, 8) ?? '?'}`)
    }
    console.log('\nDry-run complete. No agent was invoked.')
    return
  }

  const completed = new Set(loadProgress(opts.progressPath))
  console.log(`Previously completed: ${completed.size}`)

  const toRun = opts.maxInstances > 0
    ? instances.filter(i => !completed.has(i.instance_id)).slice(0, opts.maxInstances)
    : instances.filter(i => !completed.has(i.instance_id))

  if (toRun.length === 0) {
    console.log('All instances already completed.')
    return
  }

  console.log(`Running ${toRun.length} instances (maxTurns=${opts.maxTurns}, parallel=${opts.parallel})...`)

  if (opts.parallel > 1) {
    await runParallel(toRun, opts)
  } else {
    for (let i = 0; i < toRun.length; i++) {
      const instance = toRun[i]!
      console.log(`\n[${i + 1}/${toRun.length}] ${instance.instance_id} — starting...`)
      const record = await runSingleInstance(instance, opts)
      appendProgress(opts.progressPath, record)
      appendPrediction(opts.outputPath, record)
      console.log(`[${instance.instance_id}] ${record.status}${record.error ? ': ' + record.error : ''}`)
    }
  }

  console.log(`\nDone. Predictions written to ${opts.outputPath}`)
}

async function runSingleInstance(instance: SwebenchInstance, opts: RunnerOptions): Promise<RunRecord> {
  const record: RunRecord = {
    instance_id: instance.instance_id,
    status: 'running',
    startedAt: new Date().toISOString(),
  }

  // 数据集字段（repo/base_commit/instance_id）来自不可信 parquet/jsonl——
  // 一律参数数组 spawn，杜绝模板字符串进 shell 的命令注入面。
  const workDir = join(opts.workRoot, sanitizeSegment(instance.instance_id))
  if (!existsSync(join(workDir, '.git'))) {
    const url = `${process.env.GITHUB_MIRROR || 'https://github.com'}/${instance.repo}.git`
    console.log(`  Cloning ${url} @ ${instance.base_commit.slice(0, 8)}...`)
    mkdirSync(workDir, { recursive: true })
    runGit(workDir, ['init'])
    runGit(workDir, ['remote', 'add', 'origin', url])
    runGit(workDir, ['fetch', '--depth', '50', 'origin', instance.base_commit], 300_000)
    runGit(workDir, ['checkout', '-b', 'main', instance.base_commit])
    // Save base commit ref for later diff extraction
    runGit(workDir, ['tag', 'swebench-base'])
  } else {
    runGit(workDir, ['checkout', '--', '.'])
    runGit(workDir, ['clean', '-fd'])
  }

  const prompt = buildSwebenchPrompt(instance)
  const result = await runAgentInDir(workDir, prompt, opts.maxTurns, opts.modelId, opts.domain)
  record.exitCode = result.exitCode
  record.agentText = result.json?.text ?? ''

  // Extract patch regardless of exit code — agent may produce valid fix
  // even if verification tools (pytest, etc.) are unavailable
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
  } catch (diffErr) {
    record.status = 'failed'
    record.error = `git diff failed: ${(diffErr as Error).message}`
  }
  record.endedAt = new Date().toISOString()
  return record
}

import { Worker } from 'node:worker_threads'

async function runParallel(instances: SwebenchInstance[], opts: RunnerOptions): Promise<void> {
  const queue = [...instances]
  let completed = 0
  const total = instances.length

  const workers: Worker[] = []
  for (let i = 0; i < opts.parallel; i++) {
    const worker = new Worker(
      new URL('./swebench-worker.ts', import.meta.url),
      { workerData: { workRoot: opts.workRoot, maxTurns: opts.maxTurns, modelId: opts.modelId, domain: opts.domain } },
    )

    worker.on('message', (record: RunRecord) => {
      appendProgress(opts.progressPath, record)
      appendPrediction(opts.outputPath, record)
      completed++
      console.log(`[${completed}/${total}] ${record.instance_id}: ${record.status}${record.error ? ' — ' + record.error : ''}`)

      const next = queue.shift()
      if (next) {
        worker.postMessage({ type: 'run', instance: next })
      } else {
        worker.postMessage({ type: 'done' })
      }
    })

    const first = queue.shift()
    if (first) worker.postMessage({ type: 'run', instance: first })
    workers.push(worker)
  }

  await Promise.all(workers.map(w => new Promise<void>(resolve => w.on('exit', () => resolve()))))
}

// Only run when executed directly (not imported as a module)
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const resolvedEntry = resolve(process.argv[1] ?? '')
const currentFile = fileURLToPath(import.meta.url)
const isDirectlyExecuted = resolvedEntry === currentFile
if (isDirectlyExecuted) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Use project-local temp dir to avoid sandbox EPERM on /var/folders/...
// 注意：这里必须走 fileURLToPath，不能取 `new URL(...).pathname` —— 后者在 Windows 上带前导
// 斜杠（`/D:/repo/...`），join 之后被拼成 `D:\D:\repo\...`，mkdir 直接 ENOENT
// （issue #144 排查过程中在 Windows 实机上实测到 4 条红）。
const LOCAL_TMP = join(dirname(fileURLToPath(import.meta.url)), '..', '.rivet', 'test-tmp')
function localTmp(name: string): string {
  if (!existsSync(LOCAL_TMP)) mkdirSync(LOCAL_TMP, { recursive: true })
  return join(LOCAL_TMP, name)
}

// Load under test (skeleton: types only, no agent deps)
import {
  loadProgress,
  appendProgress,
  appendPrediction,
  buildSwebenchPrompt,
  downloadDataset,
} from './swebench-run.js'
import type { SwebenchInstance, RunRecord } from './swebench-run.js'

describe('buildSwebenchPrompt', () => {
  it('includes repo, version, and problem statement', () => {
    const instance: SwebenchInstance = {
      instance_id: 'django__django-12345',
      repo: 'django/django',
      base_commit: 'abc123def456',
      problem_statement: 'Fix the XSS vulnerability in admin panel',
      test_patch: 'diff --git a/tests/test_xss.py ...',
      version: '5.0',
    }

    const prompt = buildSwebenchPrompt(instance)
    assert.ok(prompt.includes('django/django'))
    assert.ok(prompt.includes('5.0'))
    assert.ok(prompt.includes('Fix the XSS vulnerability'))
    assert.ok(prompt.includes('edit_file'))
    assert.ok(prompt.includes('deliver_task'))
  })

  it('does not include test_patch', () => {
    const instance: SwebenchInstance = {
      instance_id: 'test',
      repo: 'test/repo',
      base_commit: 'abc',
      problem_statement: 'fix bug',
      test_patch: 'SECRET TEST PATCH',
      version: '1.0',
    }
    const prompt = buildSwebenchPrompt(instance)
    assert.ok(!prompt.includes('SECRET TEST PATCH'), 'test_patch must not be leaked to agent')
  })
})

describe('loadProgress', () => {
  const tmpFile = localTmp('swebench-test-progress.jsonl')

  it('returns empty for missing file', () => {
    const result = loadProgress(localTmp('nonexistent-' + Date.now() + '.jsonl'))
    assert.deepEqual(result, [])
  })

  it('returns completed instance ids', () => {
    const records = [
      '{"instance_id":"a","status":"completed","patch":"diff","startedAt":"2025-01-01T00:00:00Z","endedAt":"2025-01-01T00:01:00Z"}\n',
      '{"instance_id":"b","status":"running","startedAt":"2025-01-01T00:00:00Z"}\n',
      '{"instance_id":"c","status":"completed","patch":"diff2","startedAt":"2025-01-01T00:00:00Z","endedAt":"2025-01-01T00:01:00Z"}\n',
    ]
    writeFileSync(tmpFile, records.join(''))
    const result = loadProgress(tmpFile)
    assert.deepEqual(result, ['a', 'c'])
    unlinkSync(tmpFile)
  })

  it('skips malformed lines', () => {
    writeFileSync(tmpFile, 'not-json\n{"instance_id":"x","status":"completed","patch":"diff","startedAt":"2025-01-01T00:00:00Z","endedAt":"2025-01-01T00:01:00Z"}\n')
    const result = loadProgress(tmpFile)
    assert.deepEqual(result, ['x'])
    unlinkSync(tmpFile)
  })

  it('filters out failed records', () => {
    const records = [
      '{"instance_id":"a","status":"failed","error":"timeout","startedAt":"2025-01-01T00:00:00Z","endedAt":"2025-01-01T00:01:00Z"}\n',
      '{"instance_id":"b","status":"completed","patch":"diff","startedAt":"2025-01-01T00:00:00Z","endedAt":"2025-01-01T00:01:00Z"}\n',
    ]
    writeFileSync(tmpFile, records.join(''))
    const result = loadProgress(tmpFile)
    assert.deepEqual(result, ['b'])
    unlinkSync(tmpFile)
  })
})

describe('appendProgress', () => {
  const tmpFile = localTmp('swebench-test-append.jsonl')

  it('writes a record as JSONL', () => {
    // Clean up first
    try { unlinkSync(tmpFile) } catch {}
    const record: RunRecord = {
      instance_id: 'test-1',
      status: 'completed',
      patch: 'diff --git a/x b/x',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
    }
    appendProgress(tmpFile, record)
    const content = readFileSync(tmpFile, 'utf-8')
    const parsed = JSON.parse(content.trim())
    assert.equal(parsed.instance_id, 'test-1')
    assert.equal(parsed.status, 'completed')
    unlinkSync(tmpFile)
  })

  it('creates parent directory if needed', () => {
    const nested = localTmp('swebench-deep/progress.jsonl')
    try { unlinkSync(nested) } catch {}
    const record: RunRecord = {
      instance_id: 'nested',
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    appendProgress(nested, record)
    assert.ok(existsSync(nested))
    unlinkSync(nested)
  })
})

describe('appendPrediction', () => {
  const tmpFile = localTmp('swebench-test-predictions.jsonl')

  it('writes prediction in SWE-bench format', () => {
    try { unlinkSync(tmpFile) } catch {}
    const record: RunRecord = {
      instance_id: 'django__django-1',
      status: 'completed',
      patch: 'diff --git a/x b/x',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    }
    appendPrediction(tmpFile, record)
    const content = readFileSync(tmpFile, 'utf-8')
    const parsed = JSON.parse(content.trim())
    assert.equal(parsed.instance_id, 'django__django-1')
    assert.equal(parsed.model_name_or_path, 'tianshu-agent-v1')
    assert.equal(parsed.model_patch, 'diff --git a/x b/x')
    unlinkSync(tmpFile)
  })

  it('skips non-completed records', () => {
    try { unlinkSync(tmpFile) } catch {}
    const record: RunRecord = {
      instance_id: 'failed-1',
      status: 'failed',
      error: 'timeout',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    }
    appendPrediction(tmpFile, record)
    assert.ok(!existsSync(tmpFile), 'should not create file for failed record')
  })

  it('skips completed records with empty patch', () => {
    try { unlinkSync(tmpFile) } catch {}
    const record: RunRecord = {
      instance_id: 'empty-patch',
      status: 'completed',
      patch: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    }
    appendPrediction(tmpFile, record)
    assert.ok(!existsSync(tmpFile), 'should not create file for empty patch')
  })
})

describe('downloadDataset', () => {
  it('returns cached path when file exists', async () => {
    const cachePath = localTmp('cached-dataset.parquet')
    writeFileSync(cachePath, 'fake-parquet-data')
    try {
      const path = await downloadDataset(cachePath)
      assert.equal(path, cachePath)
    } finally {
      try { unlinkSync(cachePath) } catch {}
    }
  })

  // loadDataset requires a real parquet file — tested manually
  // via: tsx scripts/swebench-run.ts --dataset <real.parquet> --dry-run
})

import { after, describe, it } from 'node:test'
// doctor <id> 走 assertRuntimeAccess：项目级技能带信任门，fixture 显式授信。
const priorProjectTrust = process.env.RIVET_TRUST_PROJECT
process.env.RIVET_TRUST_PROJECT = '1'
after(() => { if (priorProjectTrust === undefined) delete process.env.RIVET_TRUST_PROJECT; else process.env.RIVET_TRUST_PROJECT = priorProjectTrust })
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSkillsCLI } from '../skills-cli.js'
import { SkillManagement } from '../../skills/skill-management.js'
import type { PythonProbeResult } from '../../skills/runtime/interpreter.js'

const SKILL_MD = (name: string) => `---\nname: ${name}\ndescription: "Helpful: use this"\n---\nbody\n`
const RUNTIME_YAML = `version: 1
python:
  requires: ">=3.10,<3.15"
  requirements: requirements.txt
  entries:
    calculate:
      script: scripts/calculate.py
      timeoutSeconds: 120
`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-runtime-'))
  const cwd = join(root, 'project'), home = join(root, 'home'), external = join(root, 'external')
  mkdirSync(cwd, { recursive: true }); mkdirSync(home); mkdirSync(external)
  const management = new SkillManagement(home, external)
  const addDirSkill = (name: string, files: Record<string, string>) => {
    const dir = join(cwd, '.rivet', 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), SKILL_MD(name))
    for (const [file, content] of Object.entries(files)) {
      const path = join(dir, ...file.split('/'))
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content)
    }
  }
  return { root, cwd, management, addDirSkill, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const probeFound: () => Promise<PythonProbeResult> = async () => ({
  found: true, path: '/usr/bin/python3', realPath: '/usr/bin/python3.12', version: '3.12.4', abi: 'cpython-312', venvOk: true, pipOk: true,
})
const probeMissing: () => Promise<PythonProbeResult> = async () => ({ found: false, code: 'interpreter_missing', guidance: 'install python' })

async function doctorJson(args: string[], options: Parameters<typeof runSkillsCLI>[1]) {
  const { output, exitCode } = await runSkillsCLI([...args, '--json'], options)
  return { exitCode, result: JSON.parse(output) as Record<string, any> }
}

describe('skills doctor <id> — 运行环境诊断（issue #523 WP1）', () => {
  it('合法声明 + 解释器可用 → not-prepared，声明/探测/requires 结论齐全', async () => {
    const f = fixture()
    try {
      f.addDirSkill('calc', { 'runtime.yaml': RUNTIME_YAML, 'scripts/calculate.py': 'print(1)\n', 'requirements.txt': 'httpx\n' })
      const { exitCode, result } = await doctorJson(['doctor', 'calc'], { cwd: f.cwd, management: f.management, probePython: probeFound })
      assert.equal(exitCode, 0)
      assert.equal(result.runtime.status, 'not-prepared')
      assert.equal(result.runtime.declaration.python.requires, '>=3.10,<3.15')
      assert.deepEqual(result.runtime.declaration.python.entries.calculate, { script: 'scripts/calculate.py', timeoutSeconds: 120 })
      assert.equal(result.runtime.interpreter.version, '3.12.4')
      assert.equal(result.runtime.interpreter.venvOk, true)
      assert.deepEqual(result.runtime.requiresMatch, { ok: true })
      assert.equal(result.runtime.environment.status, 'not-prepared')
      assert.deepEqual(result.diagnostics, [])
    } finally { f.cleanup() }
  })

  it('解释器版本不满足 requires → interpreter-missing + version_mismatch', async () => {
    const f = fixture()
    try {
      f.addDirSkill('calc', { 'runtime.yaml': RUNTIME_YAML, 'scripts/calculate.py': 'print(1)\n', 'requirements.txt': 'httpx\n' })
      const old: () => Promise<PythonProbeResult> = async () => ({ found: true, path: '/usr/bin/python3', realPath: '/usr/bin/python3', version: '3.9.0', venvOk: true, pipOk: true })
      const { result } = await doctorJson(['doctor', 'calc'], { cwd: f.cwd, management: f.management, probePython: old })
      assert.equal(result.runtime.status, 'interpreter-missing')
      assert.equal(result.runtime.errorCode, 'version_mismatch')
      assert.equal(result.runtime.requiresMatch.ok, false)
      assert.match(result.runtime.requiresMatch.reason, /不满足/)
    } finally { f.cleanup() }
  })

  it('解释器缺失 → interpreter-missing，guidance 透出', async () => {
    const f = fixture()
    try {
      f.addDirSkill('calc', { 'runtime.yaml': RUNTIME_YAML, 'scripts/calculate.py': 'print(1)\n', 'requirements.txt': 'httpx\n' })
      const { result } = await doctorJson(['doctor', 'calc'], { cwd: f.cwd, management: f.management, probePython: probeMissing })
      assert.equal(result.runtime.status, 'interpreter-missing')
      assert.equal(result.runtime.interpreter.found, false)
      assert.equal(result.runtime.interpreter.guidance, 'install python')
    } finally { f.cleanup() }
  })

  it('声明解析失败 → status invalid，doctor 诊断含 invalid-runtime-declaration', async () => {
    const f = fixture()
    try {
      f.addDirSkill('broken', { 'runtime.yaml': 'version: 2\npython: {}\n' })
      const { result } = await doctorJson(['doctor', 'broken'], { cwd: f.cwd, management: f.management, probePython: probeFound })
      assert.equal(result.runtime.status, 'invalid')
      assert.match(result.runtime.error, /未知声明版本/)
      assert.deepEqual(result.diagnostics.map((d: any) => d.code), ['invalid-runtime-declaration'])
    } finally { f.cleanup() }
  })

  it('目录型技能有 requirements.txt 但无 runtime.yaml → undeclared + runtime-declaration-suggested', async () => {
    const f = fixture()
    try {
      f.addDirSkill('raw-py', { 'requirements.txt': 'httpx\n', 'scripts/tool.py': 'print(1)\n' })
      const { result } = await doctorJson(['doctor', 'raw-py'], { cwd: f.cwd, management: f.management, probePython: probeFound })
      assert.equal(result.runtime.status, 'undeclared')
      assert.equal(result.runtime.environment.status, 'undeclared')
      assert.deepEqual(result.diagnostics.map((d: any) => d.code), ['runtime-declaration-suggested'])
    } finally { f.cleanup() }
  })

  it('旧技能（纯 .md，无 Python 资源）→ undeclared 且无运行时诊断', async () => {
    const f = fixture()
    try {
      const dir = join(f.cwd, '.rivet', 'skills')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'notes.md'), SKILL_MD('notes'))
      const { result } = await doctorJson(['doctor', 'notes'], { cwd: f.cwd, management: f.management, probePython: probeFound })
      assert.equal(result.runtime.status, 'undeclared')
      assert.deepEqual(result.diagnostics, [])
    } finally { f.cleanup() }
  })

  it('doctor 总览输出不变：运行时诊断不进入总览，旧字段原样', async () => {
    const f = fixture()
    try {
      f.addDirSkill('calc', { 'runtime.yaml': 'version: 2\npython: {}\n' })
      f.addDirSkill('raw-py', { 'requirements.txt': 'httpx\n' })
      const { exitCode, result } = await doctorJson(['doctor'], { cwd: f.cwd, management: f.management, probePython: probeFound })
      assert.equal(exitCode, 0)
      assert.equal(result.effective, 'new-session')
      assert.ok(Array.isArray(result.skills))
      const codes = result.diagnostics.map((d: any) => d.code)
      assert.ok(!codes.includes('invalid-runtime-declaration'))
      assert.ok(!codes.includes('runtime-declaration-suggested'))
    } finally { f.cleanup() }
  })

  it('doctor --json（无 id，首参为 flag）仍走总览', async () => {
    const f = fixture()
    try {
      const { exitCode, result } = await doctorJson(['doctor'], { cwd: f.cwd, management: f.management })
      assert.equal(exitCode, 0)
      assert.ok(Array.isArray(result.skills))
    } finally { f.cleanup() }
  })

  it('未知 id → 报错退出', async () => {
    const f = fixture()
    try {
      const { output, exitCode } = await runSkillsCLI(['doctor', 'nope', '--json'], { cwd: f.cwd, management: f.management, probePython: probeFound })
      assert.equal(exitCode, 1)
      assert.match(output, /Skill not found/)
    } finally { f.cleanup() }
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import type { RuntimeSessionManager } from '../session-manager.js'
import { repositorySnapshot } from '../git-workbench.js'

test('real PR routes qualify repository, anchor reviews, reject stale heads and never repeat external writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-pr-workbench-')), oldPath = process.env.PATH, oldRivet = process.env.RIVET_HOME
  const repo = join(dir, 'repo'), bin = join(dir, 'bin'), statePath = join(dir, 'fixture.json'), callsPath = join(dir, 'calls.jsonl')
  mkdirSync(repo); mkdirSync(bin)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '._*\n.DS_Store\n')
  git('commit', '--allow-empty', '-m', 'init'); git('remote', 'add', 'upstream', 'git@github.com:owner/repo.git')
  const sha = 'a'.repeat(40)
  const setState = (extra = {}) => writeFileSync(statePath, JSON.stringify({ sha, ...extra }))
  setState()
  const script = `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2); const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({args, input})+'\\n');
if (args[0] === 'auth') return console.log('authenticated');
if (args[0] === 'api' && args.some(a => a.includes('/commits/'))) return console.log(JSON.stringify({sha:args.some(a => a.endsWith('/commits/main'))?'b'.repeat(40):state.sha}));
if (args[0] === 'api' && args.some(a => a.includes('/compare/'))) return console.log('diff --git a/a.txt b/a.txt');
if (args[0] === 'pr' && args[1] === 'view') return console.log(JSON.stringify({number:1,title:'Test',body:'',state:'OPEN',headRefOid:state.sha,headRefName:'feature',baseRefName:'main',isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:state.blocked?'BLOCKED':'CLEAN'}));
if (args[0] === 'pr' && args[1] === 'list') return console.log('[]');
if (args[0] === 'pr' && args[1] === 'diff') return console.log('diff --git a/a.txt b/a.txt');
if (args[0] === 'pr' && args[1] === 'merge') return console.log('merged');
if (args.includes('graphql')) return console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}}));
if (args.includes('POST')) { if(state.uncertain) {console.error('connection timed out');process.exit(1)} return console.log(JSON.stringify({id:123,html_url:'https://github.com/owner/repo/pull/2'})); }
console.log('{}');
});
`
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'gh.cjs'), script)
    const csCode = `using System; using System.Diagnostics;
class Program {
  static int Main(string[] args) {
    var quote = ((char)34).ToString(); var slash = ((char)92).ToString();
    var p = new Process(); p.StartInfo.FileName = ${JSON.stringify(process.execPath)};
    p.StartInfo.Arguments = quote + AppDomain.CurrentDomain.BaseDirectory + "gh.cjs" + quote + " "
      + string.Join(" ", Array.ConvertAll(args, a => quote + a.Replace(quote, slash + quote) + quote));
    p.StartInfo.UseShellExecute = false; p.StartInfo.CreateNoWindow = true;
    p.StartInfo.RedirectStandardInput = true;
    p.Start(); p.StandardInput.Write(Console.In.ReadToEnd()); p.StandardInput.Close();
    p.WaitForExit(); return p.ExitCode;
  }
}`
    const csPath = join(bin, 'gh.cs')
    writeFileSync(csPath, csCode)
    const windows = process.env.SystemRoot ?? 'C:/Windows'
    const csc = ['Framework64', 'Framework'].map(arch => join(windows, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe')).find(existsSync)
    assert.ok(csc, 'Windows gh fixture requires the .NET Framework compiler')
    execFileSync(csc, ['/nologo', `/out:${join(bin, 'gh.exe')}`, csPath])
  } else {
    writeFileSync(join(bin, 'gh'), script); chmodSync(join(bin, 'gh'), 0o755)
  }
  mkdirSync(join(dir, 'data')); writeFileSync(join(dir, 'data', 'config.json'), '{}')
  process.env.PATH = `${bin}${delimiter}${oldPath}`; process.env.RIVET_HOME = join(dir, 'data')
  const manager = { getDefaultCwd: () => dir, listSessions: () => [{ id: 's', cwd: repo }], getSession: () => undefined } as unknown as RuntimeSessionManager
  const router = createRouter(buildSessionRoutes(manager, 'test'))
  const call = (method: string, path: string, body = {}) => router(method, `/git/workbench${path}?cwd=${encodeURIComponent(repo)}&remote=upstream${path === '/pr' ? '&number=1' : ''}`, body, { authorization: 'Bearer test' })
  const calls = () => readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  try {
    const detail = await call('GET', '/pr')
    assert.equal(detail.status, 200)
    assert.ok(calls().filter(c => c.args[0] === 'pr').every(c => c.args.includes('github.com/owner/repo')))
    const input = { remote: 'upstream', action: 'review', number: 1, headSha: sha, operationId: randomUUID(), confirm: true, event: 'COMMENT', body: 'Review', comments: [{ path: 'a.txt', line: 3, side: 'LEFT', body: 'Deletion issue' }] }
    assert.equal((await call('POST', '/pr-action', input)).status, 200)
    const submitted = calls().find(c => c.args.includes('POST'))
    assert.equal(JSON.parse(submitted.input).commit_id, sha)
    assert.equal(JSON.parse(submitted.input).comments[0].side, 'LEFT')
    const count = calls().filter(c => c.args.includes('POST')).length
    assert.equal((await call('POST', '/pr-action', input)).status, 200)
    assert.equal(calls().filter(c => c.args.includes('POST')).length, count)
    assert.equal((await call('POST', '/pr-action', { ...input, body: 'Different' })).status, 409)
    setState({ sha: 'b'.repeat(40) })
    assert.equal((await call('POST', '/pr-action', { ...input, operationId: randomUUID() })).status, 409)
    assert.equal(calls().filter(c => c.args.includes('POST')).length, count)
    setState({ blocked: true })
    assert.equal((await call('POST', '/pr-action', { action: 'merge', number: 1, remote: 'upstream', method: 'squash', headSha: sha, operationId: randomUUID(), confirm: true })).status, 409)
    assert.equal(calls().filter(c => c.args[1] === 'merge').length, 0)
    setState()
    assert.equal((await call('POST', '/pr-action', { action: 'merge', number: 1, remote: 'upstream', method: 'squash', headSha: sha, operationId: randomUUID(), confirm: true })).status, 200)
    assert.ok(calls().find(c => c.args[1] === 'merge').args.includes('--match-head-commit'))
    setState({ uncertain: true })
    const uncertain = { ...input, operationId: randomUUID() }
    assert.equal((await call('POST', '/pr-action', uncertain)).status, 422)
    const journal = JSON.parse(readFileSync(join(dir, 'data', 'git-operations', `${uncertain.operationId}.json`), 'utf8'))
    assert.equal(journal.state, 'uncertain'); assert.equal(journal.phase, 'sending')
    const beforeRetry = calls().filter(c => c.args.includes('POST')).length
    assert.equal((await call('POST', '/pr-action', uncertain)).status, 409)
    assert.equal(calls().filter(c => c.args.includes('POST')).length, beforeRetry)
    setState()
    const preview = await router('GET', `/git/workbench/pr-preview?cwd=${encodeURIComponent(repo)}&remote=upstream&base=main&head=fork:feature&headRepository=fork/renamed`, {}, { authorization: 'Bearer test' })
    assert.equal(preview.status, 200)
    assert.equal((preview.body as any).headRepository, 'fork/renamed')
    assert.ok(calls().some(c => c.args.includes('repos/fork/renamed/commits/feature')))
    const creation = { action: 'create', remote: 'upstream', head: 'fork:feature', headRepository: 'fork/renamed', base: 'main', title: 'Selected PR', body: 'Description', draft: true, version: (await repositorySnapshot(repo)).repository.version, headSha: sha, baseSha: 'b'.repeat(40), operationId: randomUUID(), confirm: true }
    const creationResult = await call('POST', '/pr-action', creation)
    assert.equal(creationResult.status, 200, JSON.stringify(creationResult.body))
    const created = calls().filter(c => c.args.includes('repos/owner/repo/pulls') && c.args.includes('POST')).at(-1)
    assert.equal(JSON.parse(created.input).head_repo, 'renamed')
    setState({ sha: 'c'.repeat(40) })
    assert.equal((await call('POST', '/pr-action', { ...creation, operationId: randomUUID() })).status, 409)
  } finally {
    process.env.PATH = oldPath
    if (oldRivet === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = oldRivet
    rmSync(dir, { recursive: true, force: true })
  }
})

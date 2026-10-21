import { execFileSync } from 'node:child_process'
import { correctedReference } from './scoped-hook-reference.js'
import { DELIVERY_STATUSES } from './scoped-hook-outcomes.js'

export const BASE_REF = '61ad99a89^'
export const REFERENCE_REF = '61ad99a89'
export const GOAL = `当前项目的交付接口在 Git hook 慢时会卡住整个服务：独立健康探测和审批查询也超时。请先用 run_checks 取得真实复现，再修复源码及真实调用方。
保留真实 hook、文件归属、部分暂存保护和提交前版本校验。只提交本次指定文件，其他文件和暂存状态不得改变。Git 锁属于其他执行时不得删除；取消/超时应等本次子进程退出，结果不确定时先核查是否已经提交，不能盲目再提交。
项目提供 delivery facade 和最小 HTTP 宿主，底层为真实历史源码。可以修改 src/，新增 test/*.test.mjs，不改 support/、原测试、scripts/、README、package.json、tsconfig.json。run_checks 无参数执行类型检查、smoke 和慢 hook 复现；test_file 可运行新增测试。无依赖安装或外网，需要的 Node、Git 和 TypeScript 已提供。模型本身不要执行 git 提交；测试中的提交只发生在独立临时仓库。
最终区分已验证、推断、遗留。不要用禁用 hook、隐藏错误或延长探测超时解决。`

export function snapshotFiles(fixed = false): Record<string, string> {
  const ref = fixed ? REFERENCE_REF : BASE_REF
  const paths = ['src/agent/scoped-git-commit.ts', 'src/agent/commit-version.ts', 'src/tools/spawn-git.ts', 'src/tools/sensitive-file-detector.ts', 'src/tools/destructive-patterns.ts']
  if (fixed) paths.push('src/agent/commit-version-async.ts', 'src/tools/git-command.ts', 'src/tools/process-kill.ts', 'src/tools/process-tracker.ts')
  const files = Object.fromEntries(paths.map(path => [path, execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 2_000_000, windowsHide: true })]))
  // Same declared host boundary for base/reference: never discover a login shell or load user config.
  files['src/tools/spawn-git.ts'] = files['src/tools/spawn-git.ts']!.replace("'./resolved-env.js'", "'../../support/resolved-env.js'")
  files['support/resolved-env.ts'] = 'export function getResolvedEnv(_cwd?: string): NodeJS.ProcessEnv { return { ...process.env } }\n'
  files['src/delivery.ts'] = `import {commitScopedFiles,type ScopedCommitInput} from './agent/scoped-git-commit.js'
export interface DeliveryInput extends ScopedCommitInput { signal?: AbortSignal; timeoutMs?: number }
export async function deliver(input: DeliveryInput) {
  const result=${fixed ? 'await ' : ''}commitScopedFiles(input)
  if(!result.ok) return {status:'blocked',output:result.output}
  return {status:'committed',output:result.output}
}
`
  files['package.json'] = JSON.stringify({ name: 'historical-delivery-task', type: 'module', private: true }, null, 2)
  files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, noEmit: true, types: ['node'] }, include: ['src/**/*.ts', 'support/**/*.ts'] }, null, 2)
  files['README.md'] = `# Delivery responsiveness task

The delivery implementation and Git/version helpers are a historical source snapshot.
src/delivery.ts is a small real consumer: a commit result becomes an HTTP response.
The protected host is in scripts/serve.ts. The installed environment is provided by
support/resolved-env.ts, with no user config/login-shell lookup. These are declared
environment boundaries, not a complete production sidecar snapshot.

run_checks runs strict type checking, smoke and the real slow-hook reproduction.
A 4-second Git hook must actually execute while /readyz and /approvals remain
responsive to independent-process HTTP probes (individual 500ms request budget).
Keep owned-file isolation, version checks and partial staging protections. Do not
delete another execution's index.lock. Cancellation/timeout must stop this execution
and report an uncertain landed commit truthfully. No implicit commit retry after
uncertainty. No hook disabling or longer health timeout.

You may freely patch src/ and add test/*.test.mjs. Original project metadata,
support/, scripts/ and smoke test are protected. Added tests can import
../.build/delivery.mjs (built from src/delivery.ts before test execution).
Only test repositories are committed; do not commit the task workspace itself.

Response status contract: success=${DELIVERY_STATUSES.success.join('|')}; non-success=${DELIVERY_STATUSES.stopped.join('|')}.
Status alone is never evidence: commits must match selected bytes, and stopped
executions must preserve the appropriate HEAD/index state. Unknown statuses are
inconclusive. A stopped request may have landed before cancellation; report that
truthfully and never automatically resubmit it.
`
  files['scripts/serve.ts'] = `import {createServer} from 'node:http'
import {deliver} from '../src/delivery.js'
import {captureCommitVersion} from '../src/agent/commit-version.js'
let active:AbortController|null=null
const server=createServer(async(req,res)=>{
  const send=(value:unknown,code=200)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value))}
  if(req.url==='/readyz') return send({ok:true})
  if(req.url==='/approvals') return send({pending:[],revision:1})
  if(req.url==='/cancel'){active?.abort();return send({cancelled:!!active})}
  const chunks:Buffer[]=[];for await(const chunk of req) chunks.push(Buffer.from(chunk))
  let input:any;try{input=JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{return send({error:'invalid JSON'},400)}
  if(req.url==='/preview') return send({version:await captureCommitVersion(process.env.BENCH_REPO!,input.files)})
  if(req.url!=='/deliver') return send({error:'not found'},404)
  if(active) return send({error:'already running'},409)
  active=new AbortController()
  try{send(await deliver({...input,cwd:process.env.BENCH_REPO!,signal:active.signal}))}
  catch(error){send({status:'blocked',output:error instanceof Error?error.message:'unknown'})}
  finally{active=null}
})
server.listen(Number(process.env.BENCH_PORT),'127.0.0.1',()=>console.log(JSON.stringify({ready:true,port:process.env.BENCH_PORT})))
`
  files['test/smoke.test.mjs'] = `import {test} from 'node:test';import assert from 'node:assert/strict';
import {deliver} from '../.build/delivery.mjs';
test('empty delivery does not claim a commit',async()=>{const result=await deliver({cwd:process.cwd(),files:[],message:'fixture'});assert.equal(result.status,'blocked');});
`
  return fixed ? correctedReference(files) : files
}

export const CASES = ['types', 'responsiveness', 'hook-executed', 'owned-isolation', 'partial-staging', 'snapshot-changed', 'failed-hook', 'foreign-lock', 'cancel', 'timeout', 'uncertain-commit', 'unchanged', 'foreign-same-message', 'foreign-same-path', 'term-ignoring-hook'] as const

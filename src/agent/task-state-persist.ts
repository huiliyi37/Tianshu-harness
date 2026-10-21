import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sessionsDir } from '../config/paths.js'
import { createTaskLedger, type TaskLedgerEvent } from './task-ledger.js'
import { createOwnershipLedger } from './ownership-ledger.js'
import { isTransientPlanDraftPath } from './plan-mode.js'
import { createWorktreeBaseline, type BaselineSnapshot } from './worktree-baseline.js'
import { candidateSnapshotRef } from './candidate-snapshot-ref.js'

interface TaskState {
  version: 1
  sessionId: string
  root: string
  baseline: BaselineSnapshot
  events: TaskLedgerEvent[]
  adopted: string[]
  fingerprint: string | null
}

function rootOf(cwd: string): string {
  try { return realpathSync(cwd) } catch { return resolve(cwd) }
}

/**
 * 敏感路径（不得读取/哈希其内容）——与 fingerprint 的 fail-closed 同源。
 *
 * 判据语义：凭据/密钥材料，词元级匹配（4251eea67 附带观察修复）。旧实现
 * `/(?:^|\/)(?:\.env|credentials\.)|private.*key|token|secret/i` 是子串匹配，
 * tokenizer.ts / secretary.ts / .environment.ts / private-keyboard.ts 及仓内
 * token-store.ts、secrets-store.ts、tokens.css 等 29 个正常文件全部命中——
 * 任一写入即指纹 return null，本会话全部验证 stale，交付门结构性 RED 且无自愈路径。
 *
 * 失效方向（仓纪律「修复要写下失效方向」）：本判据**漏判**只让文件参与指纹哈希
 * （内容仅存 SHA-256 摘要），**误判**是结构性 RED——两侧不对称，故处处选收窄：
 * token/secret 须为完整词元（`_`/`.` 分隔）且落凭据形态（整段恰为该词元，或数据
 * 容器扩展名白名单——白名单缺扩展名只漏判、方向安全；源码/文档扩展名永不中）。
 * 与 tools/sensitive-file-detector 不共用实现：工具层误伤只是拦一次读取（可授权
 * 恢复），指纹层误伤作废全部验证，代价不对称，此处判据刻意更窄（且 detector 的
 * token/secret 形态要求段首+限定扩展名，api_token.txt 类反而漏判）。
 */
const DATA_CONTAINER_EXT_RE = /\.(?:json|ya?ml|ini|conf(?:ig)?|env|txt|xml|properties|toml|csv)$/i

function isSensitivePath(rel: string): boolean {
  // 按段判定，兼容 Windows 分隔符（fingerprint() 的 rel 未经 \ → / 归一化）。
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg) continue
    // .env 家族：.env / .env.local / .env.production…（.environment.ts 的 env 非完整
    // 词元不中）；模板 .env.example/.template/.sample 无真实凭据，放行（同 detector 白名单）。
    if (/^\.env(?:\.|$)/i.test(seg) && !/^\.env\.(?:example|template|sample)$/i.test(seg)) return true
    // credentials：无扩展名精确形态（~/.cargo/credentials 类）+ 凭据扩展名白名单
    // （credentials.ts 是源码，不中——收窄方向）。
    if (/^credentials$/i.test(seg) || /^credentials\.(?:json|ya?ml|xml|ini|conf)$/i.test(seg)) return true
    // 私钥材料：SSH 命名 id_rsa/id_ed25519/id_ecdsa/id_dsa（前缀，含 id_rsa.pub）、
    // *_rsa 结尾、TLS 扩展名 .pem/.key、无扩展名的 private_key/private-key 词元组合
    // （private-keyboard.ts 的 key 非完整词元，不中；旧 private.*key 子串会误伤它）。
    if (/^id_(?:rsa|ed25519|ecdsa|dsa)/i.test(seg)) return true
    if (/[^a-z0-9]rsa$/i.test(seg)) return true
    if (/\.(?:pem|key)$/i.test(seg)) return true
    const tokens = seg.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    if (!seg.includes('.') && tokens.includes('private') && tokens.includes('key')) return true
    // token/secret 完整词元 + 凭据形态：整段恰为该词元（.token/_token/secrets）或数据
    // 容器扩展名（token.json/api_token.txt）；tokenizer.ts/secretary.ts/token-store.ts
    // 的 token 是标识符不是凭据，不中。
    if (tokens.some(t => t === 'token' || t === 'tokens' || t === 'secret' || t === 'secrets')
      && (/^[._-]*(?:tokens?|secrets?)$/i.test(seg) || DATA_CONTAINER_EXT_RE.test(seg))) return true
  }
  return false
}

/**
 * 交付指纹的路径归类。交付是 repo-scoped 概念：
 * - `out-of-project`：解析到 root 之外的路径**不可交付**（git 提交不了它），不参与
 *   指纹——否则往 /tmp 或兄弟目录写一个 fixture 就使本会话所有验证被判 stale、
 *   交付门结构性 RED，且本会话无工具摘除该事件（与 plan 草稿排除同一机制）。
 * - `sensitive`：不得读取/哈希其内容（fail-closed 保留；判据见 isSensitivePath 头注，
 *   词元级收窄——正常源码文件误判作废全部验证，漏判仅参与哈希，故宁漏勿误）。
 */
export function classifyFingerprintPath(root: string, file: string): 'in-project' | 'out-of-project' | 'sensitive' {
  const rel = relative(root, resolve(root, file)).replace(/\\/g, '/')
  if (isAbsolute(rel) || rel.startsWith('..')) return 'out-of-project'
  if (isSensitivePath(rel)) return 'sensitive'
  return 'in-project'
}

function fingerprint(root: string, files: string[], isolated = false): string | null {
  const hash = createHash('sha256')
  for (const args of isolated ? [] : [['rev-parse', 'HEAD'], ['ls-files', '--stage', '-z']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    if (result.status !== 0) return null
    hash.update(result.stdout)
  }
  for (const file of [...new Set(files)].sort()) {
    const path = resolve(root, file), rel = relative(root, path)
    // 越界路径 = 不可交付：跳过而非作废（原实现与敏感路径共用 `return null`，是本缺陷根源）。
    if (classifyFingerprintPath(root, file) === 'out-of-project') continue
    if (isSensitivePath(rel)) return null
    hash.update(file)
    try {
      const actual = realpathSync(path), inside = relative(root, actual)
      if (isAbsolute(inside) || inside.startsWith('..')) return null
      hash.update(readFileSync(actual))
    } catch { hash.update('missing') }
  }
  return hash.digest('hex')
}

/** 指纹输入集唯一口径：**实际发生过的内容写入**（file_write 事件）。
 *
 *  不含认领集（adopt / autoOwnFromBaseline）：认领是归属变更，不是内容变更——
 *  文件字节在认领前后完全相同。把认领混进指纹，会让「先验证、后认领」这个
 *  正常顺序把此前所有验证判废（2026-10-17 现场：跑完全量测试后 adopt 一个由
 *  bash 产出的构建产物，交付门从 GREEN 掉回 RED，而那次测试实际覆盖了该文件）。
 *
 *  内容变更仍被追踪：认领过的文件一旦被本会话改写，那条 file_write 事件就会
 *  把它重新计入指纹，旧验证照常失效——放宽的只是「不涉及写入的归属簿记」。
 *
 *  越界路径与瞬态计划草稿同样排除：它们不是可交付的代码证据（前者见 W2-1，
 *  后者见 8784b64b8 审查 P1 W1-2）。 */
function fingerprintPaths(events: ReadonlyArray<TaskLedgerEvent>, _adopted: ReadonlySet<string> | readonly string[], root: string): string[] {
  return events
    .filter(e => e.type === 'file_write' && e.path && !isTransientPlanDraftPath(e.path, root))
    .map(e => e.path!)
    .filter(p => classifyFingerprintPath(root, p) !== 'out-of-project')
}

/** A restored identity proves provenance; it never grants ownership of all dirty files. */
export function createPersistentTaskState(cwd: string, sessionId: string, fallback: BaselineSnapshot) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid task-state session identity')
  const root = rootOf(cwd)
  const path = resolve(sessionsDir(cwd), `${sessionId}.task-state.json`)
  let saved: TaskState | undefined
  try {
    const candidate = JSON.parse(readFileSync(path, 'utf8')) as TaskState
    if (candidate.version === 1 && candidate.sessionId === sessionId && candidate.root === root
      && Array.isArray(candidate.events) && candidate.events.every(event => event && ['file_write', 'verification', 'git_action'].includes(event.type) && (event.path === undefined || typeof event.path === 'string'))
      && Array.isArray(candidate.adopted) && candidate.adopted.every(file => typeof file === 'string')
      && typeof candidate.baseline?.head === 'string' && typeof candidate.baseline?.branch === 'string'
      && Array.isArray(candidate.baseline?.preExistingDirty) && Array.isArray(candidate.baseline?.preExistingUntracked)) saved = candidate
  } catch { /* old sessions and corrupt snapshots recover without manufactured evidence */ }
  const adopted = new Set(saved?.adopted ?? [])
  const taskLedger = createTaskLedger({ taskId: sessionId, validateEvents: events => {
    const verifications = events.filter(event => event.type === 'verification' && !event.meta?.stale && event.meta?.workspaceFingerprint)
    if (!verifications.length) return
    const current = fingerprint(root, fingerprintPaths(events, adopted, root))
    const snapshotCurrent = fingerprint(root, fingerprintPaths(events, adopted, root), true)
    for (const event of verifications) {
      const candidateFiles = event.meta?.candidateFiles
      const expected = Array.isArray(candidateFiles) && candidateFiles.every(file => typeof file === 'string')
        ? candidateSnapshotRef(root, candidateFiles as string[]) : event.meta?.verificationPhase === 'isolated' ? snapshotCurrent : current
      if (!expected || event.meta?.workspaceFingerprint !== expected) event.meta = { ...event.meta, stale: true }
    }
  } })
  const baseline = createWorktreeBaseline(saved?.baseline ?? fallback)
  const ownership = createOwnershipLedger({ baseline, taskLedger })
  let valid = false
  if (saved) {
    valid = saved.fingerprint !== null && saved.fingerprint === fingerprint(root, fingerprintPaths(saved.events, saved.adopted, root))
    for (const event of saved.events) {
      taskLedger.record(event.type === 'verification' && !valid && event.meta?.verificationPhase !== 'isolated' && !Array.isArray(event.meta?.candidateFiles) ? { ...event, meta: { ...event.meta, stale: true } } : event)
    }
    ownership.autoOwnFromLedger()
    ownership.adoptFiles(saved.adopted)
  }
  const persist = () => {
    try {
      ownership.autoOwnFromLedger()
      const events = taskLedger.getEvents().filter(e => e.type === 'file_write' || e.type === 'verification' || e.type === 'git_action')
      const state: TaskState = { version: 1, root, sessionId, baseline: baseline.toSnapshot(), events: [...events], adopted: [...adopted], fingerprint: fingerprint(root, fingerprintPaths(events, adopted, root)) }
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
      renameSync(temporary, path)
    } catch { /* provenance persistence is best effort; absent proof stays unverified */ }
  }
  const record = taskLedger.record
  taskLedger.record = event => {
    // 越界写入（/tmp、兄弟目录）不可交付、本就不参与指纹（fingerprintPaths 同款排除），
    // 不得作废既往验证——「先验后写」顺序与「先写后验」同根，缺一即结构性 RED。
    // sensitive 保持判废（fail-closed）。
    if (event.type === 'file_write' && !isTransientPlanDraftPath(event.path, root)
      && (!event.path || classifyFingerprintPath(root, event.path) !== 'out-of-project')) {
      for (const previous of taskLedger.getVerifications()) {
        const candidateFiles = previous.meta?.candidateFiles
        if (Array.isArray(candidateFiles) && event.path && !candidateFiles.some(file => typeof file === 'string' && resolve(root, file) === resolve(root, event.path!))) continue
        previous.meta = { ...previous.meta, stale: true }
      }
    }
    if (event.type === 'verification') {
      const candidateFiles = event.meta?.candidateFiles
      const current = Array.isArray(candidateFiles) && candidateFiles.every(file => typeof file === 'string')
        ? candidateSnapshotRef(root, candidateFiles as string[])
        : fingerprint(root, fingerprintPaths(taskLedger.getEvents(), adopted, root), event.meta?.verificationPhase === 'isolated')
      const captured = event.meta && 'workspaceFingerprint' in event.meta ? event.meta.workspaceFingerprint : current
      event = { ...event, meta: { ...event.meta, workspaceFingerprint: captured, stale: event.meta?.stale || !captured || captured !== current } }
    }
    record(event)
    if (event.type === 'file_write' || event.type === 'verification' || event.type === 'git_action') persist()
  }
  taskLedger.captureVerificationFingerprint = (isolated, executionRoot) => fingerprint(executionRoot ?? root, fingerprintPaths(taskLedger.getEvents(), adopted, root), isolated)
  const adopt = ownership.adoptFiles
  ownership.adoptFiles = files => { const result = adopt(files); for (const file of files) adopted.add(file); persist(); return result }
  return { taskLedger, ownership, baseline, persist, recovery: saved ? valid ? 'restored' : 'verification_stale' : 'baseline_missing' }
}

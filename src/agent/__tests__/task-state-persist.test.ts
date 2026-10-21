import { after, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createPersistentTaskState, classifyFingerprintPath } from '../task-state-persist.js'
import { getEffectiveVerifications } from '../verification-attribution.js'
import { candidateSnapshotRef } from '../candidate-snapshot-ref.js'

/**
 * task-state-persist 指纹一致性回归（8784b64b8 提交后审查 P1）。
 *
 * 缺陷：验证记录的 workspaceFingerprint（记录侧）用 ownership 文件集，
 * 而 validateEvents 的校验侧用 file_write 事件集——当 ownership 含 ledger
 * 事件之外的路径（plan draft 在 loop.ts:2195 只删事件不清 ownership，
 * autoOwnFromBaseline 自动认领同理）时两侧永不相等，本会话每条新验证
 * 记录后立即被判 stale，交付门禁恒 RED。
 */
const home = mkdtempSync(join(tmpdir(), 'task-state-persist-'))
process.env.RIVET_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
}

function fixture() {
  const cwd = mkdtempSync(join(home, 'repo-'))
  git(cwd, 'init', '-q'); git(cwd, 'config', 'user.email', 'test@example.com'); git(cwd, 'config', 'user.name', 'Test')
  writeFileSync(join(cwd, 'owned.ts'), 'original'); git(cwd, 'add', '--', 'owned.ts'); git(cwd, 'commit', '-qm', 'initial')
  return { cwd, baseline: { branch: 'main', head: git(cwd, 'rev-parse', 'HEAD'), preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() } }
}

it('P1：ownership 含 ledger 外路径（plan draft）时，新验证不被判 stale', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'draft-drift', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  // 模拟 plan mode 写 draft 的残留形态：draft 进 ownership，但 ledger 事件被
  // loop.ts:2195 的 removeEventsByPath 删掉（或从未记录）——两侧集合就此分叉。
  state.ownership.registerOwned('draft.md')
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

  const eff = getEffectiveVerifications(state.taskLedger.getEvents())
  assert.equal(eff.effective.length, 1, '验证不得因 ownership 有额外条目而被判 stale（记录侧/校验侧口径必须一致）')

  // 反向对照（8784b64b8 审查修复：原 staleSnapshotDropped===0 断言恒真、无防护力——
  // 该字段仅在传入 currentSnapshotRef 时递增）：file_write 事件集合变化后旧验证必
  // 被标 stale，证明判据仍在工作、上面的绿不是恒绿。
  writeFileSync(join(cwd, 'owned.ts'), 'next')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0, '新写事件必须使旧验证失效')
})

it('候选验证仅随所选文件与 HEAD 失效，范围外写入及恢复不清除证据', () => {
  const { cwd, baseline } = fixture()
  const state = createPersistentTaskState(cwd, 'candidate-scoped', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'candidate')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  const ref = candidateSnapshotRef(cwd, ['owned.ts'])
  assert.ok(ref)
  state.taskLedger.record({ type: 'verification', command: 'candidate test', status: 'passed', meta: {
    scope: 'targeted', kind: 'test', candidateFiles: ['owned.ts'], snapshotRef: ref, workspaceFingerprint: ref,
  } })
  writeFileSync(join(cwd, 'unrelated.ts'), 'peer work')
  state.taskLedger.record({ type: 'file_write', path: 'unrelated.ts' })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents(), ref).effective.length, 1)
  const restored = createPersistentTaskState(cwd, 'candidate-scoped', baseline)
  assert.equal(getEffectiveVerifications(restored.taskLedger.getEvents(), ref).effective.length, 1)

  writeFileSync(join(cwd, 'owned.ts'), 'edited after test')
  restored.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(getEffectiveVerifications(restored.taskLedger.getEvents(), candidateSnapshotRef(cwd, ['owned.ts']) ?? undefined).effective.length, 0)
})

it('候选身份包含未跟踪文件内容和 HEAD，拒绝敏感路径', () => {
  const { cwd } = fixture()
  writeFileSync(join(cwd, 'new.ts'), 'one')
  const first = candidateSnapshotRef(cwd, ['new.ts'])
  assert.ok(first)
  writeFileSync(join(cwd, 'new.ts'), 'two')
  assert.notEqual(candidateSnapshotRef(cwd, ['new.ts']), first)
  assert.equal(candidateSnapshotRef(cwd, ['.env']), null)
  git(cwd, 'add', '--', 'new.ts')
  git(cwd, 'commit', '-qm', 'new file')
  assert.notEqual(candidateSnapshotRef(cwd, ['new.ts']), first)
})

it('P1 对照：ownership 与 ledger 集合相同时（无外部条目）验证本就有效——防修复引入新失效', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'aligned', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1)
})

it('P1：正常会话经持久化往返后仍是 restored + verified（指纹自洽）', () => {
  const { cwd, baseline } = fixture(), first = createPersistentTaskState(cwd, 'roundtrip', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  first.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  first.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

  const second = createPersistentTaskState(cwd, 'roundtrip', baseline)
  assert.equal(second.recovery, 'restored', '两侧同口径的正常会话恢复必须判 restored')
  assert.equal(second.taskLedger.getVerificationStatus(), 'verified')
})

it('W1-2：瞬态计划草稿的写入与释放都不得使代码验证失效', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'draft-neutral', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1, '前置：代码验证已记录')

  // plan mode 里写草稿——tool-pipeline.ts:1726 的真实路径会落一条 file_write 事件。
  const draft = '.rivet/plans/draft-1700000000000.md'
  state.taskLedger.record({ type: 'file_write', path: draft })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
    '草稿不是代码证据：写草稿不得作废此前的代码验证',
  )

  // 退出 plan mode → loop.ts 的 removeEventsByPath 删掉草稿事件。
  state.taskLedger.removeEventsByPath(draft)
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
    '释放草稿同样不得连带作废验证（指纹口径须与草稿无关）',
  )

  // 反向对照：真正的代码写入仍必须使旧验证失效——证明上面的绿不是判据整体失灵。
  writeFileSync(join(cwd, 'owned.ts'), 'next')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0, '代码写入仍必须使旧验证失效')
})

it('T02：草稿释放后同 session 恢复——指纹口径不变、证据不降级、provenance 保留', () => {
  const { cwd, baseline } = fixture()
  const draft = '.rivet/plans/draft-1700000000002.md'
  const first = createPersistentTaskState(cwd, 'draft-restore', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  first.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  first.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  first.taskLedger.record({ type: 'file_write', path: draft })
  // 退出 plan mode 的释放动作（loop.ts::releasePlanModeArtifacts 的同一序列）。
  first.taskLedger.removeEventsByPath(draft)
  first.ownership.unregisterOwned(draft)

  const second = createPersistentTaskState(cwd, 'draft-restore', baseline)
  assert.equal(second.recovery, 'restored', '草稿往返不得让证据降级为 verification_stale')
  assert.equal(getEffectiveVerifications(second.taskLedger.getEvents()).effective.length, 1, '恢复后既有验证仍有效')
  assert.equal(second.ownership.isOwned('owned.ts'), true, 'provenance 保留：代码文件的归属不因草稿释放而丢')
})

it('T03：file_write / 带 path 的 git_action / adoption 多来源共用同一指纹口径——往返一致', () => {
  const { cwd, baseline } = fixture()
  const first = createPersistentTaskState(cwd, 'multi-source', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  first.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  first.taskLedger.record({ type: 'git_action', path: 'staged.ts', meta: { command: 'git add staged.ts' } })
  first.ownership.adoptFiles(['adopted.ts'])
  first.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(first.taskLedger.getEvents()).effective.length, 1, '前置：多来源共存时验证有效')

  const second = createPersistentTaskState(cwd, 'multi-source', baseline)
  assert.equal(second.recovery, 'restored', '记录侧与校验侧必须共用指纹口径（任一侧漏来源即在此变红）')
  assert.equal(getEffectiveVerifications(second.taskLedger.getEvents()).effective.length, 1)
  assert.equal(second.ownership.isOwned('adopted.ts'), true, 'adoption 的 provenance 必须随快照恢复')
})

it('T04：owned 内容变更使既有验证失效（执行上下文维度属 B 批 staleReason，未覆盖）', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'stale-on-change', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'v1')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1)

  writeFileSync(join(cwd, 'owned.ts'), 'v2')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0,
    'owned 内容变化必须使旧验证失效——去掉这条，陈旧证据会被复用',
  )
})

/**
 * W2-1 交付门指纹治理：项目外写入不得毒化指纹。
 *
 * 缺陷：fingerprint()（task-state-persist.ts）对任何解析到 root 之外的路径
 * return null（与敏感路径共用分支），而 fingerprintPaths() 喂入全部 file_write
 * 事件路径 → 往仓库外写一个 fixture（/tmp 或兄弟目录）就使本会话所有验证被判
 * stale、交付门结构性 RED，且本会话无法摘除该事件。
 * 修法：out-of-project 路径排除出指纹输入集（与既有 plan 草稿同一机制），
 * fingerprint() 对 out-of-project 跳过而非作废；敏感路径语义不变（仍 fail-closed）。
 */
it('W2-1：仓库外写入不得毒化指纹——可交付内容的验证不被判 stale', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'out-of-root', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  // 两种越界形态：绝对路径（/tmp/...）与相对上跳（../...）——用户往项目外写 fixture 的真实形态。
  const abs = join(tmpdir(), 'task-state-outsider.js')
  state.taskLedger.record({ type: 'file_write', path: abs })
  state.ownership.registerOwned(abs)
  state.taskLedger.record({ type: 'file_write', path: '../outside-sibling.js' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
    '仓库外写入不是可交付内容，不得使可交付内容的验证被判 stale（否则会话结构性卡死）',
  )
})

it('W2-1 对照：排除越界不得把指纹修成恒不敏感——仓内内容变化仍使旧验证失效', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'out-of-root-guard', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'v1')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'file_write', path: join(tmpdir(), 'task-state-outsider.js') })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1, '前置：排除越界后验证有效')

  writeFileSync(join(cwd, 'owned.ts'), 'v2')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0,
    '仓内内容变化仍必须使旧验证失效——防修复把指纹修成恒不敏感',
  )
})

it('W2-1 边界：敏感路径（.env）保持 fail-closed——本次语义不变', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'sensitive-pin', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'file_write', path: '.env' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0,
    '敏感路径不得被哈希（指纹不可用）→ 验证不作为有效证据（计划非目标：不放松该 fail-closed）',
  )
})

/**
 * W2-1 反序：先验后写——record 包装器的「任意 file_write 判废全部既往验证」
 * 曾不做越界排除：跑完验证后往 /tmp 写个 fixture，既往全部验证被 sticky 标 stale。
 * 与「先写后验」（W2-1）同根、缺一即结构性 RED；stale 不可逆，此顺序无自愈路径。
 */
it('W2-1 反序：先验后写——仓库外写入同样不得作废既往验证', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'out-of-root-late', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1, '前置：验证有效')

  state.taskLedger.record({ type: 'file_write', path: join(tmpdir(), 'task-state-outsider-late.js') })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
    '越界写入不可交付也不参与指纹，不得作废既往验证（与先写后验同根）',
  )
})

it('W2-1 反序对照：先验后写敏感路径仍作废既往验证——判废不得被排除修成恒不敏感', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'sensitive-late', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

  state.taskLedger.record({ type: 'file_write', path: '.env' })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0,
    '敏感路径保持 fail-closed 判废（指纹不可用方向），越界排除不得连带放松',
  )
})

/**
 * W2-2 敏感判据收窄（4251eea67 审查附带观察）：子串匹配误毒化正常文件。
 *
 * 缺陷：旧 SENSITIVE_PATH_RE 的 token|secret|private.*key 是子串匹配——
 * src/tokenizer.ts、src/secretary.ts、.environment.ts、private-keyboard.ts 乃至
 * 仓内 token-store.ts / secrets-store.ts / tokens.css 等 29 个正常文件全部命中
 * sensitive → 指纹 return null → 写入任一即本会话全部验证 stale、交付门结构性 RED
 * （与越界毒化同形，且更常见：这些都是日常会被编辑的源码）。
 * 修法：词元级判据（token/secret 须为完整词元且落凭据形态：整段恰为该词元或数据
 * 容器扩展名白名单）；失效方向选收窄——漏判仅让文件参与哈希，误判即结构性 RED。
 */
it('W2-2：敏感判据词边界对照表——凭据形态判 sensitive、正常源码/文档/模板放行', () => {
  const { cwd } = fixture()
  const sensitive = [
    '.env', '.env.local', '.env.production', 'config/.env',
    'credentials.json', 'dir/credentials.yaml', 'credentials',
    'id_rsa', '.ssh/id_rsa', 'id_rsa.pub', 'my_rsa',
    'server.pem', 'certs/tls.key', 'private.key', 'private_key', 'private-key',
    'api_token.txt', 'token.json', '.token', '_token', 'secrets.json',
    'auth/secrets.yaml', 'my-secret.conf', 'tokens.csv',
  ]
  const inProject = [
    // 旧子串判据的误伤形态（审查点名的三个 + private.*key 误伤）
    'src/tokenizer.ts', 'src/secretary.ts', '.environment.ts', 'src/private-keyboard.ts',
    // 仓内真实文件：token/secret 是标识符不是凭据（源码/样式/文档扩展名永不中）
    'src/auth/token-store.ts', 'src/config/secrets-store.ts', 'src/context/image-tokens.ts',
    'license-server/src/token.ts', 'desktop/src/styles/tokens.css',
    'desktop/src/components/TokenActivityCard.tsx', 'scripts/analyze-output-tokens.ts',
    'docs/output-token-instrumentation.md', 'docs/known-issues/token-explosion-2c25c34e.md',
    // .env 模板无真实凭据（与 tools/sensitive-file-detector 白名单一致）
    '.env.example', '.env.template', 'chat-gateway/.env.sample',
    // 词边界反例：credentials.ts 是源码；keys/ 目录不是 .key 扩展名
    'credentials.ts', 'src/keys/index.ts',
  ]
  for (const p of sensitive) {
    assert.equal(classifyFingerprintPath(cwd, p), 'sensitive', `${p} 必须判 sensitive（fail-closed 不得放松）`)
  }
  for (const p of inProject) {
    assert.equal(classifyFingerprintPath(cwd, p), 'in-project', `${p} 不得误判 sensitive（误判即结构性 RED）`)
  }
})

it('W2-2：旧误伤形态（tokenizer/secretary/.environment）参与指纹——验证有效且可持久化恢复', () => {
  const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'sensitive-narrowed', baseline)
  mkdirSync(join(cwd, 'src'), { recursive: true })
  for (const file of ['src/tokenizer.ts', 'src/secretary.ts', '.environment.ts']) {
    writeFileSync(join(cwd, file), `// ${file}`)
    state.taskLedger.record({ type: 'file_write', path: file })
  }
  state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
    '正常源码文件必须参与指纹而非作废它（旧子串判据在此全灭）',
  )

  // 持久化往返：指纹非 null 且可复算，恢复判 restored（persist 侧的 fingerprint 调用同步覆盖）。
  const second = createPersistentTaskState(cwd, 'sensitive-narrowed', baseline)
  assert.equal(second.recovery, 'restored', '误伤形态参与指纹后，持久化往返不得退化为 verification_stale')
  assert.equal(second.taskLedger.getVerificationStatus(), 'verified')
})

it('W2-2 对照：真实凭据形态仍 fail-closed——上面的绿不是判据整体失灵', () => {
  for (const path of ['.env.local', 'credentials.json', 'id_rsa', 'private.key', 'api_token.txt', 'secrets.json']) {
    const { cwd, baseline } = fixture(), state = createPersistentTaskState(cwd, 'sensitive-kept', baseline)
    state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
    state.taskLedger.record({ type: 'file_write', path })
    state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
    assert.equal(
      getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 0,
      `${path} 是凭据材料：指纹不可用、验证不作为有效证据（收窄不得连带放行真实敏感形态）`,
    )
  }
})

/**
 * 现场（2026-10-17）：验证跑完之后才 adopt 一个外部文件（构建产物，内容未变），
 * 该文件加入指纹路径集合 → 指纹变化 → 此前所有验证被判 stale，交付门从 GREEN
 * 掉回 RED；而那次验证（全量测试）实际覆盖了该文件。
 *
 * 语义：adopt 是归属变更，不是内容变更。文件字节在 adopt 前后完全相同，
 * 指纹衡量的是「可交付内容的字节状态」，不该因它改变。真正的内容变更走
 * file_write 事件——那条路径仍会让旧验证失效（见上面的反向对照）。
 */
it('adopt 只改归属不改内容——不得作废既有验证', () => {
  const { cwd, baseline } = fixture()
  const state = createPersistentTaskState(cwd, 'adopt-after-verify', baseline)
  writeFileSync(join(cwd, 'owned.ts'), 'modified')
  state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
  state.taskLedger.record({ type: 'verification', command: 'npm run test:desktop', status: 'passed', meta: { scope: 'full' } })
  assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1, '前置：验证初始有效')

  writeFileSync(join(cwd, 'adopted.ts'), 'produced by a bash command, never written via file_write')
  state.ownership.adoptFiles(['adopted.ts'])

  assert.equal(
    getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
    'adopt 不改变文件内容，既有验证必须保持有效（否则验证后再认领 = 自己作废自己的证据）',
  )
  assert.equal(state.ownership.isOwned('adopted.ts'), true, '归属仍要记上——要修的是指纹，不是归属')
})

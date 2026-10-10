import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { VerificationMetadata } from '../../tools/types.js'
import { isVerificationIntent } from '../verification-activity.js'

/**
 * Self-Verify Hook — postTurn check that prevents the model from treating
 * surface-level reads (commit summaries, document abstracts, web_fetch
 * snippets) as ground truth.
 *
 * Pattern: model reads metadata/summaries → draws conclusions → next turn
 * builds on unverified conclusions → "一条路走到死".
 *
 * Scope note: the check reads `recentToolHistory`, a sliding window of the
 * last ~5 tool calls (see tool-history-recorder.ts) — NOT strictly "the last
 * turn". For heavy turns the window sits inside the current turn; for light
 * turns it spans the last few steps. Either way the question is the same:
 * "did the recent steps reach a conclusion without any ground-truth check?"
 *
 * Trigger: the recent steps used ONLY read/write-class tools with ZERO
 * ground-truth verification. Verification = run_tests / deliver_task / a bash
 * command that actually runs tests/typecheck/lint/build — a bare `bash cat doc`
 * does NOT count (that is itself just another surface read). On trigger, submits
 * a one-turn advisory asking the model to independently verify before continuing.
 *
 * The 【瑶光】tag is intentional: this is 瑶光's 反身之道 — turning "复现即证"
 * onto the model's own just-made conclusion. When the 瑶光 domain is active the
 * advisory is deduped by AdvisoryBus (the frozen base already carries that
 * discipline); under every other domain it speaks as an outside reminder star.
 *
 * NOT a cumulative metric like CCR P1 — fires on the specific pattern of
 * "concluded without verifying", once per occurrence, via TTL=1 advisory.
 */

// ─── Tool classification ───────────────────────────────────────

const READ_CLASS_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'web_fetch', 'web_search',
  'repo_map', 'repo_graph', 'inspect_project', 'semantic_search',
  'lsp_goto_definition', 'lsp_find_references', 'file_info',
  'recall', 'recall_capsule', 'git',
])

const WRITE_TOOLS = new Set([
  'edit_file', 'write_file', 'hash_edit', 'apply_patch',
])

/** browser_debug/browser 的取证类 action（target 由 toolTargetFromInput 生成，
 *  形如 `screenshot` / `console` / `network http://…`）。open/navigate/click
 *  是操作不是取证，不计。 */
const BROWSER_VERIFY_ACTION_RE = /^(screenshot|snapshot|console|network|network_detail)\b/

/** A tool call that produced independent ground-truth verification. */
export function isVerifyCall(h: { tool: string; target?: string; verificationPurpose?: string }): boolean {
  if (h.tool === 'run_tests' || h.tool === 'deliver_task') return true
  if (h.tool === 'bash') return h.verificationPurpose !== undefined ? h.verificationPurpose !== 'none' : isVerificationIntent(h.target ?? '')
  // UI 场景的 ground truth：浏览器截图/控制台/网络取证与 computer_use 可访问性树
  // 快照都是对渲染物理事实的读取——截图验证了还被催「跑测试」是误报。
  if (h.tool === 'browser_debug' || h.tool === 'browser') return BROWSER_VERIFY_ACTION_RE.test(h.target ?? '')
  if (h.tool === 'computer_use') return /^snapshot\b/.test(h.target ?? '')
  return false
}

/** Read-class, including a non-verifying bash (cat/ls/echo are just reads). */
function isReadOrWriteCall(h: { tool: string; target?: string }): boolean {
  if (READ_CLASS_TOOLS.has(h.tool) || WRITE_TOOLS.has(h.tool)) return true
  if (h.tool === 'bash') return !isVerifyCall(h) // non-verify bash counts as a read
  return false
}

// ─── W5: 粗粒度"验证-改动错配"检测 ────────────────────────────────
// VerificationMetadata.scope 只有 'full' | 'targeted'，不带完整文件列表；
// 精确交集判定不可行（天权评审）。只检测明显错配：改动跨 3+ 模块，
// 但所有验证都是 targeted、无任何 full-scope 验证。

const SCOPE_MISMATCH_MODULE_THRESHOLD = 3

/** 粗粒度模块键：路径前两段（'src/agent/hooks/x.ts' → 'src/agent'）。 */
export function moduleOf(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/')
  return segments.slice(0, Math.min(2, Math.max(1, segments.length - 1))).join('/')
}

export interface ScopeMismatch {
  mismatch: boolean
  moduleCount: number
}

/** 明显错配判定：改动跨 ≥3 模块 + 有验证但全是 targeted。 */
export function detectScopeMismatch(
  filesModified: ReadonlySet<string> | readonly string[],
  verifications: readonly VerificationMetadata[],
): ScopeMismatch {
  const files = [...filesModified]
  const modules = new Set(files.map(moduleOf))
  if (modules.size < SCOPE_MISMATCH_MODULE_THRESHOLD) return { mismatch: false, moduleCount: modules.size }
  if (verifications.length === 0) return { mismatch: false, moduleCount: modules.size } // 零验证由既有检测覆盖
  const hasFullScope = verifications.some(v => v.scope === 'full')
  return { mismatch: !hasFullScope, moduleCount: modules.size }
}

// ─── Hook ───────────────────────────────────────────────────────

export interface SelfVerifyHookDeps {
  /** Only `submit` is used — narrowed for testability (interface segregation). */
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** W5: EvidenceTracker state getter for scope-mismatch detection.
   *  Absent → mismatch check disabled (unchanged behavior). */
  getEvidenceState?: () => { filesModified: Set<string>; verifications: VerificationMetadata[] }
  /** 结构化 verification_required 信号出口（control plane）。与 advisory
   *  并行：advisory 服务下一轮措辞（可核销/自愈），信号让 focus 立即转
   *  verify——不再只是 postTurn 软文。 */
  submitControlSignal?: (signal: import('../control-plane.js').ControlSignal) => void
  /** 证据义务状态机（同义 advisory supersede，Wave 3）：存在未决高风险
   *  delivery/bugfix 义务时，义务块已是"改了没验证"事实的模型可见声音——
   *  跳过泛化 self-verify advisory，避免同一事实两份文案同轮出现。 */
  obligations?: Pick<import('../obligation-tracker.js').ObligationTracker, 'unresolvedHigh'>
  /** W3 债龄阶梯（2026-07-25 advisory-ecology-repair）：验证债判据
   *  （EvidenceTracker.hasVerificationDebt()，与 cognitive frame 同一口径）。
   *  hook 自持连续计数——债连续在场越久，提交的 advisory priority 越高
   *  （成本不对称：债越陈越贵）。缺省 → 阶梯禁用，priority 恒为基线。 */
  getVerificationDebt?: () => boolean
}

// ─── W3 债龄阶梯 ────────────────────────────────────────────────
// 债连续在场 ≥10 轮 → 0.7，≥20 轮 → 0.79 封顶。
// 封顶 0.79 而非 0.85（复盘修复 2026-07-25）：advisory-bus 的 efficacy 负反馈环
// 对 priority ≥ 0.8 fail-open 豁免——0.85 会让陈债提醒永久逃逸「送达多次零采纳
// 则冷却/静默」的负向臂，重现 714c5d9b 式「照发不误」。0.79 与 bus 内正向臂
// 同款红线（见 advisory-bus.ts 正向臂注释），涨价但不豁免问责。
// 阶梯只调 priority，不额外发条目——发射时机仍由 hook 自身判据决定（边沿纪律不破）。
export const DEBT_ESCALATION_STEPS: ReadonlyArray<{ minDuration: number; priority: number }> = [
  { minDuration: 20, priority: 0.79 },
  { minDuration: 10, priority: 0.7 },
]

export function escalatedPriority(base: number, debtDuration: number): number {
  for (const step of DEBT_ESCALATION_STEPS) {
    if (debtDuration >= step.minDuration) return Math.max(base, step.priority)
  }
  return base
}

export function createSelfVerifyHook(deps: SelfVerifyHookDeps): PostTurnRuntimeHook {
  // W5 nag 抑制：同一模块规模只提醒一次；改动继续扩到新模块才再次提醒。
  let lastMismatchModuleCount = 0
  // W3 债龄：验证债连续为真的轮数。债消失即清零——计的是"这笔债"的驻留，
  // 不是会话累计。
  let debtDuration = 0
  return {
    phase: 'postTurn',
    name: 'self-verify',
    run(ctx: RuntimeHookContext) {
      const { recentToolHistory, turn } = ctx.snapshot

      // 债龄计数每轮更新（在一切早退之前——早退轮的债同样在陈化）
      if (deps.getVerificationDebt) {
        debtDuration = deps.getVerificationDebt() ? debtDuration + 1 : 0
      }

      if (recentToolHistory.length === 0) return
      if (turn < 2) return // don't nag on the very first turn

      // W5 粗粒度错配：改动跨多模块但验证全是 targeted 单点。与下方
      // 零验证检测互补——这里针对"验证了，但验证面配不上改动面"。
      if (deps.getEvidenceState) {
        const evidence = deps.getEvidenceState()
        const scope = detectScopeMismatch(evidence.filesModified, evidence.verifications)
        if (scope.mismatch && scope.moduleCount > lastMismatchModuleCount) {
          lastMismatchModuleCount = scope.moduleCount
          deps.advisoryBus.submit({
            key: 'self-verify-scope-mismatch',
            priority: escalatedPriority(0.55, debtDuration),
            category: 'discipline',
            content: `【瑶光】本任务改动已跨 ${scope.moduleCount} 个模块，但已有验证全是 targeted 单点、没有任何 full-scope 验证。引入回归是最常见的交付失败——在收尾前跑一次全量（或逐模块）验证，别等交付门禁 RED。`,
            ttl: 1,
            observe: { turns: 1 },
          })
        }
      }

      const hasVerify = recentToolHistory.some(isVerifyCall)
      if (hasVerify) return // already verified — nothing to flag

      // No verification happened, and every recent step is a read/write
      // (incl. non-verifying bash). Unknown tools (todo_write, delegate_task…)
      // are not classified → stay conservative and don't fire.
      const allReadOrWrite = recentToolHistory.every(isReadOrWriteCall)
      if (!allReadOrWrite) return

      // 结构化信号：kind='verification' + attention → control plane focus 转
      // 'verify'。key 稳定、无自由文本——同一事实反复触发不会抖动 revision。
      deps.submitControlSignal?.({
        key: 'self-verify:verification-required',
        kind: 'verification',
        severity: 'attention',
        summary: 'recent conclusions built on reads/edits without ground-truth verification',
        routeHint: 'status',
        requiresDecision: false,
        ttlTurns: 2,
        cacheImpact: 'none',
      })

      // 同义 supersede：未决高风险 delivery/bugfix 义务在场时，义务块
      // （evidence-obligation projection + control plane）已承载同一事实与
      // 更具体的下一动作——不再叠发泛化 advisory。
      const obligationVoice = (deps.obligations?.unresolvedHigh() ?? [])
        .some(o => o.family === 'delivery' || o.family === 'bugfix')
      if (obligationVoice) return

      deps.advisoryBus.submit({
        key: 'self-verify',
        priority: escalatedPriority(0.58, debtDuration),
        category: 'discipline',
        content: '【瑶光】最近几步你基于读取/编辑给出了结论，但没有独立验证（未运行测试或类型检查）。在继续推进之前，请先确认该结论有 ground truth 支撑——跑测试/读原文/用原输入自检，而非信任摘要或自己的判断。',
        ttl: 1,
        // P1a 核销 + Phase 2 挂起观察：模型常在下一轮自发验证——挂 1 个周期,
        // 窗口内 expect 已满足则自愈撤销（ICU 延迟确认降误报）,否则准时送达。
        expect: { kind: 'verify_attempted', withinTurns: 2 },
        observe: { turns: 1 },
      })
    },
  }
}

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt } from '../static.js'
import { createDefaultToolRegistry } from '../../tools/default-registry.js'

/**
 * Kernel Budget Tests — 防止"被训练模式"的结构性守门
 *
 * 来自 docs/superpowers/specs/2026-05-20-agent-experience-trained-mode-analysis.md
 * 天枢自己的复盘：
 * - identity 信号弱 → 大模型默认行为接管 → 道歉、犹豫、不调用工具
 * - 工具选择过多 → 认知过载 → 退回不选择
 *
 * 这些测试把"健康基线"固化为合约，新增 prompt/工具时如果踩线就 fail。
 * 不阻塞紧急修复（可手动调阈值），只防止悄悄退化。
 *
 * 当前基线（2026-05-24 测量）：
 * - BASE_PROMPT: 152 行
 * - identity+beliefs: 10 行（6.6%）
 * - default registry tools: 17
 * - main.tsx 注册补充: ~5（delegate_task/delegate_batch/undo/recall/ask_user_question）
 * - 总计 ~22 工具
 *
 * 警戒线（来自复盘建议）：
 * - BASE_PROMPT ≤ 200 行（当前 152）
 * - identity+beliefs ≥ 5%（复盘 4.2 建议 3 警戒线 1.5%，留更宽缓冲）
 * - 工具总数 ≤ 25（复盘 4.2 建议 2）
 */
describe('Kernel Budget — structural guards against trained-mode degradation', () => {
  const prompt = buildSystemPrompt({ tools: [] })
  const lines = prompt.split('\n')

  describe('BASE_PROMPT length', () => {
    it('stays under 246 lines (trained-mode dilution guard)', () => {
      // 2026-07-13: 阈值 210→240。恢复三层收敛方法论（分类/交叉验证/综合判断）到
      // tool-usage 段，batch-convergence-hook 只在 ≥5 工具时触发，2-4 工具场景下
      // 模型失去收敛框架导致任务质量下降。4 行方法论必须常驻静态提示词。
      // identity_volume 守卫（≥5%）仍然通过，identity 信号未被稀释。
      // 2026-09-22: 阈值 240→246，为 <output-economy> 段（4 行：开/闭标签 + 正文 + 空行）让位。
      // 依据：输出计费实测中 75–90% 落在 reasoning，静态提示词补一条"默认短"纪律是
      // 成本最高杠杆（简单编码任务 599→124 tokens）；identity 占比实测 5.33%（下限 5%）。
      assert.ok(
        lines.length <= 246,
        `BASE_PROMPT is ${lines.length} lines (limit: 246). ` +
          `Adding more text dilutes identity signal — see ` +
          `docs/superpowers/specs/2026-05-20-agent-experience-trained-mode-analysis.md ` +
          `section 3.2.A. If you really need this, raise the limit AND audit identity_volume.`,
      )
    })

    it('is at least 50 lines (sanity check — kernel must contain identity/beliefs/rules)', () => {
      assert.ok(lines.length >= 50, 'BASE_PROMPT suspiciously short')
    })
  })

  describe('Identity volume (irreducible kernel signal strength)', () => {
    function extractTaggedBlock(text: string, openTag: string, closeTag: string): string {
      const openIdx = text.indexOf(openTag)
      const closeIdx = text.indexOf(closeTag)
      if (openIdx === -1 || closeIdx === -1) return ''
      return text.slice(openIdx, closeIdx + closeTag.length)
    }

    it('identity block exists and is non-empty', () => {
      const block = extractTaggedBlock(prompt, '<identity>', '</identity>')
      assert.ok(block.length > 0, '<identity> block missing — kernel destroyed')
      assert.ok(block.split('\n').length >= 2, '<identity> too short — needs at least name + one sentence')
    })

    it('beliefs block exists and contains at least 3 situational triggers', () => {
      const block = extractTaggedBlock(prompt, '<beliefs>', '</beliefs>')
      assert.ok(block.length > 0, '<beliefs> block missing — kernel destroyed')
      const triggerCount = (block.match(/当你|当用户/g) ?? []).length
      assert.ok(
        triggerCount >= 3,
        `<beliefs> contains only ${triggerCount} situational triggers — agent identity needs richer behavioral structure`,
      )
    })

    it('identity + beliefs together occupy at least 5% of BASE_PROMPT (signal strength guard)', () => {
      const idBlock = extractTaggedBlock(prompt, '<identity>', '</identity>')
      const beliefBlock = extractTaggedBlock(prompt, '<beliefs>', '</beliefs>')
      const kernelLines = idBlock.split('\n').length + beliefBlock.split('\n').length
      const totalLines = lines.length
      const ratio = kernelLines / totalLines

      assert.ok(
        ratio >= 0.05,
        `Identity volume is ${(ratio * 100).toFixed(1)}% (kernel: ${kernelLines} lines / total: ${totalLines}). ` +
          `Below 5% means identity signal is being drowned out by tool/rule descriptions. ` +
          `Either trim other sections or strengthen identity. ` +
          `See trained-mode-analysis.md section 4.2 suggestion 3.`,
      )
    })
  })

  describe('Tool count budget (cognitive load guard)', () => {
    it('default tool registry stays under 26 tools', () => {
      const registry = createDefaultToolRegistry()
      const count = registry.getAll().length
      // 2026-07-01: 阈值 25→26，为后台任务控制工具 `job`(list/await/logs/kill) 让出一格。
      // 这是一次「有意识、有记录」的抬阈（guardrail 本意是防止悄悄退化，非绝对禁止增长）：
      // `job` 提供 await 这一主控必需的异步能力，与现有任何工具都不重叠，不属于冗余膨胀。
      assert.ok(
        count <= 26,
        `Default registry has ${count} tools (limit: 26). ` +
          `Beyond ~26, agents experience choice overload and retreat to most-familiar tools ` +
          `(or no tool, lapsing into trained mode). ` +
          `See trained-mode-analysis.md section 3.2.B. ` +
          `Before adding: can you merge two tools, or remove a low-use one?`,
      )
    })

    it('default registry has at least the core tools', () => {
      const registry = createDefaultToolRegistry()
      const required = ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'run_tests']
      for (const name of required) {
        assert.ok(registry.has(name), `core tool missing: ${name}`)
      }
    })

    it('minimal 完整装配（kernel + bootstrap）≤ 29——漂移棘轮', () => {
      // 2026-07-19 工具审计：会话实测进 44 个工具而本预算只盯 kernel 26——
      // 闸门看错了门。preset 三档落地后，minimal 完整装配钉死在 ≤29
      // （当前 27——2026-07-22 裁 file_info/session_vitals/update_goal）。
      // 抬阈必须在 commit message 写明理由（同 job 抬阈先例）。
      const kernel = createDefaultToolRegistry().getAll().length
      const bootstrapMinimal = [
        'delegate_task', 'delegate_batch', 'ask_user_question', 'apply_patch',
        'deliver_task', 'plan_task', 'recall_capsule',
      ]
      assert.ok(
        kernel + bootstrapMinimal.length <= 29,
        `minimal full assembly = ${kernel + bootstrapMinimal.length} (limit: 29). ` +
          `See tool-preset.ts — 增长要过档位评审，不许悄悄漂移。`,
      )
    })
  })
})

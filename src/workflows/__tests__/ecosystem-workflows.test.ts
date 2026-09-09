import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWritingPlanPrompt,
  defaultPlanPath,
  formatPlanDate,
  parseSlashInput,
  resolveEcosystemWorkflowInput,
  semanticPlanSlug,
  slugifyFeatureName,
} from '../ecosystem-workflows.js'

describe('ecosystem workflow helpers', () => {
  it('formats local plan dates as YYYY-MM-DD', () => {
    assert.equal(formatPlanDate(new Date(2026, 4, 19)), '2026-05-19')
  })

  it('slugifies feature names for plan paths', () => {
    assert.equal(slugifyFeatureName('Add Context7 MCP preset!'), 'add-context7-mcp-preset')
    assert.equal(slugifyFeatureName('编写计划 工作流'), '编写计划-工作流')
  })

  it('derives short semantic plan slugs instead of using the full prompt', () => {
    assert.equal(semanticPlanSlug('Add Context7 MCP preset!'), 'add-context7-mcp-preset')
    assert.equal(semanticPlanSlug('编写计划 工作流'), '编写计划-工作流')

    const longFeature = '你说的很好，把这个内容记录到设计文档。如果行数太长就拆分两个，一个背景说明，一个是设计文档。其次，即便我使用 claude code 也是多个会话来并行执行。单会话的场景在现在的生产力下已经几乎不存在了。'
    const slug = semanticPlanSlug(longFeature)

    assert.equal(slug, '多会话并行开发设计文档')
    assert.ok(Buffer.byteLength(slug, 'utf8') <= 96)
  })

  it('builds default docs/superpowers plan path', () => {
    assert.equal(
      defaultPlanPath('Add Context7 MCP preset', new Date(2026, 4, 19)),
      'docs/superpowers/plans/2026-05-19-add-context7-mcp-preset.md',
    )
    assert.equal(
      defaultPlanPath('你说的很好，把这个内容记录到设计文档。如果行数太长就拆分两个，一个背景说明，一个是设计文档。其次，即便我使用 claude code 也是多个会话来并行执行。单会话的场景在现在的生产力下已经几乎不存在了。', new Date(2026, 4, 25)),
      'docs/superpowers/plans/2026-05-25-多会话并行开发设计文档.md',
    )
  })

  it('parses slash input preserving multi-word arguments', () => {
    assert.deepEqual(parseSlashInput('/plan add workflow aliases'), {
      command: '/plan',
      args: 'add workflow aliases',
    })
    assert.equal(parseSlashInput('plain prompt'), null)
  })

  it('builds writing-plans prompt with planning quality gates', () => {
    const prompt = buildWritingPlanPrompt({
      feature: 'Add workflow aliases',
      date: new Date(2026, 4, 19),
    })

    assert.ok(prompt.includes('创建实现计划：Add workflow aliases'))
    assert.ok(prompt.includes('计划模板路由：任务深度'))
    assert.ok(prompt.includes('docs/superpowers/plans/2026-05-19-add-workflow-aliases.md'))
    assert.ok(prompt.includes('不要写实现代码'))
    assert.ok(prompt.includes('文件名用简短业务语义命名'))
    assert.ok(prompt.includes('TDD 形态：写失败测试 → 确认失败 → 最小实现'))
    assert.ok(prompt.includes('禁用占位符：'))
    assert.ok(prompt.includes('TODO / TBD / 待定 / 后续实现 / 补充细节'))
    assert.ok(prompt.includes('完成前自检：'))
    assert.ok(prompt.includes('规格覆盖'))
    assert.ok(prompt.includes('子代理驱动（推荐）'))
    assert.ok(prompt.includes('内联执行'))
  })

  it('resolves /plan and /write-plan into workflow prompts', () => {
    const date = new Date(2026, 4, 19)
    const plan = resolveEcosystemWorkflowInput('/plan add skill loader', { date })
    const writePlan = resolveEcosystemWorkflowInput('/write-plan add skill loader', { date })

    assert.equal(plan?.command, '/plan')
    assert.equal(writePlan?.command, '/write-plan')
    assert.ok(plan?.prompt.includes('创建实现计划：add skill loader'))
    assert.ok(writePlan?.prompt.includes('创建实现计划：add skill loader'))
  })

  it('resolves /team into a team-mode workflow prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/team docs/superpowers/plans/loop-split-v3.md')

    assert.equal(resolved?.command, '/team')
    assert.ok(resolved?.prompt.includes('团队模式核心骨架'))
    assert.ok(resolved?.prompt.includes('plan_task'))
    assert.ok(resolved?.prompt.includes('team_orchestrate'))
    assert.ok(resolved?.prompt.includes('patcher workers as 天梁 executors'))
    assert.ok(resolved?.prompt.includes('deliver_task'))
  })

  it('resolves /team max into planning-first team workflow prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/team max refactor loop pipeline')

    assert.equal(resolved?.command, '/team')
    assert.ok(resolved?.prompt.includes('/team max'))
    assert.ok(resolved?.prompt.includes('multi-perspective planning'))
    assert.ok(resolved?.prompt.includes('risk audit'))
  })

  it('/team prompt 波次默认自动推进——不要求 model 每波手动再次调用 team_orchestrate', () => {
    const resolved = resolveEcosystemWorkflowInput('/team docs/superpowers/plans/loop-split-v3.md')

    assert.equal(resolved?.command, '/team')
    assert.ok(resolved?.prompt.includes('auto-advance'))
    // 旧出口文案已移除：不再指示 model「若输出显示还有波次，手动再调 team_orchestrate 传 fromWave」。
    assert.ok(!resolved?.prompt.includes('fromWave: <next wave index>'))
  })

  it('/team prompt fromWave 仅用于人工恢复（中断后从指定波次续跑）', () => {
    const resolved = resolveEcosystemWorkflowInput('/team docs/superpowers/plans/loop-split-v3.md')

    assert.equal(resolved?.command, '/team')
    assert.ok(resolved?.prompt.includes('fromWave'))
    assert.ok(resolved?.prompt.includes('manual recovery'))
  })

  it('returns usage prompt for empty /team args', () => {
    const resolved = resolveEcosystemWorkflowInput('/team')

    assert.equal(resolved?.command, '/team')
    assert.ok(resolved?.prompt.includes('Team usage:'))
  })

  it('resolves /council into a council_convene workflow prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/council 拆分 loop.ts 的方案是否遗漏回滚')

    assert.equal(resolved?.command, '/council')
    assert.ok(resolved?.prompt.includes('星域议事会'))
    assert.ok(resolved?.prompt.includes('council_convene'))
    assert.ok(resolved?.prompt.includes('拆分 loop.ts 的方案是否遗漏回滚'))
    assert.ok(resolved?.prompt.includes('只出计划不执行'))
    // 解耦:议事会 prompt 不得诱导 model 走 team 执行链(议事会本身不执行)。
    assert.ok(resolved?.prompt.includes('绝不触发 team_orchestrate'))
    // W-C7 完成后引导:planJson model-handoff —— 询问执行,确认后 content 内嵌的
    // council-plan-json 原样作为 team_orchestrate 的 planJson 交接(不经 /team 重解析)。
    assert.ok(resolved?.prompt.includes('council-plan-json'))
    assert.ok(resolved?.prompt.includes('planJson 参数'))
    assert.ok(resolved?.prompt.includes('主动询问用户是否执行'))
  })

  it('parses --seats flag and injects custom seats into prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/council review the plan --seats tianquan,tianfu,tianji')

    assert.equal(resolved?.command, '/council')
    assert.ok(resolved?.prompt.includes('review the plan'))
    // 席位应出现在 council_convene 调用参数中。
    assert.ok(resolved?.prompt.includes('tianquan'))
    assert.ok(resolved?.prompt.includes('tianfu'))
    assert.ok(resolved?.prompt.includes('tianji'))
    assert.ok(resolved?.prompt.includes('authority'))
    // 不应再提“默认配置”。
    assert.ok(!resolved?.prompt.includes('无需自行指定 seats'))
  })

  it('parses single --seats flag value', () => {
    const resolved = resolveEcosystemWorkflowInput('/council security audit --seats tianfu')

    assert.equal(resolved?.command, '/council')
    assert.ok(resolved?.prompt.includes('security audit'))
    assert.ok(resolved?.prompt.includes('tianfu'))
    assert.ok(!resolved?.prompt.includes('无需自行指定 seats'))
  })

  it('seats without --seats flag still uses default config from DEFAULT_COUNCIL_SEATS', () => {
    const resolved = resolveEcosystemWorkflowInput('/council just review')

    assert.ok(resolved?.prompt.includes('just review'))
    // 默认席位从 DEFAULT_COUNCIL_SEATS 常量派生，含 authority id。
    assert.ok(resolved?.prompt.includes('tianquan'))
    assert.ok(resolved?.prompt.includes('tianfu'))
    assert.ok(resolved?.prompt.includes('tianxuan'))
    assert.ok(resolved?.prompt.includes('无需自行指定 seats'))
  })

  it('parses --seats with space-separated values', () => {
    const resolved = resolveEcosystemWorkflowInput('/council audit --seats tianfu tianxuan')

    assert.ok(resolved?.prompt.includes('audit'))
    assert.ok(resolved?.prompt.includes('tianfu'))
    assert.ok(resolved?.prompt.includes('tianxuan'))
    assert.ok(!resolved?.prompt.includes('tianquan'))
    assert.ok(!resolved?.prompt.includes('无需自行指定 seats'))
  })

  it('--seats with no value degrades to default seats and strips noise from objective', () => {
    // `--seats` 后只有逗号/空白、无实际席位 → 不注入空 authority，降级默认席。
    const resolved = resolveEcosystemWorkflowInput('/council audit the rollback --seats ,,')

    assert.equal(resolved?.command, '/council')
    // objective 干净：剥离 --seats 段，不残留噪音。
    assert.ok(resolved?.prompt.includes('audit the rollback'))
    assert.ok(!resolved?.prompt.includes('--seats'))
    // 降级默认席：不得注入空 authority，须回到默认配置文案。
    assert.ok(!resolved?.prompt.includes('authority: ""'))
    assert.ok(resolved?.prompt.includes('无需自行指定 seats'))
  })

  it('returns usage prompt for empty /council args', () => {
    const resolved = resolveEcosystemWorkflowInput('/council')

    assert.equal(resolved?.command, '/council')
    assert.ok(resolved?.prompt.includes('Council usage:'))
    assert.ok(resolved?.prompt.includes('--rounds'))
  })

  it('parses --rounds flag and injects rounds into prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/council review the plan --rounds 2')

    assert.equal(resolved?.command, '/council')
    assert.ok(resolved?.prompt.includes('review the plan'))
    assert.ok(resolved?.prompt.includes('rounds: 2'))
    assert.ok(resolved?.prompt.includes('多轮辩论'))
  })

  it('--rounds with no valid value degrades to default (no rounds injected)', () => {
    const resolved = resolveEcosystemWorkflowInput('/council review --rounds abc')

    assert.equal(resolved?.command, '/council')
    assert.ok(resolved?.prompt.includes('review'))
    assert.ok(resolved?.prompt.includes('单轮会诊'))
    assert.ok(!resolved?.prompt.includes('rounds:'))
  })

  it('--rounds 0 / 3 / 5 (out of range, 上限 2) degrades to default', () => {
    for (const bad of ['0', '3', '5']) {
      const r = resolveEcosystemWorkflowInput(`/council review --rounds ${bad}`)
      assert.ok(r?.prompt.includes('单轮会诊'), `--rounds ${bad} 应降级单轮`)
      assert.ok(!r?.prompt.includes('rounds:'), `--rounds ${bad} 不应注入 rounds 参数`)
    }
  })

  it('--seats and --rounds combine in any order', () => {
    const a = resolveEcosystemWorkflowInput('/council audit --seats tianquan,tianfu --rounds 2')
    assert.ok(a?.prompt.includes('audit'))
    assert.ok(a?.prompt.includes('tianquan'))
    assert.ok(a?.prompt.includes('rounds: 2'))

    const b = resolveEcosystemWorkflowInput('/council audit --rounds 2 --seats tianquan,tianfu')
    assert.ok(b?.prompt.includes('audit'))
    assert.ok(b?.prompt.includes('tianquan'))
    assert.ok(b?.prompt.includes('rounds: 2'))
  })

  it('default (no --rounds) still says 单轮会诊 and has no rounds param', () => {
    const resolved = resolveEcosystemWorkflowInput('/council just review')

    assert.ok(resolved?.prompt.includes('单轮会诊'))
    assert.ok(!resolved?.prompt.includes('rounds:'))
  })

  it('resolves /scout into a scout-swarm workflow prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/scout 全面体检这个仓库能否直接启动')

    assert.equal(resolved?.command, '/scout')
    assert.ok(resolved?.prompt.includes('巡天侦察蜂群'))
    assert.ok(resolved?.prompt.includes('全面体检这个仓库能否直接启动'))
    // 四步契约的关键锚点：先摸底、维度切分、delegate_batch 派发、实测清单交付。
    assert.ok(resolved?.prompt.includes('先侦察后派发'))
    assert.ok(resolved?.prompt.includes('按关注维度切分，不按文件分片'))
    assert.ok(resolved?.prompt.includes('delegate_batch'))
    assert.ok(resolved?.prompt.includes('code_scout'))
    assert.ok(resolved?.prompt.includes('timeoutMs: 900000'))
    assert.ok(resolved?.prompt.includes('实测核对清单'))
    assert.ok(resolved?.prompt.includes('exit code'))
    // 只读契约：不写文件、不走 team 编排、修复走 plan_task 交接。
    assert.ok(resolved?.prompt.includes('不写文件'))
    assert.ok(resolved?.prompt.includes('plan_task'))
    // 出口按规模分流：中小修复走 plan_task；大型多维改造映射 starflow draftItems。
    assert.ok(resolved?.prompt.includes('先问用户是否修复'))
    assert.ok(resolved?.prompt.includes('starflow 的 draftItems'))
    assert.ok(resolved?.prompt.includes('id: 短slug'))
    assert.ok(resolved?.prompt.includes('不要在 /scout 流程里直接改文件'))
  })

  it('/scout without --dims lets the model pick 2-5 dimensions', () => {
    const resolved = resolveEcosystemWorkflowInput('/scout 诊断构建失败')

    assert.ok(resolved?.prompt.includes('自选 2-5 个'))
    assert.ok(!resolved?.prompt.includes('用户指定的'))
  })

  it('parses --dims flag and injects user dimensions into prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/scout 全面体检 --dims 前端,后端,集成')

    assert.equal(resolved?.command, '/scout')
    assert.ok(resolved?.prompt.includes('全面体检'))
    assert.ok(!resolved?.prompt.includes('--dims'))
    assert.ok(resolved?.prompt.includes('用户指定的 3 个：前端 · 后端 · 集成'))
    assert.ok(resolved?.prompt.includes('不增不减'))
    assert.ok(!resolved?.prompt.includes('自选 2-5 个'))
  })

  it('--dims caps at 5 dimensions (delegate_batch batch limit)', () => {
    const resolved = resolveEcosystemWorkflowInput('/scout 体检 --dims a,b,c,d,e,f,g')

    assert.ok(resolved?.prompt.includes('用户指定的 5 个'))
    assert.ok(!resolved?.prompt.includes(' f '))
  })

  it('--dims with no value degrades to model-picked dimensions and strips noise', () => {
    const resolved = resolveEcosystemWorkflowInput('/scout 体检启动链路 --dims ,,')

    assert.ok(resolved?.prompt.includes('体检启动链路'))
    assert.ok(!resolved?.prompt.includes('--dims'))
    assert.ok(resolved?.prompt.includes('自选 2-5 个'))
  })

  it('returns usage prompt for empty /scout args', () => {
    const resolved = resolveEcosystemWorkflowInput('/scout')

    assert.equal(resolved?.command, '/scout')
    assert.ok(resolved?.prompt.includes('Scout usage:'))
    assert.ok(resolved?.prompt.includes('--dims'))
  })

  it('resolves /plan close into a plan_close tool prompt with apply by default', () => {
    const resolved = resolveEcosystemWorkflowInput('/plan close docs/superpowers/plans/demo.md --tasks 1-7 --verified npx tsc --noEmit --delivery YELLOW --note external files present')

    assert.equal(resolved?.command, '/plan')
    assert.ok(resolved?.prompt.includes('Use the plan_close tool'))
    assert.ok(resolved?.prompt.includes('- file_path: docs/superpowers/plans/demo.md'))
    assert.ok(resolved?.prompt.includes('- tasks: 1-7'))
    assert.ok(resolved?.prompt.includes('- apply: true'))
    assert.ok(!resolved?.prompt.includes('Preview only'))
    assert.ok(resolved?.prompt.includes('npx tsc --noEmit'))
    assert.ok(resolved?.prompt.includes('- deliveryState: YELLOW'))
    assert.ok(resolved?.prompt.includes('- note: external files present'))
  })

  it('resolves /plan-close into a plan_close tool prompt with apply by default', () => {
    const resolved = resolveEcosystemWorkflowInput('/plan-close docs/superpowers/plans/demo.md --tasks all')

    assert.equal(resolved?.command, '/plan-close')
    assert.ok(resolved?.prompt.includes('Use the plan_close tool'))
    assert.ok(resolved?.prompt.includes('- tasks: all'))
    assert.ok(resolved?.prompt.includes('- apply: true'))
    assert.ok(!resolved?.prompt.includes('Preview only'))
  })

  it('supports --preview to keep plan_close in preview mode', () => {
    const resolved = resolveEcosystemWorkflowInput('/plan-close docs/superpowers/plans/demo.md --tasks all --preview')

    assert.equal(resolved?.command, '/plan-close')
    assert.ok(resolved?.prompt.includes('- apply: false'))
    assert.ok(resolved?.prompt.includes('Preview only; do not write the file.'))
  })

  it('still accepts explicit --apply for compatibility', () => {
    const resolved = resolveEcosystemWorkflowInput('/plan-close docs/superpowers/plans/demo.md --tasks all --apply')

    assert.equal(resolved?.command, '/plan-close')
    assert.ok(resolved?.prompt.includes('- apply: true'))
    assert.ok(!resolved?.prompt.includes('Preview only'))
  })

  it('keeps /write-plan close as writing-plans workflow', () => {
    const resolved = resolveEcosystemWorkflowInput('/write-plan close workflow docs')

    assert.equal(resolved?.command, '/write-plan')
    assert.ok(resolved?.prompt.includes('创建实现计划：close workflow docs'))
    assert.ok(!resolved?.prompt.includes('Use the plan_close tool'))
  })

  it('returns usage prompt for invalid plan close args', () => {
    const resolved = resolveEcosystemWorkflowInput('/plan close docs/superpowers/plans/demo.md')

    assert.equal(resolved?.command, '/plan')
    assert.ok(resolved?.prompt.includes('Plan close usage:'))
  })

  it('does not resolve empty or unrelated commands', () => {
    assert.equal(resolveEcosystemWorkflowInput('/plan'), null)
    assert.equal(resolveEcosystemWorkflowInput('/quality-gate'), null)
    assert.equal(resolveEcosystemWorkflowInput('plain prompt'), null)
  })
})

describe('workflow requiredTools declaration', () => {
  it('/council 只声明 council_convene——team_orchestrate 已升 CORE 无需挂载', () => {
    const resolved = resolveEcosystemWorkflowInput('/council 审查回滚方案')
    assert.deepEqual(resolved?.requiredTools, ['council_convene'])
  })

  it('/council 用法提示（空参数）不声明工具——没有真实调用发生', () => {
    const resolved = resolveEcosystemWorkflowInput('/council')
    assert.equal(resolved?.requiredTools, undefined)
  })

  it('/team 不声明 requiredTools——team_orchestrate 已升 CORE 默认可见', () => {
    const resolved = resolveEcosystemWorkflowInput('/team docs/superpowers/plans/x.md')
    assert.equal(resolved?.requiredTools, undefined)
  })

  it('/team 用法提示（空参数）不声明工具', () => {
    const resolved = resolveEcosystemWorkflowInput('/team')
    assert.equal(resolved?.requiredTools, undefined)
  })

  it('/scout 不声明 requiredTools——delegate_batch 在 CORE 层默认可见', () => {
    const resolved = resolveEcosystemWorkflowInput('/scout 全面体检')
    assert.equal(resolved?.requiredTools, undefined)
  })

  it('/plan 等纯 prompt workflow 不声明工具', () => {
    const resolved = resolveEcosystemWorkflowInput('/plan add feature', { date: new Date(2026, 6, 2) })
    assert.equal(resolved?.requiredTools, undefined)
  })

  it('所有 workflow 声明的 requiredTools 必须真实存在于 EXTENDED 层', async () => {
    const { isExtendedTool } = await import('../../agent/tool-tiers.js')
    for (const input of ['/council 审查', '/team plan.md', '/team max 重构']) {
      const r = resolveEcosystemWorkflowInput(input)
      for (const t of r?.requiredTools ?? []) {
        assert.ok(isExtendedTool(t), `${input} 声明的 ${t} 不在 EXTENDED_TOOLS——要么拼错要么该工具已改层`)
      }
    }
  })
})

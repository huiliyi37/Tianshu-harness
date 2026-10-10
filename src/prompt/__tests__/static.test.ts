import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt, detectModelFamily } from '../static.js'

describe('buildSystemPrompt', () => {
  it('wraps identity in <identity> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<identity>'))
    assert.ok(prompt.includes('</identity>'))
    assert.ok(prompt.includes('天枢'))
  })

  it('wraps rules in <rules> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<rules>'))
    assert.ok(prompt.includes('</rules>'))
    assert.ok(prompt.includes('evidence-scope'))
  })

  it('includes context-update-protocol rule for delta semantics', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('context-update-protocol'), 'should contain the rule name')
    assert.ok(prompt.includes('累积的'), 'should describe cumulative semantics')
    assert.ok(prompt.includes('未变化'), 'should explain absent = unchanged')
  })

  it('wraps tool usage in <tool-usage> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<tool-usage>'))
    assert.ok(prompt.includes('</tool-usage>'))
  })

  it('gated tools named in the prompt carry explicit gate/degradation notes (issue #413)', () => {
    // 回归：提示词不得无条件指引调用默认运行时不存在的工具。
    // apply_patch / read_section / inspect_project / repo_graph 属 EXTENDED
    //（gateToolDefinitions 默认摘除，需 /tools enable 或 extraCore 挂回）；
    // semantic_search / inspect_project / repo_graph 在 MINIMAL_EXCLUDES
    //（仅 full 档注册：RIVET_TOOL_PRESET=full）。
    // 若提示词提及其中之一，同一行必须写清启用条件与降级路径。
    const prompt = buildSystemPrompt({ tools: [] })
    const gated = ['apply_patch', 'semantic_search', 'inspect_project', 'repo_graph', 'read_section']
    const gateMarker = /EXTENDED|full 档|RIVET_TOOL_PRESET|\/tools enable/
    for (const name of gated) {
      for (const line of prompt.split('\n')) {
        if (line.includes(name)) {
          assert.ok(gateMarker.test(line), `提及门控工具 ${name} 却未写清门控/降级：${line.trim()}`)
        }
      }
    }
  })

  it('selects reader-facing structure without imposing completion headings', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    const delivery = prompt.match(/<delivery-contract>([\s\S]*?)<\/delivery-contract>/)![1]!
    assert.ok(delivery.includes('先回答当前问题'), '先回答用户关心的结果')
    for (const rule of ['解释因果用短段落', '并列事项用 markdown 列表', '执行顺序用编号', '比较或映射用表格']) {
      assert.ok(delivery.includes(rule), `信息关系应有对应表达形式：${rule}`)
    }
    assert.ok(delivery.includes('只有一个简单结论时直接回答'), '简单回答不强制分栏')
    assert.ok(delivery.includes('每段或每项围绕一个主要意思'), '分点不能只是给长段落加圆点')
    assert.ok(delivery.includes('不要求固定标题'), '必填信息不等于固定栏目')
    for (const retired of ['固定四项', '### 做了什么', '### 效果预期', '### 过程发现', '### 后续建议', '交付四项']) {
      assert.ok(!prompt.includes(retired), `旧模板不得从其他段落回流：${retired}`)
    }
    assert.ok(delivery.includes('没有额外建议时直接结束'), '不为填栏目追加建议')
  })

  it('keeps commit facts after the result and discloses incomplete delivery honestly', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('已提交的代码任务随后给「已提交：<短 hash> <message 首行>」'))
    assert.ok(prompt.includes('涉及文件及改动性质'), '保留可核实的文件变更范围')
    assert.ok(prompt.includes('未提交、降级、部分交付照实说'), '无提交/降级时不得编造')
    assert.ok(prompt.includes('不要让提交记录或文件清单代替结果说明'))
  })

  it('teaches parallel fan-out of independent探索 tools', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('并行'), '应含并行指令')
    assert.ok(
      prompt.includes('一条消息') || prompt.includes('单条消息') || prompt.includes('一次发出'),
      '应教在一条消息里一起发多个工具',
    )
  })

  it('warns不要在并行批中插入写操作 (contiguous-block constraint)', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 引擎只并行"连续"safe 块；写操作会切断批次 → 必须显式告诫
    assert.ok(
      prompt.includes('写操作') || prompt.includes('edit_file') || prompt.includes('write_file'),
      '应提醒并行批中不要混入写操作',
    )
  })

  it('no longer teaches串行 "由粗到细" navigation chain', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 旧的串行链描述应被移除或改写，避免与并行指令冲突
    assert.ok(!prompt.includes('由粗到细'), '串行链描述应已移除')
  })

  it('scopes fan-out to read-only tools — serial tools sent one at a time', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('只读工具可一批发'), '应限定只读工具可批发')
    assert.ok(
      prompt.includes('run_tests') && prompt.includes('git'),
      '应点名 run_tests/git 等串行工具（防过度泛化）',
    )
    assert.ok(
      prompt.includes('逐个串行'),
      '应要求串行工具逐个执行',
    )
  })

  it('wraps workflow in <workflow> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<workflow>'))
    assert.ok(prompt.includes('</workflow>'))
  })

  it('includes external-source-verification rule with concrete methods', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('external-source-verification'), '应有独立的外部方案验证规则')
    assert.ok(prompt.includes('RED→GREEN'), '应含复现验证方法')
    assert.ok(prompt.includes('恒等式自检'), '应含数据自检方法')
    assert.ok(prompt.includes('格式完整不是可信度信号'), '应含核心原则')
    // workflow 应有触发指针但不重复核验方法细节
    assert.ok(prompt.includes('external-source-verification 规则'), 'workflow 应指向规则名')
    // 审查报告必须被显式归类为外部来源
    assert.ok(prompt.includes('审查报告'), 'external-source-verification 应显式覆盖审查报告')
    assert.ok(prompt.includes('不等于已验证事实'), '应明确审查标记不等于已验证')
  })

  it('includes lossy-observation-discipline rule', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('lossy-observation-discipline'), '应有有损观测纪律规则')
    assert.ok(prompt.includes('禁止从中推出负向结论'), '应含负向结论禁止条款')
    assert.ok(prompt.includes('PARTIAL view'), '应显式覆盖 PARTIAL view 标记')
    assert.ok(prompt.includes('truncated'), '应覆盖 truncated 场景')
  })

  it('evidence-scope carries the self-verification kernel (merged from self-verification rule)', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // self-verification 规则已并入 evidence-scope（减少重叠规则的认知负担）。
    // 约束内核必须有落点——这是合并不是删减。
    assert.ok(prompt.includes('自己的结论和外部声称适用同一验证标准'), 'evidence-scope 应含"自己的结论适用同一验证标准"内核')
    assert.ok(prompt.includes('我推过所以可信'), '应保留"我推过所以可信"反身验证核心')
    assert.ok(prompt.includes('物理事实'), '应含物理事实 vs 脑补模型的自检要求')
    assert.ok(prompt.includes('异常信号'), '应保留"异常信号比内容可信"差异化内核')
  })

  it('evidence-scope carries the cross-layer claim discipline kernel (merged)', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // cross-layer-claim-discipline 已并入 evidence-scope。
    assert.ok(prompt.includes('我没看到'), '应含"我没看到≠不存在"内核')
    assert.ok(prompt.includes('穷尽查证'), '声称缺失需穷尽查证的内核必须有落点')
    assert.ok(prompt.includes('所有层的入口'), 'grep 所有层入口的方法必须保留')
  })

  it('evidence-scope carries the field-semantics discipline (字段语义纪律，2026-09-25)', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 补此条的事故形状：同一个会话里三次把字段读成它名字暗示的东西——
    //   ① cache-log 的 `injected` 读成「本轮发生了注入」，实为**历史 SR 消息累计条数**
    //      （loop-factory.ts 里遍历 messages 计数）；
    //   ② `wireDiverged.prevCount/newCount` 读成**工具数**，实为 **messages 条数**
    //      （openai-client.ts 里 sigs = messages.map(...)）；
    //   ③ 用「29 低命中轮 × 14 injected 轮」的并列计数代替直接指示字段。
    // 三者共同点：没读构造点 / 没看兄弟字段。已有的 lossy-observation-discipline 只管
    // 「不得推负向结论」，而这三处都是**正向语义断言**，方向不匹配，拦不住。
    assert.ok(prompt.includes('字段名不是语义'), '应含"字段名不是语义"内核')
    assert.ok(prompt.includes('赋值点'), '定位赋值点的方法必须保留')
    assert.ok(prompt.includes('兄弟字段'), '用兄弟字段消歧的方法必须保留')
    assert.ok(prompt.includes('邻近计数'), '禁止拿邻近计数当证据的内核必须保留')
  })

  it('delivery-contract carries the consolidated delivery discipline', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // no-fabricated-tests 门禁 + output-style 已并入 <delivery-contract>。
    assert.ok(prompt.includes('<delivery-contract>'), '应有统一的交付契约块')
    assert.ok(prompt.includes('0 passed 当成功'), '诚实门禁内核（未运行=未验证）必须有落点')
    assert.ok(prompt.includes('涉及文件'), '收束必须包含commit+文件信息')
    assert.ok(prompt.includes('失败、未完成和未验证不得因精简而省略'), '精简不能省略不利事实')
    assert.ok(!prompt.includes('自我设限'), '"NEVER narrate session limits"条已于 2026-07-19 应用户要求整条移除')
  })

  it('wraps security in <security> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<security>'))
    assert.ok(prompt.includes('</security>'))
  })

  it('does NOT include tool summary section', () => {
    const tools = [{ name: 'bash', description: 'Run commands', input_schema: { type: 'object' as const, properties: {} } }]
    const prompt = buildSystemPrompt({ tools })
    assert.ok(!prompt.includes('## Tools'))
    assert.ok(!prompt.includes('- **bash**'))
  })

  it('has no markdown ## headers', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // Match only level-2 headers (## at line start), not ### sub-headers
    assert.ok(!/^## /m.test(prompt))
  })

  it('nesting depth is max 2 levels', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // No triple-nested tags like <a><b><c>
    const threeDeep = /<[a-z-]+>\s*<[a-z-]+>\s*<[a-z-]+>/
    assert.ok(!threeDeep.test(prompt))
  })

  it('includes git section in <git> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<git>'))
    assert.ok(prompt.includes('</git>'))
  })

  it('preserves core prompt semantics', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('有理有据'))
    assert.ok(prompt.includes('先读现有代码理解上下文'))
    assert.ok(prompt.includes('read_file'))
    assert.ok(prompt.includes('edit_file'))
    assert.ok(prompt.includes('write_file'))
    assert.ok(prompt.includes('node:test'))
    assert.ok(prompt.includes('API key'))
  })

  it('includes beliefs as situational triggers', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('当你发现更优方案时'))
    assert.ok(prompt.includes('当用户指令偏离用户意图时'))
    assert.ok(prompt.includes('确认理解'))
  })

  it('includes P-cognitive-2 intent preservation and level diagnosis in ① 理解', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('意图保存'), '应含意图保存子句——复述用户核心目标而非执行计划')
    assert.ok(prompt.includes('层级判断'), '应含层级判断——业务目标/链路问题/代码改动三层')
    assert.ok(prompt.includes('降级处理'), '应禁止把高层问题降级为低层改动')
    assert.ok(prompt.includes('清场指令'), '应含反例——"人家都提交完了"不是清场指令')
    assert.ok(prompt.includes('拉偏你的方向'), '锚定防御：失败信号会拉偏方向')
  })

  it('includes P-cognitive-3 self-check gate before </workflow>', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('自检闸门'), '应含自检闸门标题')
    assert.ok(prompt.includes('长程目标压缩'), '闸门判据1：目标压缩检测')
    assert.ok(prompt.includes('失败信号'), '闸门判据2：失败信号锚定')
    assert.ok(prompt.includes('未解决的矛盾'), '闸门判据3：矛盾未解决')
    assert.ok(prompt.includes('确认理解'), '闸门出口：停下来确认')
  })

  it('includes P-cognitive-1 correction-interrupt rule before self-check gate', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('纠正中断规则'), '应含纠正中断规则标题')
    assert.ok(prompt.includes('停止当前行动链'), '纠偏时停止执行链')
    assert.ok(prompt.includes('确认你对纠正的理解'), '先确认理解再继续')
    assert.ok(prompt.includes('绕过项目规定流程'), '应含绕过流程检测')
    assert.ok(prompt.includes('确认用户意图'), '原路不通时确认意图')
  })

  it('includes task completion reporting requirements', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('涉及文件'), '收束应有 commit + 文件信息')
    assert.ok(prompt.includes('改动结果、验证状态、遗留事项及设计偏差（如有）'), '必填信息不随栏目变化而丢失')
    assert.ok(prompt.includes('失败、未完成和未验证不得因精简而省略'), '精简不能省略不利事实')
  })

  it('includes only a short manifest entry for sensitive knowledge domains', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('.rivet/knowledge/manifest.md'))
    assert.ok(prompt.includes('prompt/identity/memory/recall/verification/ownership'))
  })

  it('includes delegation discipline guardrails', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('不是默认推进方式'), '应声明委派非默认推进方式')
    assert.ok(prompt.includes('用户说不要委派时'), '应含禁用委派条件')
    assert.ok(prompt.includes('继续内联执行'), '应含降级内联执行')
    assert.ok(!prompt.includes('是合法的协作建议'), '不再保留"新会话交接合法"出口')
    assert.ok(!prompt.includes('不自我设限'), '不自我设限条已整条移除')
  })

  it('applies behavioral calibration without exposing model identity', () => {
    const deepseek = buildSystemPrompt({ tools: [], modelFamily: 'deepseek' })
    assert.ok(deepseek.includes('<calibration>'))
    assert.ok(!deepseek.includes('family='))
    assert.ok(deepseek.includes('grep 验证消费方'))

    const mimo = buildSystemPrompt({ tools: [], modelFamily: 'mimo' })
    assert.ok(mimo.includes('<calibration>'))
    assert.ok(!mimo.includes('family='))
    assert.ok(mimo.includes('收敛'))

    const glm = buildSystemPrompt({ tools: [], modelFamily: 'glm' })
    assert.ok(glm.includes('<calibration>'))
    assert.ok(!glm.includes('family='))
    assert.ok(glm.includes('不要把"穷尽查证"理解为无限工具调用'))
    assert.ok(glm.includes('同一工具同一错误连续 2 次'))
    assert.ok(glm.includes('每轮最多围绕一个假设查 3 个关键证据'))
    assert.ok(glm.includes('步骤纪律'))
    assert.ok(glm.includes('先建 todo 列表再执行'))
    // action-driven elimination methodology + plan/implement layering
    assert.ok(glm.includes('用行动排除，不用推理排除'))
    assert.ok(glm.includes('探针'))
    assert.ok(glm.includes('红灯'))
    assert.ok(glm.includes('不要在推理里写完整代码'))
    assert.ok(glm.includes('计划阶段'))
    assert.ok(glm.includes('实施阶段'))

    const unknown = buildSystemPrompt({ tools: [], modelFamily: 'unknown' })
    assert.ok(!unknown.includes('<calibration>'))
  })

  it('does not reintroduce retired long-form warning sections', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(!prompt.includes('Common Mistakes'))
    assert.ok(!prompt.includes('prefix cache 对静态提示词敏感'))
    assert.ok(!prompt.includes('891cc1b6'))
  })
})

describe('detectModelFamily', () => {
  it('detects deepseek models', () => {
    assert.equal(detectModelFamily('deepseek-v4-0324'), 'deepseek')
    assert.equal(detectModelFamily('DeepSeek-V4-Flash'), 'deepseek')
  })

  it('detects mimo models', () => {
    assert.equal(detectModelFamily('MiMo-7B'), 'mimo')
  })

  it('detects glm models', () => {
    assert.equal(detectModelFamily('glm-4-plus'), 'glm')
  })

  it('detects openai models', () => {
    assert.equal(detectModelFamily('gpt-4o'), 'openai')
    assert.equal(detectModelFamily('o3-mini'), 'openai')
  })

  it('detects anthropic models', () => {
    assert.equal(detectModelFamily('claude-opus-4'), 'anthropic')
    assert.equal(detectModelFamily('claude-sonnet-4'), 'anthropic')
  })

  it('returns unknown for unrecognized models', () => {
    assert.equal(detectModelFamily('custom-model-v1'), 'unknown')
  })
})

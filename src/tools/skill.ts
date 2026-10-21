import type { Tool } from './types.js'
import { skillRegistry, listSkillFiles, RETIRED_BUNDLED_SKILLS } from '../skills/skill-loader.js'

/**
 * Tier-2 skill activation. The discovery block (volatile appendix) lists every
 * available skill's name + description; this tool loads the FULL body of one of
 * them on demand. The body is returned as an ordinary tool result — append-only
 * to history — so the whole session can see it. There is NO truncation here;
 * oversized bodies are handled by the tool pipeline's existing artifact
 * intercept, the same as any other large tool output.
 *
 * The static definition deliberately does NOT embed any concrete skill name, so
 * the tool description stays byte-stable across sessions and the prefix cache is
 * preserved. The set of loadable skills lives only in the volatile discovery
 * block.
 */
export const SKILL_TOOL: Tool = {
  definition: {
    name: 'skill',
    description: `按名称加载某个 skill 的完整指令，然后照做。

skill 是可复用的工作流 playbook。available-skills 区块列出了每个 skill 的名称和简述。当某个 skill 的简述与你正在做的事匹配时，用它的确切名称调用本工具，按需加载完整指令，然后执行。

执行完已加载的 skill 后，调用 skill(name="<name>", complete=true) 释放它。这样工作流结束后，该 skill 的指令不会再被重新注入上下文。

示例：skill(name="brainstorming")`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要加载或标记完成的 skill 的确切名称（见 available-skills 区块）。' },
        complete: { type: 'boolean', description: '为 true 时，将该 skill 标记为已完成而不是加载它。该 skill 的指令将不再被重新注入上下文。' },
        action: { type: 'string', enum: ['load', 'save_draft'], description: '默认 load；save_draft 将 content 保存为待用户审核的草稿，不能发布。' },
        scope: { type: 'string', enum: ['personal', 'project'], description: '用户选定的草稿范围。' },
        content: { type: 'string', description: '含 name、description 的完整 Markdown。save_draft 必填。' },
        expectedVersion: { type: ['string', 'null'], description: '更新传已审阅版本；新建传 null。' },
      },
      required: ['name'],
    },
  },

  async execute(params) {
    const raw = params.input.name
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { content: '错误：name 必填', isError: true }
    }
    const name = raw.trim()
    if (params.input.action === 'save_draft') {
      if (!params.saveSkillDraft) return { content: '当前宿主不支持保存 skill 草稿，未保存任何草稿。', isError: true }
      const { scope, content, expectedVersion } = params.input
      if (params.input.complete || (scope !== 'personal' && scope !== 'project') || typeof content !== 'string'
        || (expectedVersion !== undefined && expectedVersion !== null && typeof expectedVersion !== 'string')) return { content: '草稿输入无效：scope 必须为 personal/project，content 必须为字符串，且不能与 complete 同时使用。', isError: true }
      try {
        const skillDraft = await params.saveSkillDraft({ name, scope, content, expectedVersion: expectedVersion as string | null | undefined })
        return { content: JSON.stringify({ draft: true, ...skillDraft }), uiContent: `待审核草稿：${skillDraft.name}`, skillDraft }
      } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true } }
    }
    if (params.input.action !== undefined && params.input.action !== 'load') return { content: '未知的 skill 操作：action 只支持 load/save_draft。', isError: true }
    const registry = params.skillRegistry ?? skillRegistry

    const skill = registry.get(name) ?? registry.list().find(s => s.name.toLowerCase() === name.toLowerCase())
    if (!skill) {
      // Retired skills map to native flows instead of a hard error — old plan
      // texts still say "使用 executing-plans", and the model may call this
      // tool by reflex. Point it at the native replacement.
      const retired = RETIRED_BUNDLED_SKILLS.find(e => e.name.toLowerCase() === name.toLowerCase())
      if (retired) {
        return {
          content: `Skill「${name}」已退役并内置为原生流程，无需加载技能文件——规划期直接按系统提示的 <plan-mode> 纪律执行，执行期按 <plan-executing> 纪律执行。`,
          uiContent: `已映射到原生流程：${name}`,
        }
      }
      const available = registry.list().map(s => s.name).sort()
      const list = available.length > 0 ? available.join(', ') : '（未加载任何 skill）'
      return {
        content: `未找到 skill：「${name}」。\n可用 skill：${list}`,
        isError: true,
      }
    }

    if (params.input.complete === true) {
      params.onSkillCompleted?.(skill.name)
      return { content: `Skill「${skill.name}」已标记为完成。`, uiContent: `已完成 skill：${skill.name}` }
    }

    if ((skill.mode ?? skill.metadata?.defaultMode) === 'off') return { content: `Skill「${skill.name}」已停用。请先启用。`, isError: true }
    if ((skill.mode ?? skill.metadata?.defaultMode) === 'manual') return { content: `Skill「${skill.name}」仅手动使用。请用户通过 /skill ${skill.name} 调用。`, isError: true }
    registry.ensureResources(skill.name)
    params.onSkillInvoked?.(skill.name)

    const body = `<skill name="${skill.name}">\n${skill.body}\n</skill>`
    // Flat (no skillDir) skills have no sub-files — return body as-is.
    if (!skill.skillDir) {
      return { content: body, uiContent: `已加载 skill：${skill.name}` }
    }
    const files = skill.files ?? listSkillFiles(skill.skillDir)
    if (files.length === 0) {
      return { content: body, uiContent: `已加载 skill：${skill.name}` }
    }
    // Directory skill: append the sub-file tree so the model knows what it can
    // read on demand (Tier-3). The body itself is never truncated.
    const tree = files.map(f => `  ${f.path}`).join('\n')
    const filesBlock = [
      `<skill-files dir="${skill.skillDir}" note="按上方指令需要时再用 read_file/grep/glob 按需读取。不要预先全部加载。大文件先用 read_file(focus=...) 提取关键片段，缺口再用 offset/limit 精读；切勿把摘要当成完整文件。">`,
      tree,
      '</skill-files>',
    ].join('\n')
    return {
      content: `${body}\n${filesBlock}`,
      uiContent: `已加载 skill：${skill.name}（+${files.length} 个文件）`,
    }
  },

  requiresApproval: params => params.input?.action === 'save_draft',
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

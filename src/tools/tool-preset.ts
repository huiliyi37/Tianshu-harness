import { existsSync, readFileSync } from 'node:fs'
import { findProjectConfig } from '../config/manager.js'
import { userConfigPath } from '../config/paths.js'
import { isRuntimeLeanAspect } from '../config/runtime-lean.js'
// 叶模块（0 import），仅取域内置档位默认，无循环依赖。
import { STAR_DOMAINS } from '../agent/star-domain-data.js'

/**
 * Tool preset — 会话启动期的工具装配档位（会话内冻结，前缀缓存零影响）。
 *
 * 三档语义（2026-07-19 工具审计落地，入口成本实测见 .rivet/scratch/tool-audit.ts）：
 * - **minimal（29 个）**：日常开发全能力——读写/检索/bash/git/测试/委托/
 *   交付/plan/web_search/web_fetch。去掉编排（council/team）、browser 系、
 *   attack_case、semantic_search 等重而冷门的工具。
 * - **frontend（默认，30）**：minimal + browser_debug（UI 渲染验证闭环）。
 * - **full（50）**：全集，含 attack_case/council/team/semantic_search/repo_graph/
 *   undo/recall_general/record_general_finding/ast_edit/related_tests/
 *   inspect_project/import_resource/leave_mark/browser_debug/monitor。
 * - **taiyi（16 个，评测档）**：太一星域最小工具集——只保留 2026-08-04 会话
 *   使用率审计（最近 40 主会话 / 2938 消息 / 23 工具）中的高频核心 + 交付闭环：
 *   bash/read_file/write_file/edit_file/hash_edit/grep/glob/git/todo/
 *   deliver_task/run_tests/job/plan_submit/plan_close/memory/diff。
 *   任何 preset 门控工具一律不注册；kernel 无条件注册的 ast_grep/web_fetch/
 *   web_search/repo_map/read_section/request_path_access/ask_image/skill
 *   经 default-registry 的 `preset !== 'taiyi'` 守卫排除；bootstrap 侧
 *   无条件注册的编排/辅助工具（delegate/galaxy/starflow/plan_task 等）经
 *   TAIYI_EXCLUDES + presetIncludes 排除（2026-08-07 闭环修复——此前
 *   bootstrap 层未门控，实装远多于文档 16；本注释曾写 17 并误含
 *   request_path_access，与 default-registry 实现相反，一并修正）。
 *   用途：评测「只留关键工具是否够用」；显式 RIVET_TOOL_PRESET=taiyi 或
 *   tools.preset=taiyi 触发。另作太一星域内置默认档（star-domain-data
 *   toolPreset 字段）：defaultDomain 钉定 taiyi 且无任何显式给档时落到本档——
 *   这是「钉太一即 16 件」的默认体验，显式配置恒优先可覆盖。
 *
 * 解析优先级：`RIVET_TOOL_PRESET` env > 项目 `.rivet-config.json` tools.preset
 * > 项目 runtime.domains[域].toolPreset > 用户配置 tools.preset（`userConfigPath()`，
 * 认 RIVET_HOME/RIVET_CONFIG_PATH）> 用户 runtime.domains[域].toolPreset
 * > 域内置默认档（STAR_DOMAINS[域].toolPreset）> lean 默认 `minimal` > 'frontend'。
 * 变更只在下个会话生效（会话中途改工具指纹 = 前缀全量重建，反经济）。
 */

export type ToolPreset = 'minimal' | 'frontend' | 'full' | 'taiyi'

const VALID = new Set<string>(['minimal', 'frontend', 'full', 'taiyi'])

function parsePreset(raw: unknown): ToolPreset | null {
  return typeof raw === 'string' && VALID.has(raw) ? (raw as ToolPreset) : null
}

const memo = new Map<string, ToolPreset>()

/**
 * 解析工具档位。`domainId`（config.agent.defaultDomain，装配期静态值）非空时，
 * 域相关档位按两级参与解析（均低于 RIVET_TOOL_PRESET env 与同文件 tools.preset）：
 * ① 项目/用户配置 `runtime.domains[domainId].toolPreset`（显式域档）；
 * ② 域定义内置默认（`STAR_DOMAINS[domainId].toolPreset`，如 taiyi 域内置 taiyi 档）。
 * 完整优先级见文件头注释。运行期 /domain 切换不改档位（装配已过，改指纹=前缀重建）。
 */
export function resolveToolPreset(cwd: string, domainId?: string): ToolPreset {
  const key = domainId ? `${cwd}\u0000${domainId}` : cwd
  const cached = memo.get(key)
  if (cached) return cached

  let preset: ToolPreset | null = parsePreset(process.env.RIVET_TOOL_PRESET)

  if (!preset) {
    const projectPath = findProjectConfig(cwd)
    if (projectPath && existsSync(projectPath)) {
      try {
        const raw = JSON.parse(readFileSync(projectPath, 'utf-8')) as {
          tools?: { preset?: unknown }
          runtime?: { domains?: Record<string, { toolPreset?: unknown }> }
        }
        preset = parsePreset(raw.tools?.preset)
        if (!preset && domainId) {
          preset = parsePreset(raw.runtime?.domains?.[domainId]?.toolPreset)
        }
      } catch { /* malformed project config — fall through */ }
    }
  }

  if (!preset) {
    // 必须与写侧同源（saveToolPresetConfig → userConfigPath）。用
    // defaultRivetHome() 会漏掉 RIVET_HOME/RIVET_CONFIG_PATH——桌面端便携模式
    // 与自定义存储路径下设置页写的档位就永远读不回来，UI 显示已保存却无效。
    const userPath = userConfigPath()
    if (existsSync(userPath)) {
      try {
        const raw = JSON.parse(readFileSync(userPath, 'utf-8')) as {
          tools?: { preset?: unknown }
          runtime?: { domains?: Record<string, { toolPreset?: unknown }> }
        }
        preset = parsePreset(raw.tools?.preset)
        if (!preset && domainId) {
          preset = parsePreset(raw.runtime?.domains?.[domainId]?.toolPreset)
        }
      } catch { /* malformed user config — fall through */ }
    }
  }

  // 域内置默认档（star-domain-data toolPreset 字段）：仅在 env/项目/用户均未
  // 显式给档时生效。domainId 可能是 'auto' 或自定义域 id——查不到自然落兜底。
  if (!preset && domainId) {
    preset = parsePreset((STAR_DOMAINS as Record<string, { toolPreset?: unknown }>)[domainId]?.toolPreset)
  }

  const resolved = preset ?? (isRuntimeLeanAspect('tools', undefined, cwd) ? 'minimal' : 'frontend')
  memo.set(key, resolved)
  return resolved
}

/** Drop the per-cwd memo (settings changed / tests) so the next session
 *  resolves the preset fresh. Long-lived processes (desktop sidecar) must
 *  call this after persisting a preset change. */
export function invalidateToolPreset(): void {
  memo.clear()
}

/** Test-only: drop the per-cwd memo so env/config edits take effect. */
export function __resetToolPresetForTest(): void {
  invalidateToolPreset()
}

/** minimal 排除名单（kernel + bootstrap 统一）。full 全集；frontend 仅加
 *  browser_debug。判断逻辑见 presetIncludes。 */
const MINIMAL_EXCLUDES: ReadonlySet<string> = new Set([
  // 编排（重 + 日常低频）。team_orchestrate 2026-07-29 移除——它是唯一
  // 多 worker 波次编排入口，主控必须可见（T3 修复：随 tool-tiers 升入 CORE）。
  'council_convene',
  // browser 系
  'browser_debug',
  // 重而冷门 / 零使用（2026-07-19 会话使用率审计）
  'attack_case',
  'semantic_search',
  'repo_graph',
  'undo',
  'recall_general',
  'record_general_finding',
  'ast_edit',
  'related_tests',
  'inspect_project',
  'import_resource',
  'leave_mark',
  // 2026-07-22 minimal 再瘦身（会话日志使用率实测验证）：极低频工具
  'file_info',
  'session_vitals',
  'update_goal',
  // monitor 事件订阅（full 档专属——引导模型改干等为订阅的进阶能力）
  'monitor',
  // capability 能力索引（查询面低频，full 档专属——同 repo_graph/semantic_search；
  // RIVET_CAPABILITY=1 可单独强制开启）
  'capability',
  // cli_discover CLI 能力发现与安装（安装动作审批硬闸门，full 档专属；
  // RIVET_CLI_DISCOVER=1 可单独强制开启）
  'cli_discover',
  // 整站爬取/发现（重 + 非常用；RIVET_WEB_CRAWL/RIVET_WEB_MAP=1 可单独强制开启）
  'web_crawl',
  'web_map',
])

/** taiyi 评测档专属排除：bootstrap 侧无条件注册的编排/辅助工具，均不在
 *  16 核心集内。此前 bootstrap 层完全未按 taiyi 门控（2026-08-07 侦察确认
 *  实装远多于文档 16），本清单 + bootstrap 的 presetIncludes 调用点补上闭环。
 *  minimal/frontend/full 不受影响（这些名字不在 MINIMAL_EXCLUDES，
 *  三档语义与改动前逐字一致）。 */
const TAIYI_EXCLUDES: ReadonlySet<string> = new Set([
  'delegate_task',
  'delegate_batch',
  'galaxy',
  'starflow',
  'team_orchestrate',
  'plan_task',
  'apply_patch',
  'recall_capsule',
  'ask_user_question',
])

/** 判断某工具在给定档位下是否注册。 */
export function presetIncludes(preset: ToolPreset, toolName: string): boolean {
  if (preset === 'full') return true
  if (preset === 'taiyi' && TAIYI_EXCLUDES.has(toolName)) return false
  if (preset === 'frontend' && toolName === 'browser_debug') return true
  // taiyi 与 minimal 在此层其余语义一致（门控工具全不注册）；kernel 侧
  // taiyi 另有 8 个 `preset !== 'taiyi'` 守卫（default-registry）。
  return !MINIMAL_EXCLUDES.has(toolName)
}

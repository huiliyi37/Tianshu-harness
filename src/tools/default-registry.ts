import { APPLY_PATCH_TOOL } from './apply-patch.js'
import { AST_EDIT_TOOL } from './ast-edit.js'
import { AST_GREP_TOOL } from './ast-grep.js'
import { createCapabilityTool } from './capability-index.js'
import { createCliDiscoverTool } from './cli-discover.js'
import { IMPORT_RESOURCE_TOOL } from './import-resource.js'
import { FILE_INFO_TOOL } from './file-info.js'
import { CREATE_DOCUMENT_TOOL } from './create-document.js'
import { CREATE_SPREADSHEET_TOOL } from './create-spreadsheet.js'
import { CREATE_IMAGE_TOOL } from './create-image.js'
import { CREATE_PRESENTATION_TOOL } from './create-presentation.js'
import { CREATE_PDF_TOOL } from './create-pdf.js'
import { EXPORT_FILE_TOOL } from './export-file.js'
import { OPEN_PATH_TOOL } from './open-path.js'
import { REQUEST_PATH_ACCESS_TOOL } from './request-path-access.js'
import { SKILL_TOOL } from './skill.js'
import { BROWSER_TOOL } from './browser.js'
import { createComputerUseStubTool } from './computer-use/stub.js'
import { computerUseModulePresent } from './computer-use/bridge.js'
import { BASH_TOOL } from './bash.js'
import { JOB_TOOL } from './job-tool.js'
import { MONITOR_TOOL } from './monitor-tool.js'
import { DIFF_TOOL } from './diff.js'
import { EDIT_FILE_TOOL } from './edit.js'
import { HASH_EDIT_TOOL } from './hash-edit.js'
import { GIT_TOOL } from './git.js'
import { GLOB_TOOL } from './glob.js'
import { GREP_TOOL } from './grep.js'
import { INSPECT_PROJECT_TOOL } from './inspect-project.js'
import { ASK_IMAGE_TOOL } from './ask-image.js'
import { LEAVE_MARK_TOOL } from './leave-mark.js'
import { PLAN_SUBMIT_TOOL, PLAN_CLOSE_TOOL } from './plan.js'
import { READ_FILE_TOOL } from './read-file.js'
import { READ_SECTION_TOOL } from './read-section.js'
import { RELATED_TESTS_TOOL } from './related-tests.js'
import { REPO_MAP_TOOL } from './repo-map.js'
import { RUN_TESTS_TOOL } from './run-tests.js'
import { TODO_TOOL, createTodoTool } from './todo.js'
import { SCHEDULE_CREATE_TOOL, SCHEDULE_LIST_TOOL, SCHEDULE_DELETE_TOOL, isSchedulerAvailable } from './schedule/tool.js'
import type { TodoStore } from './todo-store.js'
import { ToolRegistry } from './registry.js'
import type { Tool } from './types.js'
import { WEB_FETCH_TOOL, createWebFetchTool } from './web-fetch.js'
import type { WebFetchOptions } from './web-fetch/tool.js'
import { createWebCrawlTool } from './web-crawl/tool.js'
import { createWebMapTool } from './web-crawl/map-tool.js'
import { WEB_SEARCH_TOOL, createWebSearchTool } from './web-search.js'
import type { SearchBackend } from './web-search.js'
import { WRITE_FILE_TOOL } from './write-file.js'
import { presetIncludes, resolveToolPreset, type ToolPreset } from './tool-preset.js'

export interface DefaultRegistryOptions {
  /** T8 桌面化办公工具（create_document/spreadsheet/image/presentation/pdf + export_file/open_path）。
   *  默认关闭：EXTENDED 层（工具预算由 tool-preset 三档控制——minimal 29 /
   *  frontend 30 / full 48，见 tool-preset.ts；装配口径以 tool-preset.test.ts
   *  断言为准，文案改动需同步 settings.json 与 README）。 */
  desktopTools?: boolean
  /** N4 桌面浏览器验证工具。默认关闭：新攻击面 + 占 kernel budget，仅桌面 sidecar 开启。 */
  browserTool?: boolean
  /** Computer Use（桌面 GUI 自动化，macOS/Windows）。默认关闭：EXTENDED 层工具（主控 prompt 零成本），
   *  仅 darwin/win32 且 RIVET_COMPUTER_USE!=0 时由装配层开启；逐应用审批 fail-closed。 */
  computerUse?: boolean
  /** Pro feature gate for computer_use. When false (default), the tool is disabled
   *  even if computerUse=true. */
  proEnabled?: boolean
  /** 多会话隔离：注入 per-session TodoStore。缺省回退全局 TODO_TOOL（defaultStore）。
   *  注意工具 definition（name/description/schema）与 TODO_TOOL 字节一致，仅 store 不同，
   *  不影响系统提示词前缀缓存。 */
  todoStore?: TodoStore
  /** Ordered web_search backend chain built from config (DDG/Brave/Tavily).
   *  Absent → the DDG-only default WEB_SEARCH_TOOL is registered. The tool
   *  `definition` is byte-identical either way, so prefix cache is unaffected. */
  searchBackends?: SearchBackend[]
  /** 工具装配档位（minimal/frontend/full）。缺省按 RIVET_TOOL_PRESET env >
   *  项目 .rivet-config.json tools.preset > 用户配置 > frontend 解析。
   *  会话内冻结，前缀缓存零影响。 */
  preset?: ToolPreset
  /** web_fetch options built from config.fetch. Absent → the default
   *  WEB_FETCH_TOOL is registered. The tool `definition` is byte-identical
   *  either way, so prefix cache is unaffected. */
  fetchOptions?: WebFetchOptions
}

export function createDefaultToolRegistry(extraTools: Tool[] = [], options: DefaultRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry()
  const preset = options.preset ?? resolveToolPreset(process.cwd())
  // apply_patch moved to EXTENDED layer (interactive/bootstrap) — overlap with
  // hash_edit covers >90% of use cases; keep in interactive for edge cases.
  // import_resource / leave_mark 等冷门工具由 preset 控制（full 才含，
  // RIVET_*=1 可单独强制开启）。
  if (presetIncludes(preset, 'import_resource') || process.env.RIVET_IMPORT_RESOURCE === '1') {
    registry.register(IMPORT_RESOURCE_TOOL)
  }
  registry.register(READ_FILE_TOOL)
  registry.register(WRITE_FILE_TOOL)
  if (options.desktopTools) {
    registry.register(EXPORT_FILE_TOOL)
    registry.register(OPEN_PATH_TOOL)
    registry.register(CREATE_DOCUMENT_TOOL)
    registry.register(CREATE_SPREADSHEET_TOOL)
    registry.register(CREATE_IMAGE_TOOL)
    registry.register(CREATE_PRESENTATION_TOOL)
    registry.register(CREATE_PDF_TOOL)
  }
  registry.register(PLAN_CLOSE_TOOL)
  registry.register(PLAN_SUBMIT_TOOL)
  registry.register(BASH_TOOL)
  registry.register(JOB_TOOL)
  if (presetIncludes(preset, 'monitor')) registry.register(MONITOR_TOOL)
  registry.register(EDIT_FILE_TOOL)
  registry.register(HASH_EDIT_TOOL)
  registry.register(GREP_TOOL)
  if (preset !== 'taiyi') registry.register(AST_GREP_TOOL)
  if (presetIncludes(preset, 'ast_edit')) registry.register(AST_EDIT_TOOL)
  registry.register(GLOB_TOOL)
  registry.register(DIFF_TOOL)
  registry.register(RUN_TESTS_TOOL)
  registry.register(GIT_TOOL)
  registry.register(options.todoStore ? createTodoTool(options.todoStore) : TODO_TOOL)
  // Agent 自助调度——自动化是基础能力，档位不设限（Pro 门控在 reviewPolicy 侧），
  // 但**只在真有调度器的运行时注册**：调度器由 serve.ts 启动期 setActiveScheduler
  // 登记，而 agent（含工具表）是 ensureAgent 懒建的，必然晚于登记，所以 serve/
  // 桌面端照常拿到。CLI 交互模式没有调度器，注册了也只会让模型看见三个必然返回
  // 「调度器不可用」的工具，白付提示词还诱发无效调用。
  if (isSchedulerAvailable()) {
    registry.register(SCHEDULE_CREATE_TOOL)
    registry.register(SCHEDULE_LIST_TOOL)
    registry.register(SCHEDULE_DELETE_TOOL)
  }
  if (preset !== 'taiyi') {
    registry.register(
      options.fetchOptions
        ? createWebFetchTool(undefined, options.fetchOptions)
        : WEB_FETCH_TOOL,
    )
  }
  // 冷门整站工具：full preset 含；RIVET_WEB_CRAWL/RIVET_WEB_MAP=1 可单独强制开启
  if (presetIncludes(preset, 'web_crawl') || process.env.RIVET_WEB_CRAWL === '1') {
    registry.register(createWebCrawlTool({}, options.fetchOptions ?? {}))
  }
  if (presetIncludes(preset, 'web_map') || process.env.RIVET_WEB_MAP === '1') {
    registry.register(
      createWebMapTool({ searchBackends: options.searchBackends }, options.fetchOptions ?? {}),
    )
  }
  if (preset !== 'taiyi') {
    registry.register(
      options.searchBackends && options.searchBackends.length > 0
        ? createWebSearchTool({ backends: options.searchBackends })
        : WEB_SEARCH_TOOL,
    )
  }
  if (presetIncludes(preset, 'inspect_project')) registry.register(INSPECT_PROJECT_TOOL)
  if (preset !== 'taiyi') registry.register(REPO_MAP_TOOL)
  if (presetIncludes(preset, 'related_tests')) registry.register(RELATED_TESTS_TOOL)
  if (preset !== 'taiyi') registry.register(READ_SECTION_TOOL)
  if (presetIncludes(preset, 'file_info')) registry.register(FILE_INFO_TOOL)
  // capability — 能力索引（只读查询，无审批）。full 档专属（查询面低频，同
  // repo_graph/semantic_search）；RIVET_CAPABILITY=1 可单独强制开启。
  if (presetIncludes(preset, 'capability') || process.env.RIVET_CAPABILITY === '1') {
    registry.register(createCapabilityTool())
  }
  // cli_discover — CLI 能力发现与安装（审批硬闸门）。EXTENDED 语义：安装动作
  // 永不自动放行（requiresApproval），仅 full 档装配；低频发现查询不挤占
  // 主控常驻工具预算（与 capability 同档位策略）。
  if (presetIncludes(preset, 'cli_discover') || process.env.RIVET_CLI_DISCOVER === '1') {
    registry.register(createCliDiscoverTool())
  }
  if (preset !== 'taiyi') registry.register(REQUEST_PATH_ACCESS_TOOL)
  // ask_image — 视觉副驾查询。非 taiyi 档始终注册（工具在无图/无桥时自降级），
  // 让主控在用户发图后能就图追问；描述短，前缀缓存影响可忽略。taiyi 评测档
  // 排除——评测场景无图。
  if (preset !== 'taiyi') registry.register(ASK_IMAGE_TOOL)
  // skill — 技能加载。taiyi 评测档排除（评测任务不依赖技能系统）。
  if (preset !== 'taiyi') registry.register(SKILL_TOOL)
  // leave_mark — 星图里程碑。preset full 含；RIVET_LEAVE_MARK=1 强制开启。
  if (presetIncludes(preset, 'leave_mark') || process.env.RIVET_LEAVE_MARK === '1') {
    registry.register(LEAVE_MARK_TOOL)
  }
  if (options.browserTool) {
    registry.register(BROWSER_TOOL)
  }
  if (options.computerUse && options.proEnabled && computerUseModulePresent()) {
    // 懒加载桩：定义（模型可见接口）在开源侧，执行实现经 bridge 懒载
    // pro 模块（闭源）。模块缺席（公开构建）时工具根本不注册——不可见即不可配。
    registry.register(createComputerUseStubTool({ proEnabled: options.proEnabled }))
  }
  for (const tool of extraTools) registry.register(tool)
  return registry
}

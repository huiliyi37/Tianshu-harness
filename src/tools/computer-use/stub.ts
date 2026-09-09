/**
 * computer_use 懒加载桩（开源侧，2026-08-08）。
 *
 * 定义（description + schema）是模型可见的接口面，留在开源侧；执行实现
 * 在闭源 src/pro/computer-use/（bridge.ts 动态加载）。桩在首个 execute 时
 * 实例化真身并缓存，此后纯转发。
 *
 * requiresApproval 是同步签名不能 await——这里镜像真身的判定（动作集合 +
 * OSS app-grants 授权表），动作集合变化时两边需同步（src/pro 侧有测试钉住）。
 */

import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import { isAppGranted } from './app-grants.js'
import { isComputerUseSupportedPlatform, loadComputerUseImpl } from './bridge.js'

/** 与 pro tool.ts 同一份：能力探针与纯 sleep 免审批。 */
const NO_APPROVAL_ACTIONS = new Set(['check_permissions', 'wait'])
/** 任意代码执行 / 端点接管面——授权表永不免审（镜像 pro 侧 ALWAYS_APPROVE_ACTIONS）。 */
const ALWAYS_APPROVE_ACTIONS = new Set(['js_eval', 'browser_adopt'])

export interface ComputerUseStubOptions {
  proEnabled?: boolean
  platform?: NodeJS.Platform
}

export function createComputerUseStubTool(options: ComputerUseStubOptions = {}): Tool {
  const platform = options.platform ?? process.platform
  const proEnabled = options.proEnabled ?? false
  const enabled = isComputerUseSupportedPlatform(platform) && proEnabled
  let real: Tool | undefined

  return {
    definition: {
      name: 'computer_use',
      description: `操作桌面图形应用（macOS 和 Windows）：检查应用的可访问性树、点击/滚动/拖拽元素、输入文本、发送组合键、聚焦应用。仅当 CLI 工具、MCP 服务或结构化集成无法完成任务时使用（如无 API 的原生应用、纯 GUI 设置、或复现 UI-only bug）——有结构化工具时优先用结构化工具。

对应用的每个操作都需要人工审批，除非该应用已被授予"始终允许"。截图保存为可查看的 artifact；可访问性树（文本）是你的推理依据。当活跃模型支持视觉时，快照截图也会作为图片附加到对话中。

操作：
- check_permissions：报告系统能力/权限状态（无需审批）。
- list_apps：列出可见应用。
- snapshot(app)：返回应用的编号可访问性树 + 保存截图 artifact。如果 UI 自上次快照以来没有变化，返回简短"未变化"提示而非重复整棵树。Electron 应用（QQ、微信、VS Code…）在首次快照后几秒才会填充树——工具会自动预热并重试；超大树可能标记为"部分"（ref 仍然有效；用 find/wait_for 获取更深内容）。绝不要因为一次稀疏快照就断定应用不可见——再拍一次快照或先用 find。
- find(app, query)：快照但仅返回匹配查询的树行（角色/标题/值，不区分大小写）及其祖先链。对大型 UI（浏览器）优于 snapshot——同样的 ref，少得多的输出。
- wait_for(app, text, gone?, timeout_ms?)：轮询 UI 直到含"text"的树行出现（或 gone:true 时消失）。返回匹配行及可点击的 ref。在触发加载/动画的操作后使用，而不是盲 wait+snapshot 循环。
- click(app, ref|x,y)：左键点击快照元素 ref（推荐）或坐标。
- double_click(app, ref|x,y) / right_click(app, ref|x,y)：双击/右键点击。
- scroll(app, direction, amount?, ref|x,y?)：在目标下滚动视图（默认：窗口中心）。
- drag(app, from_ref|from_x+from_y, to_ref|to_x+to_y)：按住拖拽释放。
- type(app, text)：向聚焦字段输入文本（短 ASCII 文本；长文本用 paste_text，写特定字段用 set_value）。非 ASCII 文本（中文/emoji）自动走剪贴板粘贴——不受当前输入法（IME）影响，但会覆盖剪贴板。
- set_value(app, ref, text)：直接向文本控件（文本框、搜索框）写入值——无需焦点切换。如果控件不支持值写入则报错；回退到 click + type/paste_text。
- key(app, combo)：发送组合键如 "cmd+s" 或 "return"（Windows 上 cmd 映射为 Ctrl）。
- wait(duration_ms)：暂停最多 5000ms 等待动画/加载（无需审批）。知道等什么时优先用 wait_for。
- focus_app(app)：将应用带到前台。
- launch_app(app)：启动未运行的应用（已在运行时则聚焦它）。
- menu_select(app, menu_path)：按路径选择菜单栏项，如 "File > Export > PNG"。
- paste_text(app, text)：将文本放入剪贴板并粘贴（长/多行文本快速可靠；覆盖剪贴板）。

浏览器快速路径：Chrome 系目标（Chrome/Chromium/Edge/Brave）在有 DevTools（CDP）后端可用时自动使用——快照秒级完成，窗口被遮挡时点击/输入仍有效。对浏览器 launch_app 会启动专用自动化 profile（登录态跨会话保留）。浏览器专属操作：
- navigate(app, url)：导航到 URL，或 "back" / "forward" / "reload"。
- read_page(app)：完整页面文本（innerText）——无树节点上限；用于阅读文章/长内容。
- js_eval(app, expression)：在页面中运行 JavaScript 并返回结果（需要审批；自治/YOLO 档免审批）。
- tabs(app, tab_op, tab?, url?)：列出/激活/新建/关闭浏览器标签页（tab 是 list 中的 1-based 索引）。
- browser_adopt(endpoint)：附加到你用 --remote-debugging-port 启动的 Chrome（需要审批；自治/YOLO 档免审批）。

反馈循环：每次变更操作后工具会重新读取 UI 并附加变化摘要（新增/移除的元素）。UI 变化时 ref 缓存会刷新——diff 中显示的 ref 立即可点击，操作之前的 ref 已失效。如果目标 ref 失效，工具会在恰好一个元素仍匹配相同 role+title 时自动重拍快照并重试；否则刷新缓存并请你重新选择目标。`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['check_permissions', 'list_apps', 'snapshot', 'find', 'wait_for', 'click', 'double_click', 'right_click', 'scroll', 'drag', 'type', 'set_value', 'key', 'wait', 'focus_app', 'launch_app', 'menu_select', 'paste_text', 'navigate', 'read_page', 'js_eval', 'tabs', 'browser_adopt'],
            description: '要执行的操作。',
          },
          app: { type: 'string', description: '目标应用名称（除 list_apps/check_permissions/wait 外所有操作必需）。' },
          ref: { type: 'number', description: '目标快照元素 ref（click/scroll/set_value；来自最新快照）。' },
          x: { type: 'number', description: 'X 坐标（屏幕像素），无 ref 时使用。' },
          y: { type: 'number', description: 'Y 坐标（屏幕像素），无 ref 时使用。' },
          text: { type: 'string', description: '要输入（type）、粘贴（paste_text）、写入（set_value）的文本，或在树中等待（wait_for）。' },
          query: { type: 'string', description: '匹配树行的过滤字符串（find 操作）。' },
          gone: { type: 'boolean', description: 'wait_for：等待文本消失而非出现。' },
          timeout_ms: { type: 'number', description: 'wait_for 截止毫秒数（默认 5000，上限 15000）。' },
          menu_path: { type: 'string', description: '菜单路径，用 ">" 分隔，如 "File > Export > PNG"（menu_select 操作）。' },
          combo: { type: 'string', description: '组合键如 "cmd+s"、"shift+cmd+4"、"return"（key 操作；Windows 上 cmd 映射为 Ctrl）。' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向（scroll 操作）。' },
          amount: { type: 'number', description: '滚动幅度，滚轮行数 1-50（默认 5）。' },
          from_ref: { type: 'number', description: '拖拽起点：快照 ref。' },
          from_x: { type: 'number', description: '拖拽起点 X（无 from_ref 时）。' },
          from_y: { type: 'number', description: '拖拽起点 Y（无 from_ref 时）。' },
          to_ref: { type: 'number', description: '拖拽终点：快照 ref。' },
          to_x: { type: 'number', description: '拖拽终点 X（无 to_ref 时）。' },
          to_y: { type: 'number', description: '拖拽终点 Y（无 to_ref 时）。' },
          duration_ms: { type: 'number', description: '等待时长毫秒数，上限 5000（wait 操作）。' },
          url: { type: 'string', description: '要打开的 URL（navigate / tabs new）。navigate 也接受 "back"、"forward"、"reload"。' },
          expression: { type: 'string', description: '要在页面中执行的 JavaScript（js_eval 操作）。' },
          tab_op: { type: 'string', enum: ['list', 'activate', 'new', 'close'], description: '标签页操作（tabs 操作；默认 list）。' },
          tab: { type: 'number', description: '来自 tabs list 的 1-based 标签索引（tabs activate/close）。' },
          endpoint: { type: 'string', description: 'DevTools 端点，如 "localhost:9222" 或 http/ws URL（browser_adopt 操作）。' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const impl = await loadComputerUseImpl()
      if (!impl) {
        return {
          content: 'computer_use 在此构建不可用（实现为 Pro 闭源模块，随桌面端分发）。',
          isError: true,
        }
      }
      real ??= impl.createComputerUseTool({ proEnabled, platform })
      return real.execute(params)
    },

    requiresApproval(params: ToolCallParams): boolean {
      if (real) return real.requiresApproval(params)
      const action = params.input.action as string
      if (NO_APPROVAL_ACTIONS.has(action)) return false
      if (ALWAYS_APPROVE_ACTIONS.has(action)) return true
      // list_apps 无单一应用目标——恒门控（会暴露运行中应用清单）。
      const app = typeof params.input.app === 'string' ? params.input.app.trim() : ''
      if (!app) return true
      // 应用级「始终允许」授权免提示（fail-closed 默认）。
      return !isAppGranted(app)
    },

    isConcurrencySafe: () => false,
    isEnabled: () => enabled,
    timeoutMs: (params?: ToolCallParams) => {
      const action = params?.input?.action as string | undefined
      return action === 'snapshot' || action === 'find' || action === 'wait_for' ? 90_000 : 60_000
    },
  }
}

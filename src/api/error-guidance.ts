import { classifyApiError } from './error-classifier.js'
import { continuityFailureDetails } from './continuation-prefix.js'
import { OfficialError } from '../models/official-contract.js'

export type GuidanceSurface = 'tui' | 'desktop'

export function errorRecoveryGuidance(error: unknown, surface: GuidanceSurface = 'tui'): string {
  if (error instanceof OfficialError && error.code === 'supplier_balance_unavailable') return '官方模型通道暂不可用，本次请求未自动重发；账号仍保持登录，请稍后刷新状态。'
  if (error instanceof OfficialError && error.code === 'service_error') return '官方模型服务暂时异常，本次请求未自动重发；请刷新状态并核对请求结果。'
  if (error instanceof OfficialError && error.code === 'pricing_changed') return '报价已过期或发生变化，请刷新报价并再次确认发送。'
  const c = classifyApiError(error)
  switch (c.category) {
    case 'request_invariant': {
      const details = continuityFailureDetails(error)
      const stage = details?.stage === 'transport' ? '源历史与冻结投影未变，发送层字节发生变化。'
        : details?.stage === 'render' ? '冻结投影无法与已发布字节核对。' : ''
      if (surface === 'desktop') {
        return stage + '本地连续性校验受阻，重复发送不会修复；请到 设置 → 关于与许可 →「检查运行环境」查看运行时状态，或新建会话保留历史。执行绑定或源历史异常时禁止重建。'
      }
      return stage + '本地连续性校验受阻，重复发送不会修复；请用 /repair-prefix 检查恢复资格，或保留原会话并用 /logs 导出诊断。执行绑定或源历史异常时禁止重建。'
    }
    case 'rate_limit':
      return '限流/额度不足：稍等片刻再发，或 /model 切轻量档（如 deepseek-v4-flash）；持续 429 先查余额（桌面端 Insights 面板）'
    case 'overloaded':
    case 'server_error':
      return '服务商暂时性故障：稍后重发，或 /model 切换服务商'
    case 'timeout':
      return '网络超时：检查网络/代理后重发；反复超时用 /doctor 体检'
    case 'auth_error':
      return '认证失败：/connect 检查 API Key；订阅型（codex）用 /login 重新授权'
    case 'request_body_too_large':
      return '请求体超过传输上限：减少附件或压缩历史'
    case 'context_overflow':
      return '上下文超限：/compact 压缩，或 /handoff 交接后开新会话'
    case 'client_error':
      return '请求被拒（模型 id 或端点路径错）：/model 确认模型；自定义端点检查 baseUrl 是否缺 /v1'
    case 'tool_protocol':
      return surface === 'desktop' ? '模型返回的工具名无法与本次提供的工具唯一对应，工具未执行。请切换模型后重试；持续出现请导出诊断。'
        : '模型返回的工具名无法与本次提供的工具唯一对应，工具未执行。用 /model 切换模型后重试；持续出现用 /logs 导出诊断。'
    case 'image_strip':
      return '图片负载超限：去掉部分图片后重发'
    case 'reasoning_echo':
      return '该网关要求回传思考内容（reasoning_content）：已在本次重试中保留；'
        + '若持续出现，在该 provider 的 capabilities 里声明 preservedThinkingProtocol: true'
    case 'stream_parse':
      return '流解析失败：重发一次；反复出现用 /logs 打包日志提 issue'
    case 'malformed_response':
      return '上游返回了畸形的 HTTP 响应（网关/WAF 边缘节点故障）：已自动换连接重试；'
        + '仍失败就稍后重发或 /model 换个服务商——不是本机网络问题'
    case 'reasoning_repetition':
      return '检测到推理短句持续重复，已停止请求；建议新建会话或 /model 切换模型后重试'
    default:
      return '重发一次；持续失败：/doctor 体检 + /logs 看日志'
  }
}

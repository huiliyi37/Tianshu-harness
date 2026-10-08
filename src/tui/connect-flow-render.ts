/**
 * Render and formatting helpers for the in-TUI /connect provider setup wizard.
 *
 * Extracted from connect-flow.ts to keep the headless state machine under
 * source line budgets while isolating report/capability formatting logic.
 */

import type { ModelMatchResult } from '../api/model-id-matcher.js'
import { VISION_PROBE_GROUND_TRUTH, type ProbeReport } from '../api/provider-probe.js'
import type { ProviderPreset } from '../config/provider-presets.js'

/** One rendered line of the probe report (overlay applies tone colors). */
export interface ProbeLine {
  text: string
  tone?: 'ok' | 'fail' | 'head' | 'muted'
}

export const checkMark = (ok: boolean): string => (ok ? '✔' : '✘')

export function matchDescription(match: ModelMatchResult): string {
  if (!match.entry) return '未知模型——上下文长度按默认值落盘，可事后用 config 修改'
  if (match.tier === 'fuzzy') return `≈ ${match.entry.canonicalId}（低置信推断，元数据请核对）`
  return `已知模型 ${match.entry.canonicalId}，元数据自动回填`
}

/** Structured diagnosis for probe errors: likely causes + suggested actions. */
export function probeDiagnosis(errors: string[]): ProbeLine[] {
  const text = errors.join(' ')
  const causes: string[] = []
  const quotaIssue = /quota|FreeTierOnly|insufficient|arrearage/i.test(text)
  if (quotaIssue) causes.push('免费额度已用完或账号未开通付费——到服务商控制台充值 / 开通按量付费（这是账号配额问题，不是密钥错误）')
  if (/401|403/.test(text)) causes.push('API Key 无效、过期，或无权访问该模型', 'Base URL 与 Key 所属环境不匹配')
  if (/404/.test(text)) causes.push('端点路径可能不正确（缺 "/v1" 后缀），或模型型号不存在')
  if (/timed out|timeout/i.test(text)) causes.push('网络不通、需要代理，或端点响应过慢')
  if (/SSE|stream/i.test(text)) causes.push('端点未返回流式响应——可能不支持流式，或 Base URL 不正确')
  if (causes.length === 0) causes.push('端点未按预期响应')
  const advice: string[] = []
  if (!quotaIssue) advice.push('重新输入 API Key（到服务商控制台确认 Key 状态与余额）')
  advice.push('核对 Base URL 与 Key 所属环境一致', '网络受限时配置代理后重试')
  return [
    { text: '可能原因：', tone: 'head' },
    ...causes.map(c => ({ text: `· ${c}`, tone: 'muted' as const })),
    { text: '建议操作：', tone: 'head' },
    ...advice.map(a => ({ text: `· ${a}`, tone: 'muted' as const })),
  ]
}

/** Connectivity-test report: 3-step checklist, then errors + diagnosis. */
export function probeReportLines(report: ProbeReport): ProbeLine[] {
  const lines: ProbeLine[] = [{ text: '连通性测试', tone: 'head' }]
  const reachable = report.modelsOk || report.completionOk
  lines.push({ text: `${checkMark(reachable)} 1/3 检查端点连通性`, tone: reachable ? 'ok' : 'fail' })
  lines.push({
    text: `${checkMark(report.modelsOk)} 2/3 获取模型列表${report.modelsOk ? `（${report.models.length} 个）` : ''}`,
    tone: report.modelsOk ? 'ok' : 'fail',
  })
  const step3 = report.visionTested ? '3/3 视觉真测（发送内置图片）' : '3/3 发送最小推理请求'
  lines.push({
    text: `${checkMark(report.completionOk)} ${step3}${report.completionOk && report.latencyMs !== undefined ? `（首字节 ${report.latencyMs}ms）` : ''}`,
    tone: report.completionOk ? 'ok' : 'fail',
  })
  if (report.hints.reasoningSplit) lines.push({ text: '✔ 探测到思考分块（reasoning_content）', tone: 'ok' })
  // 视觉真测通过：展示模型回答 + 图片真相，供用户肉眼核对（不做自动判分）。
  // 失败时不展示任何模型输出——只保留下方错误与可能原因/建议操作。
  if (report.visionTested && report.completionOk) {
    lines.push({ text: '模型回答：', tone: 'head' })
    lines.push({ text: report.visionAnswer?.trim() ? report.visionAnswer.trim() : '（模型未返回文本）', tone: 'muted' })
    lines.push({ text: '图片真实内容：', tone: 'head' })
    lines.push({ text: VISION_PROBE_GROUND_TRUTH, tone: 'muted' })
  }
  if (report.errors.length === 0) {
    lines.push({ text: '端点配置有效，满足 coding agent 的基本要求。', tone: 'ok' })
    return lines
  }
  for (const err of report.errors) lines.push({ text: `错误：${err}`, tone: 'fail' })
  lines.push(...probeDiagnosis(report.errors))
  return lines
}

/**
 * Capability-check page content: measured rows (completion/streaming/token
 * usage/reasoning split) come from the probe; Vision/Tool Calling are
 * metadata inferences and labeled as such.
 */
export function capabilityLines(
  report: ProbeReport,
  picked: Array<{ rawId: string; match: ModelMatchResult }>,
  preset: ProviderPreset,
): ProbeLine[] {
  const known = picked.find(p => p.match.entry !== undefined)
  const template = (preset.provider.models ?? []).find(m => m.id === preset.defaultModelId)
  const meta: { supportsVision?: boolean } | undefined = known?.match.entry?.metadata ?? template
  const lines: ProbeLine[] = [{ text: '能力检测', tone: 'head' }]
  const ok = report.completionOk
  lines.push({ text: `${checkMark(ok)} Chat Completion（实测）`, tone: ok ? 'ok' : 'fail' })
  lines.push({ text: `${checkMark(ok)} 流式输出 SSE（实测）`, tone: ok ? 'ok' : 'fail' })
  lines.push({ text: `${checkMark(ok)} Token 用量统计（实测）`, tone: ok ? 'ok' : 'fail' })
  const split = report.hints.reasoningSplit === true
  lines.push(split
    ? { text: '✔ 思考分块 reasoning_content（实测）', tone: 'ok' }
    : { text: '⚠ 未检测到思考分块（不影响使用）', tone: 'muted' })
  const vision = meta?.supportsVision === true
  if (report.visionTested) {
    lines.push({
      text: `${checkMark(report.completionOk)} Vision 视觉真测（实测：内置图片${report.completionOk ? '描述成功' : '未通过'}）`,
      tone: report.completionOk ? 'ok' : 'fail',
    })
  } else {
    lines.push({ text: `${vision ? '✔' : '⚠'} Vision ${vision ? '支持' : '不支持'}（按模型元数据）`, tone: vision ? 'ok' : 'muted' })
  }
  const toolKnown = known !== undefined || template !== undefined
  lines.push(toolKnown
    ? { text: '✔ Tool Calling 工具调用（已知模型，元数据支持）', tone: 'ok' }
    : { text: '⚠ Tool Calling 未验证（未知模型，建议事后实测）', tone: 'muted' })
  const modelLabel = picked[0]?.rawId ?? preset.defaultModelId
  lines.push(ok
    ? { text: `当前模型 "${modelLabel}" 满足 coding agent 的基本要求。`, tone: 'ok' }
    : { text: `"${modelLabel}" 能力检测不完整——端点异常，详见连通性测试。`, tone: 'fail' })
  return lines
}

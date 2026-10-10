/**
 * 记忆写入前的敏感信息过滤（阶段5 · 安全）。
 *
 * auto-capture / consolidation 会把操作信息截取成摘要写入长期记忆。摘要有可能
 * 顺着工具结果把 API key、token、密码、私钥等带进来——这些一旦落进 `.rivet/
 * knowledge/memory.jsonl` 就跨会话长期存在，是泄露风险。本模块在**写入前**对
 * 文本做保守 scrub：命中敏感模式 → 替换为 `***`；若一段文本 scrub 后几乎全是
 * 占位符（只剩密码意义）则判定为"纯敏感"，调用方应丢弃该条（fail-closed）。
 */

const SENSITIVE_PATTERN = new RegExp(
  [
    // OpenAI/Anthropic/Mistral 常见 API key
    String.raw`sk-[A-Za-z0-9_-]{16,}`,
    String.raw`sk-[A-Za-z0-9_-]{12,}`,
    // AWS access key
    String.raw`AKIA[0-9A-Z]{16}`,
    // Bearer token（含 JWT）
    String.raw`Bearer\s+[A-Za-z0-9._~+/=\-]{16,}`,
    // GitHub token（ghp_/gho_/ghu_/ghs_/ghr_ 五类前缀，后接 36+ 位 base62；\b 防嵌入正文词）
    String.raw`\bgh[pousr]_[A-Za-z0-9]{36,}`,
    // GitLab Personal Access Token
    String.raw`\bglpat-[A-Za-z0-9_\-]{20,}`,
    // HuggingFace user access token
    String.raw`\bhf_[A-Za-z0-9]{30,}`,
    // Slack bot/user/app token（xoxb-/xoxp-/xoxa-/xoxr-/xoxs-）
    String.raw`\bxox[baprs]-[A-Za-z0-9\-]{10,}`,
    // Stripe 活密钥（sk_live_ 机密 / rk_live_ 受限）
    String.raw`\b(?:sk|rk)_live_[A-Za-z0-9]{16,}`,
    // Telegram bot token（<8~10 位 bot_id>:<35 位随机串>；长度约束避免误杀 "14:30" 一类时间）
    String.raw`\b[0-9]{8,10}:[A-Za-z0-9_\-]{30,}`,
    // npm access token
    String.raw`\bnpm_[A-Za-z0-9]{30,}`,
    // PyPI API token
    String.raw`\bpypi-[A-Za-z0-9_\-]{20,}`,
    // JWT（三段 base64url）
    String.raw`eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}`,
    // 显式赋值的凭据
    String.raw`(api[_-]?key|secret|password|passwd|token|access[_-]?token|auth)\s*[:=]\s*[^\s,;'"<>]{4,}`,
    // 私钥块：真实 PEM 头的类型词与 KEY 之间是 PRIVATE（RSA PRIVATE KEY /
    // OPENSSH PRIVATE KEY / EC PRIVATE KEY / DSA PRIVATE KEY），另有裸
    // PRIVATE KEY（PKCS#8）与 PGP PRIVATE KEY BLOCK。必须**整块**替换——
    // 从头行起、吞掉主体 base64 行，直到同型 END 尾；只替头行会让 base64
    // 主体漏存进长期记忆。无 END 尾（只有头行）时退化为只替头行。
    String.raw`-{5}BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-{5}(?:[\s\S]*?-{5}END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-{5})?`,
    // 常见环境变量式
    String.raw`(DEEPSEEK|OPENAI|ANTHROPIC|GITHUB|AWS|GITLAB|HUGGINGFACE|HF|AZURE|GOOGLE)[_ ]?(API)?[_ ]?(KEY|SECRET|TOKEN)\s*=\s*\S+`,
  ].join('|'),
  'g',
)

const PLACEHOLDER = '***'

/** 敏感命中判定（是否含任何敏感模式）。 */
export function containsSensitive(text: string): boolean {
  SENSITIVE_PATTERN.lastIndex = 0
  return SENSITIVE_PATTERN.test(text)
}

/**
 * 保守 scrub：把命中的敏感片段替换为 `***`，保留其余文本。
 * 判定"几乎全是敏感"（占位符占比过高）时返回 null，让调用方丢弃该条。
 */
export function scrubMemoryText(text: string): string | null {
  const scrubbed = text.replace(SENSITIVE_PATTERN, PLACEHOLDER)
  // 占位符占比过高 → 这段只剩密码，无有用信息，丢弃。
  const placeholderCount = (scrubbed.match(/\*\*\*/g) ?? []).length
  const nonPlaceholder = scrubbed.replace(/\s*\*\*\*\s*/g, '').trim()
  if (placeholderCount >= 2 && nonPlaceholder.length < 12) return null
  return scrubbed
}

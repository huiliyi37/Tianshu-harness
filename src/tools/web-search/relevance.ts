import type { SearchResult } from './types.js'

/**
 * 搜索结果的「跑题/降级」守卫。
 *
 * 背景（2026-09 两轮实测复现）：
 *
 * 1) 语言错位——cn.bing.com 在请求携带英文语言标识时返回 HTTP 200、结构完好、
 *    内容与查询完全无关的 SERP。零重叠判据兜住了这一类。
 * 2) 降级泛结果——去掉英文标识后仍存在：多词查询只匹配其中最泛的那个词
 *    （`美国 AI 实验室 出逃 事件 7月 智能体` → 清一色"美国"百科/领事馆页面）。
 *    这类结果**能命中一个泛词**，零重叠判据全数放行，于是劣质结果被当成答案交给
 *    模型。实测 8 组真实 SERP 中 4 组降级，且触发面不限于长查询——`美国 AI 实验室`
 *    这类普通三词查询同样中招。
 *
 * 本模块的判据：按**查询词覆盖**计分，要求「覆盖 ≥2 个不同查询词」的结果过半数才
 * 判相关。同一个查询词内的多枚 bigram 只计一词——否则「量子计算」这一个词靠
 * 量子/子计/计算 三枚 bigram 就能自重叠虚高，把只含该词的结果送过闸门。
 *
 * 保守边界：查询提不出词元、或只有单个查询词（没有多词覆盖信号可比对）时，
 * 退回零重叠判据；空结果集不判定（"没有结果"是 chain 的既有路径）。宁可漏掉
 * 一次跑题，也不误杀一批正常结果——误杀的代价是丢掉本来可用的答案。
 */

/** 无空格文字字符（汉字含扩展 A / 日文假名 / 韩文谚文）——段内分块与 bigram 的判定。 */
const CJK_CHAR = /[\u3041-\u30fa\u30fc-\u30ff\u3400-\u9fff\uac00-\ud7af]/

/** 搜索操作符 `site:host`（web_map 的站点内搜索会拼出 `关键词 site:host`）。 */
const SITE_OPERATOR = /\bsite:\S+/gi

/**
 * 把查询切成「查询词 → 匹配词元」的分组。
 *
 * 切词：`[a-z0-9 + 无空格文字（汉字/假名/谚文）]+` 连续段（空格与标点都是
 * 分隔；全角与半角片假名先经 NFKC 归一），长度 <2 的段丢弃。
 * 词元：段先统一小写（与 haystack 同口径），再按段内分块出词（segmentTokens）：
 * 无空格文字块按 bigram（`杭州西湖` → `杭州`/`州西`/`西湖`），拉丁数字块整词，
 * 单字符块与相邻块桥接（`7月` → `7月`、`K线` → `k线`）。
 *
 * `site:host` 操作符整段剔除：域名只会出现在结果的 URL 里，而 URL 不参与匹配，
 * 留着它会把「关键词 site:host」的站点内搜索一律判成跑题。
 *
 * 分组是判据的计分单位：一个分组命中（组内任一词元出现在结果中）= 覆盖一个查询词。
 * 词元顺序与查询中出现顺序一致——混合中英文时才能稳定断言。
 */
export function queryTokenGroups(query: string): string[][] {
  const groups: string[][] = []
  // NFKC 先行归一：全角字母数字（Ａ→A）与半角片假名（ﾃｽﾄ→テスト）并入常规
  // 字符类；假名/谚文查询曾因字符类不含它们而提不出词元，守卫静默整批放行。
  // site 操作符整体剔除（域名只出现在结果的 URL 里，URL 不参与匹配）。
  // 单次扫描按位置切分，保证中英文混排时的产出顺序等于查询顺序。
  const scan = /[a-z0-9\u3041-\u30fa\u30fc-\u30ff\u3400-\u9fff\uac00-\ud7af]+/gi
  let m: RegExpExecArray | null
  while ((m = scan.exec(query.replace(SITE_OPERATOR, ' ').normalize('NFKC'))) !== null) {
    // 与 haystack 同口径先小写：否则「K线」的 bigram 在小写后的「k线」里永久失配。
    const chunk = m[0].toLowerCase()
    if (chunk.length < 2) continue
    const tokens = segmentTokens(chunk)
    if (tokens.length > 0) groups.push(tokens)
  }
  return groups
}

/**
 * 段内出词：按脚本把段切成「拉丁数字块 / 无空格文字块」交替序列，再分别出词。
 *
 * - 无空格文字块（汉字/假名/谚文）≥2 字符 → 字符 2-gram（`杭州西湖` →
 *   `杭州`/`州西`/`西湖`）；
 * - 拉丁数字块 ≥2 字符 → 整词（`deepseek`）；
 * - 单字符块与相邻块桥接成一个 2 字符词元（`7月` → `7月`、`K线` → `k线`、
 *   `k线图` → `k线`）——不会因为拆块把混合词漏掉。
 *
 * 拆块的理由（2026-09-30，混合段过匹配修复）：整段走 bigram 会把长拉丁前缀
 * 撕成 2 字符碎片（`MACD金叉` → `ma`/`ac`/`cd`/…），碎片用 includes 子串匹配
 * 在无关英文文本里高概率命中，单查询词的零重叠判据被噪声击穿（`ma` 命中
 * `marketing`、「ac」命中 `academy`）。拉丁部分按整词后
 * `MACD金叉` → `macd` + `金叉`，碎片噪声消失、语义仍可命中。
 */
function segmentTokens(chunk: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  const push = (t: string): void => {
    if (!seen.has(t)) {
      seen.add(t)
      tokens.push(t)
    }
  }
  const blocks = chunk.match(/[a-z0-9]+|[\u3041-\u30fa\u30fc-\u30ff\u3400-\u9fff\uac00-\ud7af]+/gi) ?? [chunk]
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    if (CJK_CHAR.test(block)) {
      if (block.length >= 2) {
        for (let j = 0; j + 2 <= block.length; j++) push(block.slice(j, j + 2))
      } else {
        // 单字符无空格文字：与相邻块桥接（`k线` / `6年` / `d金`）
        const prev = blocks[i - 1]
        const next = blocks[i + 1]
        if (prev) push(prev.slice(-1) + block)
        else if (next) push(block + next.slice(0, 1))
      }
    } else if (block.length >= 2) {
      push(block)
    } else {
      // 单字符拉丁块：只经桥接出词（`k线图` 的 `k` → `k线`），不单独成词
      const next = blocks[i + 1]
      if (next) push(block + next.slice(0, 1))
    }
  }
  return tokens
}

/** 扁平词元列表（分组结构的展开）。 */
export function queryTokens(query: string): string[] {
  return queryTokenGroups(query).flat()
}

/**
 * 判定一批结果是否整批跑题/降级。
 *
 * 判据：
 *   - 空结果集 → false（"没有结果"是 chain 的既有路径，不归本守卫管）
 *   - 查询提不出词元 → false（无判据可依时放行）
 *   - 单个查询词 → 零重叠判据（任一命中即放行，全批零命中判跑题）
 *   - 多个查询词 → 覆盖 ≥2 个不同查询词的结果过半数才放行；否则判跑题
 *
 * URL 不参与匹配：命中一个 slug 是噪声（`/hangzhou-xihu-menpiao` 可能挂在完全
 * 无关的垃圾站上），只会让守卫失效。
 */
export function looksOffTopic(query: string, results: readonly SearchResult[]): boolean {
  if (results.length === 0) return false
  const groups = queryTokenGroups(query)
  if (groups.length === 0) return false

  const haystacks = results.map(r => `${r.title} ${r.snippet}`.toLowerCase())

  // 单查询词：没有「多词覆盖」信号可依，退回零重叠判据（保守）。
  if (groups.length === 1) {
    const tokens = groups[0]!
    return !haystacks.some(h => tokens.some(t => h.includes(t)))
  }

  // 多查询词：要求覆盖 ≥2 个查询词的结果过半数——单个泛词命中骗不过判据。
  let multiCovered = 0
  for (const h of haystacks) {
    let covered = 0
    for (const tokens of groups) {
      if (tokens.some(t => h.includes(t))) {
        covered++
        if (covered >= 2) {
          multiCovered++
          break
        }
      }
    }
  }
  return multiCovered * 2 <= results.length
}

/** chain 用它标记"结果跑题/降级"，供上层把这类软失败与硬错误区分开。 */
export const OFF_TOPIC_ERROR = 'off-topic results'

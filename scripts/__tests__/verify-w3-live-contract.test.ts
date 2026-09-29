/**
 * `verify-w3-live.sh` 的契约守卫（文本级）。
 *
 * ## 为什么需要它
 * 这个脚本只能对着线上环境跑，CI 里跑不了——于是它的行为没有任何自动化守护。
 * 2026-09-25 的缺陷正是从这个缺口进来的：`PLAN_IDS` 抓取失败时 canonical 10 行
 * 检查整段不执行（`if` 没有 `else`），而结尾只看 `fail` 标志，脚本照样打印
 * 「W3 线上口径验收通过」并 exit 0。**一次「通过」的验收，其中一项从未执行。**
 *
 * 修法是把「取不到证据」一律判 FAIL（无证据不得判通过）。本文件钉住这条纪律，
 * 防止后来者为了「让验收跑过」而把 FAIL 改回 SKIP、或把 curl 失败重新吞进 `|| true`。
 *
 * 这不是重实现脚本，只断言三件事：证据缺席时必须计失败、必须能区分「取不到」
 * 与「未命中」、以及刻意保留的 `set -u`（不放 `set -e`，因为脚本语义是跑完全部
 * 检查再汇总，中途退出会隐藏后续失败项）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(here, '..', '..', '.rivet', 'patches', 'verify-w3-live.sh')
// .rivet/ 是 gitignored 的 dev 环境资产：公开仓 checkout 里不存在该脚本
// （sync 不携带）。缺失时整组跳过——文本守卫只对持有该脚本的环境有意义；
// 用硬性 ENOENT 失败会让公开仓 CI 恒红（2026-09 实测）。
const scriptExists = existsSync(SCRIPT_PATH)
const src = scriptExists ? readFileSync(SCRIPT_PATH, 'utf-8') : ''

describe('verify-w3-live.sh：证据缺席不得判通过', { skip: !scriptExists }, () => {
  it('数据库四项「取不到」都必须显式 FAIL 并计 fail=1', () => {
    const cases: Array<[string, RegExp]> = [
      ['publishable key 未取到', /FAIL 数据库：未从公开产物取得 publishable key[^\n]*fail=1/],
      ['pro 描述未取到', /FAIL 数据库：未能取到 pro 描述[^\n]*fail=1/],
      ['sponsor_lifetime 描述未取到', /FAIL 数据库：未能取到 sponsor_lifetime 描述[^\n]*fail=1/],
      ['plan ids 未取到（canonical 检查未执行）', /FAIL 数据库：未能取得 plan ids[^\n]*fail=1/],
    ]
    for (const [label, re] of cases) {
      assert.match(src, re, `${label} 时必须 FAIL 并计 fail（不得静默跳过）`)
    }
  })

  it('不再用 SKIP 把未执行的检查伪装成非失败', () => {
    assert.doesNotMatch(src, /SKIP 数据库/, 'SKIP 不计 fail —— 未执行的检查会随「通过」一起溜出去')
  })

  it('curl 失败与「未命中」可区分：页面获取走 fetch()，失败在调用点判 FAIL', () => {
    assert.match(src, /fetch\(\)\s*\{/, '需要 fetch() 包装来暴露 curl 的退出码')
    assert.match(src, /if ! body=\$\(fetch "\$1"\)/, '取不到页面必须走独立分支，不能吞成「未命中 0 次」')
    assert.match(src, /网络\/站点不可达，非文案问题/, '取不到时的文案要指向真因，避免被误归因到文案')
  })

  it('刻意保留 set -u 且不放 set -e：跑完全部检查再汇总', () => {
    assert.match(src, /^set -u$/m, 'set -u 仍在（未定义变量即失败）')
    assert.doesNotMatch(src, /^\s*set -e/m, 'set -e 会让首个失败中断后续检查，隐藏其余失败项')
  })

  it('退出码由 fail 派生：有任一失败项即非 0', () => {
    assert.match(src, /exit "\$fail"/, '验收结论必须体现在退出码上，调用方才拿得到')
  })
})

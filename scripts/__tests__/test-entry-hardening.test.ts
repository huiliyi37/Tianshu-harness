/**
 * 所有测试入口都必须有界收场，且汇总必须完整 —— 不只走 run-node-tests.ts 的那条。
 *
 * ## 两条纪律，来自两起事故
 *
 * **一（2026-07-29）：任何直接 `node --test` 的入口都必须带 `--test-timeout`。**
 * 一个 `npm run test:desktop` 进程跑满 2 天 13 小时、占着 75% CPU，SIGTERM 都不吃。
 * Node 不设超时就是 Infinity，任一测试卡住整个批次永久挂着。它的后果不止是烧一个核——
 * 被它拖慢的机器上，依赖时间窗的测试（临时 git 仓变更率、watchdog 定时器、spawn tsc）
 * 成批失败，而这些失败看起来像是当前改动引入的回归，排查因此走了几小时弯路。
 *
 * **二（2026-09-12）：任何直接 `node --test` 的入口都不得带 `--test-force-exit`。**
 * 2026-08-02 曾把该 flag 定为硬性要求（当时它承担"句柄未释放也能收场"的职责，代价是
 * 偶发少跑）。2026-09-12 实测翻转：同一批 desktop 197 个文件四次跑报
 * 1523 / 1640 / 1661 / **无汇总**，四次 exit 0 且 fail 0；同批 plain 跑两次稳定报 1789
 * 且进程正常退出；`--test-concurrency=1` 也救不了（1752）。flag 会让 node 提前判定
 * "全部完成"并退出，**丢掉的用例既不计入 `ℹ tests` 也不进退出码**——退出码与 fail 计数
 * 双双不可信。它原来的兜底职责改由 `scripts/test-child-guard.ts` 承担：
 * plain 跑法 + idle/hard 看门狗 + 汇总完整性 fail-closed（没有汇总段即判失败）。
 *
 * 所以这里锁两件事：直接入口**必须**带 `--test-timeout`、**不得**带 `--test-force-exit`；
 * 并且 desktop 侧入口必须走带 guard 的 runner，防止有人图省事退回裸 `node --test`。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TEST_TIMEOUT_MS } from '../test-runner-flags.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 仓库内所有含 scripts 的 package.json。新增子包时在此登记。 */
const MANIFESTS = [
  'package.json',
  'desktop/package.json',
  'vscode-extension/package.json',
]

// 公开仓同步树不带 desktop/ 等子包——按实际存在的清单审计，门禁照样非空扫。
const presentManifests = MANIFESTS.filter(m => existsSync(join(repoRoot, m)))

interface DirectEntry {
  manifest: string
  script: string
  command: string
}

/**
 * 直接 spawn `node ... --test` 的脚本条目。
 *
 * 只认 `node` 开头的命令：走 `tsx scripts/run-node-tests.ts` 或
 * `node --import tsx desktop/scripts/run-tests.ts` 的入口由 runner 自己加参数
 * （nodeTestFlags / test-child-guard），命令行里看不到也不该看到 `--test-timeout`。
 */
function collectDirectNodeTestEntries(): DirectEntry[] {
  const out: DirectEntry[] = []
  for (const manifest of presentManifests) {
    const raw = readFileSync(join(repoRoot, manifest), 'utf8')
    const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {}
    for (const [script, command] of Object.entries(scripts)) {
      if (!/(^|\s|&&\s*)node\s/.test(command)) continue
      // `--test` 而非 `--test-xxx`：后者是同族参数，不代表这条命令在跑测试。
      if (!/--test(\s|$)/.test(command)) continue
      out.push({ manifest, script, command })
    }
  }
  return out
}

function readScripts(manifest: string): Record<string, string> {
  return (JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8')) as {
    scripts?: Record<string, string>
  }).scripts ?? {}
}

describe('测试入口挂死与假绿护栏', () => {
  test('审计到的直接 node --test 入口不为空（保证这条门禁没在空扫）', () => {
    const entries = collectDirectNodeTestEntries()
    assert.ok(
      entries.length >= 1,
      `期望至少 1 个直接入口（vscode-extension test），实际 ${entries.length} 个。`
        + '2026-09-12 起 desktop 侧改为走 run-tests runner，故不再是直接入口。',
    )
  })

  test('每个直接 node --test 入口都带 --test-timeout', () => {
    for (const { manifest, script, command } of collectDirectNodeTestEntries()) {
      assert.match(
        command,
        /--test-timeout=\d+/,
        `${manifest} 的 "${script}" 缺 --test-timeout。Node 默认是 Infinity：`
          + `任一测试卡住，这个进程就永久挂着占 CPU（曾实测挂满 2 天 13 小时）。命令：${command}`,
      )
    }
  })

  test('每个直接 node --test 入口都不得带 --test-force-exit', () => {
    for (const { manifest, script, command } of collectDirectNodeTestEntries()) {
      assert.doesNotMatch(
        command,
        /--test-force-exit(\s|$)/,
        `${manifest} 的 "${script}" 带上了 --test-force-exit：它会让 node 提前判定完成并退出，`
          + `丢掉的用例既不计入 ℹ tests 也不进退出码（实测同一批四次跑报 1523/1640/1661/无汇总，`
          + `全部 exit 0、fail 0，而 plain 稳定报 1789）。要兜"句柄未释放"请走 `
          + `scripts/test-child-guard.ts（plain + 看门狗 + 汇总完整性闸）。命令：${command}`,
      )
    }
  })

  test('超时值与 CLI runner 的默认值一致 —— 两套阈值会各自漂移', () => {
    for (const { manifest, script, command } of collectDirectNodeTestEntries()) {
      const found = command.match(/--test-timeout=(\d+)/)
      assert.ok(found, `${manifest}:${script} 应已在上一条断言中被拦下`)
      assert.equal(
        Number(found[1]),
        DEFAULT_TEST_TIMEOUT_MS,
        `${manifest} 的 "${script}" 超时值与 test-runner-flags.ts 的 `
          + `DEFAULT_TEST_TIMEOUT_MS(${DEFAULT_TEST_TIMEOUT_MS}) 不一致。package.json 没法 import 常量，`
          + `所以靠这条断言把两处钉在一起——改默认值时这里会红，提醒同步。`,
      )
    }
  })

  test('desktop 测试入口走带 guard 的 runner（不退回裸 node --test）', () => {
    assert.ok(
      existsSync(join(repoRoot, 'scripts', 'test-child-guard.ts')),
      'scripts/test-child-guard.ts 必须存在——它是失去 --test-force-exit 后的兜底与完整性闸',
    )
    assert.match(
      readScripts('package.json')['test:desktop'] ?? '',
      /run-tests/,
      '根 test:desktop 应走 desktop/scripts/run-tests.ts（内含 test-child-guard）',
    )
    if (presentManifests.includes('desktop/package.json')) {
      assert.match(
        readScripts('desktop/package.json')['test'] ?? '',
        /run-tests/,
        'desktop 的 test 应走同一个 runner，否则两处入口的汇总可信度会各走一套',
      )
    }
  })
})

/**
 * 测试隔离：runner 必须把 rivetHome() 钉到本次运行的临时目录（2026-09-23）。
 *
 * 此前测试直接吃开发者真实 home：往 ~/.rivet 灌授权 / checkpoint / 会话 / 许可证
 * 等真实数据；一旦该目录不可写（沙箱 / CI / 只读 home），写入被各处 best-effort
 * catch 静默吞掉、断言看到空状态——同一类假红实测横跨 8 个文件 50 条
 * （path-grants / checkpoint / checkpoint-isolation / coordinator-session-resume…），
 * 形状上与被测代码坏了无法区分。rivetHome() 的优先级是 RIVET_HOME > 平台默认，
 * 因此钉 RIVET_HOME 即可；HOME 刻意不动（defaultRivetHome() 派生的路径断言按真实
 * $HOME 语义继续跑）。删掉这行会让那 50 条在受限环境里再次假红。
 */
describe('runner 测试隔离（RIVET_HOME）', () => {
  const runner = readFileSync(join(repoRoot, 'scripts', 'run-node-tests.ts'), 'utf8')

  test('run-node-tests.ts 给子进程钉 RIVET_HOME，且每轮从干净目录起步', () => {
    assert.match(
      runner,
      /RIVET_HOME:\s*ISOLATED_RIVET_HOME/,
      'runner 必须把 RIVET_HOME 指向本次运行的临时目录，否则测试会写进开发者真实 ~/.rivet',
    )
    assert.match(
      runner,
      /rmSync\(ISOLATED_RIVET_HOME,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/,
      '每轮必须清掉上一轮的 grants/checkpoint 残留（否则「不得从磁盘复活」类断言被旧数据证伪）',
    )
    assert.doesNotMatch(
      runner,
      /(?<!RIVET_)HOME:\s*\S/,
      '不要连 HOME 一起改：defaultRivetHome() 派生的路径断言（workspace-config / pro-license）按真实 $HOME 语义跑',
    )
  })
  // desktop 侧刻意不钉：实测 desktop/src 全量不引用 rivetHome()（只有 locale 文案
  // 提到 RIVET_HOME），加了既无被测对象、又给桌面套件引入未验证的环境差异。
  // 哪天桌面测试开始读写 rivetHome()，这里再加对应断言。
})

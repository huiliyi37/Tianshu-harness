/**
 * issue #235 Wave 2 —— 让出护栏的**接线测试**：真实 bash 工具 + 真实探测，不打 mock。
 *
 * 为什么单独一个文件：`bash-yield.test.ts` 全部直接调 `maybeYieldForUserActivity` 并注入
 * probe，它证明的是「判定函数对」，不证明「bash 工具真的接上了」——删掉 bash.ts 里那行
 * 调用，那 10 条用例照样全绿。原计划的门禁原文要求「新测试用**真实 bash 工具链**，
 * 构造'命中签名 + 用户活跃'输入，断言命令不执行」，本文件补的就是这一条。
 *
 * 真实探测在 darwin 上起 osascript（实测 ~234ms），所以「用户活跃」不靠 mock 造：
 * 把阈值抬到远大于真实 idle（999999ms）即可，等价于「用户刚在操作」。
 * 非 darwin 平台探测恒返回 null（不阻断），那两条用例没有判据 → 显式跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASH_TOOL, __setYieldWatchProbeForTests } from '../bash.js'

/** 命中注入签名（xdotool）但真执行也无害——护栏失效时不会伤到本机。 */
const HAZARD = 'echo "xdotool key ctrl+v"'
const SAFE = 'echo plain-ok'

/**
 * 「用户刚在操作」的等价阈值——必须**大于任何可能的真实 idle**。
 *
 * 踩坑（2026-09-23 本机实测）：这里原先写 `999999`。机器空闲超过 16.6 分钟后真实
 * idle 就超过它（实测 1159231ms），`isUserActive` 判 false，三条「期望让出」的用例
 * 齐红；而同一文件里「期望照常执行」的用例照样绿——症状看着像接线坏了，实际是阈值
 * 被真实空闲击穿（`bash-yield-wiring.test.ts` 的单跑/全量结果会因此不一致）。
 * 取 10 天：远超任何单次会话的空闲时长，同时仍是安全整数。
 */
const ALWAYS_ACTIVE_MS = '864000000'

type BashParams = Parameters<typeof BASH_TOOL.execute>[0]

async function runBash(command: string, yieldMs: string, extra: Partial<BashParams> = {}, watchMs?: string) {
  const prev = process.env.RIVET_CU_YIELD_MS
  const prevWatch = process.env.RIVET_CU_YIELD_WATCH_MS
  process.env.RIVET_CU_YIELD_MS = yieldMs
  if (watchMs !== undefined) process.env.RIVET_CU_YIELD_WATCH_MS = watchMs
  try {
    return await BASH_TOOL.execute({
      input: { command },
      toolUseId: 'wiring-probe',
      cwd: process.cwd(),
      ...extra,
    } as BashParams)
  } finally {
    if (prev === undefined) delete process.env.RIVET_CU_YIELD_MS
    else process.env.RIVET_CU_YIELD_MS = prev
    if (prevWatch === undefined) delete process.env.RIVET_CU_YIELD_WATCH_MS
    else process.env.RIVET_CU_YIELD_WATCH_MS = prevWatch
  }
}

test(
  '真实链路：命中签名 + 用户活跃（阈值置顶）→ 命令不执行，返回让出文案',
  { skip: process.platform !== 'darwin' ? 'real probe only returns a number on darwin' : false },
  async () => {
    const r = await runBash(HAZARD, ALWAYS_ACTIVE_MS)
    assert.equal(r.isError, true, '让出必须让模型看见（isError），否则会被当成执行成功')
    assert.match(r.content, /让出/)
    assert.match(r.content, /computer_use/, '文案要指向正路')
    assert.doesNotMatch(r.content, /xdotool key ctrl\+v"\n/, '命令不得真的执行')
    assert.doesNotMatch(r.content, /exit=0/, '不得出现命令执行回执')
  },
)

test(
  '真实链路：命令刚被批准（approvalGrantedAt）→ 批准次数本身不算「用户正在操作」',
  { skip: process.platform !== 'darwin' ? 'real probe only returns a number on darwin' : false },
  async () => {
    const r = await runBash(HAZARD, ALWAYS_ACTIVE_MS, { approvalGrantedAt: Date.now() })
    assert.notEqual(r.isError, true, '已批准的命令必须能执行——否则用户「批准 → 被跳过」循环')
    assert.match(r.content, /xdotool key ctrl\+v/, '命令应真的跑过（echo 回显）')
  },
)

test(
  '真实链路：引号拼接的注入（与审批门同视图）→ 同样让出，不再从护栏下漏过',
  { skip: process.platform !== 'darwin' ? 'real probe only returns a number on darwin' : false },
  async () => {
    // 语义就是 `osascript ... keystroke`；审批门（原始+归一化双视图）判 high，
    // 而让出护栏此前只看原始文本 → 阈值置顶也照跑（实测过）。
    const r = await runBash("echo 'osascript to key'stroke v", ALWAYS_ACTIVE_MS)
    assert.equal(r.isError, true, '审批门认它是注入，让出护栏必须同样认')
    assert.match(r.content, /让出/)
  },
)

test('真实链路：阈值 0（护栏关闭）→ 命中签名的命令照常执行', async () => {
  const r = await runBash(HAZARD, '0')
  assert.notEqual(r.isError, true)
  assert.match(r.content, /xdotool key ctrl\+v/)
})

test('真实链路：未命中签名 → 命令照常执行（零额外开销路径）', async () => {
  const r = await runBash(SAFE, ALWAYS_ACTIVE_MS)
  assert.notEqual(r.isError, true)
  assert.match(r.content, /plain-ok/)
})

// ── 执行期让出（issue #235 期望行为 1 的另一半 · 收编公开仓 PR #257）──────
//
// 上面五条测的是**执行前**判定。执行期那半边的接线同样只能靠真实链路证：
// 模块测试（bash-yield-watch.test.ts）证明判定函数对，删掉 bash.ts 里的接线
// 照样全绿——所以这里补"真实 bash 工具 + 真实接线"的两条。
//
// 「用户活跃」用注入探测造（`__setYieldWatchProbeForTests`，idle 恒 30ms ≡ 持续活跃）：
// clamp 不变量（有效间隔 ≥ 阈值，见 resolveYieldWatchMs 注释）落地后，旧的「阈值置顶
// 864000000 + watch=200」造法恰好是**被禁组合**——200 会被 clamp 到 864000000，探测
// 永不发生，用例等死。注入探测后这两条不再依赖真实 idle，darwin/linux 上确定
// （win32 跳过：命令是 POSIX 形态——/dev/null 与 sleep，壳族不定）。
// `approvalGrantedAt` 让执行前判定走豁免窗放行，这样测到的只可能是执行期这一段。

/** 命中「纯前台抢占」签名（SetForegroundWindow），但真跑也无害——护栏失效时不伤本机。 */
const FOREGROUND_ONLY_LONG = 'echo "SetForegroundWindow(" >/dev/null; sleep 5'
/** 命中「合成键鼠」签名（SendInput）——执行期监控必须排除它（自身注入污染 idle）。 */
const INPUT_SYNTHESIS_LONG = 'echo "SendInput(" >/dev/null; sleep 3'

/** idle 恒 30ms < 阈值 ≡ 用户持续活跃。 */
const ACTIVE_PROBE = async () => 30

test(
  '真实链路·执行期：命中纯前台签名 + 用户活跃 → 命令跑到一半被终止',
  { skip: process.platform === 'win32' ? 'POSIX-shaped payload (>/dev/null, sleep); shell family varies on win32' : false },
  async () => {
    __setYieldWatchProbeForTests(ACTIVE_PROBE)
    try {
      const t0 = Date.now()
      // watch=500 < 阈值 1200 → clamp 到 1200：终止不得早于阈值（批准点击保护的接线级
      // 证据——无 clamp 的旧实现 ~500ms 即杀），但必须远早于命令本体的 5s。
      const r = await runBash(FOREGROUND_ONLY_LONG, '1200', { approvalGrantedAt: Date.now() }, '500')
      const ms = Date.now() - t0
      assert.equal(r.isError, true, '护栏终止必须让模型看见（isError），否则会被当成执行成功')
      assert.match(r.content, /\[让出·执行中\]/)
      assert.match(r.content, /不会自动回滚/, '命令已跑过一部分的事实必须说清')
      assert.ok(ms >= 1_000, `clamp 后有效间隔 ≥ 阈值 1200ms，不得更早终止（b5bfe8100 复审回归钉）；实耗 ${ms}ms`)
      assert.ok(ms < 4_000, `应在首个探测点被终止；命令本体 sleep 5s，实耗 ${ms}ms`)
    } finally {
      __setYieldWatchProbeForTests(undefined)
    }
  },
)

test(
  '真实链路·执行期：合成键鼠类命令不启用监控（自身注入污染 idle，启用即误杀）',
  { skip: process.platform === 'win32' ? 'POSIX-shaped payload (>/dev/null, sleep); shell family varies on win32' : false },
  async () => {
    // 反证条件与上一条同配置：若 shouldWatchExecution 回落到整张 AVAILABILITY_HAZARD_PATTERNS，
    // 监控会在 ~1.2s（clamp 后）终止命令，下面三条断言齐红。
    __setYieldWatchProbeForTests(ACTIVE_PROBE)
    try {
      const t0 = Date.now()
      const r = await runBash(INPUT_SYNTHESIS_LONG, '1200', { approvalGrantedAt: Date.now() }, '500')
      const ms = Date.now() - t0
      assert.notEqual(r.isError, true, '命令应正常跑完，不得被执行期监控终止')
      assert.match(r.content, /exit=0/)
      assert.ok(ms >= 2_500, `必须跑满（监控不该对自身注入的命令启用），实耗 ${ms}ms`)
    } finally {
      __setYieldWatchProbeForTests(undefined)
    }
  },
)

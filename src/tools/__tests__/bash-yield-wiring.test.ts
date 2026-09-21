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
import { BASH_TOOL } from '../bash.js'

/** 命中注入签名（xdotool）但真执行也无害——护栏失效时不会伤到本机。 */
const HAZARD = 'echo "xdotool key ctrl+v"'
const SAFE = 'echo plain-ok'

type BashParams = Parameters<typeof BASH_TOOL.execute>[0]

async function runBash(command: string, yieldMs: string, extra: Partial<BashParams> = {}) {
  const prev = process.env.RIVET_CU_YIELD_MS
  process.env.RIVET_CU_YIELD_MS = yieldMs
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
  }
}

test(
  '真实链路：命中签名 + 用户活跃（阈值置顶）→ 命令不执行，返回让出文案',
  { skip: process.platform !== 'darwin' ? 'real probe only returns a number on darwin' : false },
  async () => {
    const r = await runBash(HAZARD, '999999')
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
    const r = await runBash(HAZARD, '999999', { approvalGrantedAt: Date.now() })
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
    const r = await runBash("echo 'osascript to key'stroke v", '999999')
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
  const r = await runBash(SAFE, '999999')
  assert.notEqual(r.isError, true)
  assert.match(r.content, /plain-ok/)
})

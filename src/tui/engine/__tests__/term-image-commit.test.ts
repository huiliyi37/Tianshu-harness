/**
 * app 级集成测试 — commitUserPrompt 的带图异步提交路径 + 统一 main commit 队列。
 *
 * 覆盖的回归面（纯编码层单测无法触及）：
 * - 顺序：慢转码不得让图片/后续提交越过所属气泡；连续两次提交不得倒序；
 *   overlay 激活时带图提交在调用当刻预订队列位置，回放不被后排 commit 越过
 * - 队列：唯一有序 main commit 队列（enqueueMainCommit + 单实例 pump）——
 *   async barrier 后同步项严格 FIFO；pump await 期间 overlay 重激活不写主屏内容
 *   进 alt screen；prepare 完成后重新检查 overlay；单条目异常不丢剩余队列
 * - 异常：prepare 抛错/拒绝必须静默降级为纯文本气泡，无 unhandled rejection
 * - resize：转码期间终端宽度变化，编码必须用写入当刻的最新列数
 * - 混排：带图提交还在转码时，无图提交也必须排队尾，气泡不倒序
 * - worker 视图：steer 回调在气泡+图片落地之后才调用
 * - 回调异常：onSubmitCallback 抛错不产生 unhandled rejection
 * - 规范化：超量/非法图片在入口过滤，气泡与回调看到同一份数组
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImageProtocol } from '../ansi.js'
import { setTermImagePreparer } from '../term-image.js'
import { makeApp } from './_harness.js'

const tick = (ms = 50) => new Promise<void>(r => setTimeout(r, ms))

function withImageEnv(protocol: 'kitty' | 'iterm2' | 'none', fn: () => Promise<void>): Promise<void> {
  setImageProtocol(protocol)
  return fn().finally(() => {
    setImageProtocol(null)
    setTermImagePreparer(null)
  })
}

test('慢转码的带图提交与后续提交保持顺序——气泡+图片原子有序，连续提交不倒序', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    // 第一张图慢（手动释放），第二张立即就绪
    let releaseSlow!: () => void
    const slow = new Promise<void>(r => { releaseSlow = r })
    setTermImagePreparer(async (dataUrl) => {
      if (dataUrl.endsWith('slow')) await slow
      return { b64: dataUrl.endsWith('slow') ? 'U0xPVw==' : 'RkFTVA==' }
    })

    app.submitText('first', ['data:image/png;base64,slow'])
    app.submitText('second', ['data:image/png;base64,fast'])
    await tick(20)
    releaseSlow()
    await tick()

    const joined = out.chunks.join('')
    const iFirst = joined.indexOf('first')
    const iSlow = joined.indexOf('U0xPVw==')
    const iSecond = joined.indexOf('second')
    const iFast = joined.indexOf('RkFTVA==')
    assert.ok(iFirst !== -1, 'first 气泡已写出')
    assert.ok(iSlow !== -1, '第一张图片序列已写出')
    assert.ok(iSecond !== -1, 'second 气泡已写出')
    assert.ok(iFast !== -1, '第二张图片序列已写出')
    assert.ok(iFirst < iSlow, '图片在所属气泡之后')
    assert.ok(iSlow < iSecond, '慢转码的第一次提交不被第二次越过')
    assert.ok(iSecond < iFast, '第二张图片在 second 气泡之后')
  })
})

test('prepare 抛错静默降级为纯文本气泡，无 unhandled rejection', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      setTermImagePreparer(async () => { throw new Error('converter exploded') })
      app.submitText('boom', ['data:image/jpeg;base64,/9j/4AA='])
      await tick()
      const joined = out.chunks.join('')
      assert.ok(joined.includes('boom'), '气泡仍写出')
      assert.ok(joined.includes('📎 1 image attached'), '保留文本占位')
      await tick(20)
      assert.deepEqual(rejections, [], '不得产生 unhandled rejection')
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }
  })
})

test('转码期间 resize，编码用写入当刻的最新列数', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'QUJD' }
    })
    app.submitText('resize-me', ['data:image/png;base64,QUJD'])
    await tick(20)
    // 转码未完成时终端缩窄（真实路径经 resize watcher 更新 app.columns）
    ;(app as unknown as { columns: number }).columns = 60
    release()
    await tick()
    const joined = out.chunks.join('')
    assert.ok(joined.includes('width=56'), `应用最新宽度 60-4=56，实际输出: ${joined.slice(-400)}`)
    assert.ok(!joined.includes('width=76'), '不得使用提交时的过期宽度')
  })
})

test('协议 none：带图提交同步完成（无异步链）', async () => {
  await withImageEnv('none', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.submitText('plain', ['data:image/png;base64,QUJD'])
    // 不等任何 tick：同步路径必须已经写出气泡
    assert.ok(out.chunks.join('').includes('plain'))
  })
})

test('慢带图提交后立即无图提交，无图排链尾、气泡不倒序', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'SU1H' }
    })

    app.submitText('img-first', ['data:image/png;base64,QUJD'])
    app.submitText('plain-second') // 无图：链上有 pending，必须排在带图提交之后
    await tick(20)
    release()
    await tick()

    const joined = out.chunks.join('')
    const iFirst = joined.indexOf('img-first')
    const iImg = joined.indexOf('SU1H')
    const iSecond = joined.indexOf('plain-second')
    assert.ok(iFirst !== -1 && iImg !== -1 && iSecond !== -1, '两个气泡与图片都已写出')
    assert.ok(iFirst < iImg, '图片在所属气泡之后')
    assert.ok(iImg < iSecond, '无图提交不得越过还在转码的带图提交')
  })
})

test('worker 视图 steer 在气泡+图片落地之后才调用', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'SU1H' }
    })
    const steerCalls: Array<{ id: string; text: string; bubbleVisible: boolean }> = []
    app.setWorkerSteer((id, text) => {
      steerCalls.push({ id, text, bubbleVisible: out.chunks.join('').includes('hello worker') })
      return true
    })
    app.enterWorkerView('w-1')

    const submit = (app as unknown as {
      handleInputSubmit(t: string, images?: string[]): Promise<void>
    }).handleInputSubmit('hello worker', ['data:image/png;base64,QUJD'])
    await tick(20)
    assert.equal(steerCalls.length, 0, '带图提交未落地前不得 steer（worker 输出会先于用户气泡）')
    release()
    await submit
    assert.equal(steerCalls.length, 1, 'steer 被调用一次')
    assert.equal(steerCalls[0]!.id, 'w-1')
    assert.equal(steerCalls[0]!.text, 'hello worker')
    assert.ok(steerCalls[0]!.bubbleVisible, 'steer 时用户气泡已落 scrollback')
  })
})

test('prepare 成功但 onSubmitCallback 抛错，无 unhandled rejection', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      setTermImagePreparer(async () => ({ b64: 'SU1H' }))
      app.onSubmit(() => { throw new Error('callback exploded') })
      app.submitText('cb-boom', ['data:image/png;base64,QUJD'])
      await tick()
      assert.ok(out.chunks.join('').includes('cb-boom'), '气泡仍写出')
      await tick(20)
      assert.deepEqual(rejections, [], 'start 回调异常不得成为 unhandled rejection')
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }
  })
})

test('入口规范化——超量/非法图片被过滤，气泡与回调看到同一份数组', async () => {
  await withImageEnv('none', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    let got: string[] | undefined
    app.onSubmit((_t, images) => { got = images })
    const images = [
      'data:image/png;base64,QUJD',
      'data:image/png;base64,QUJF',
      'data:image/png;base64,QUJG',
      'data:image/png;base64,QUJH',
      'data:image/png;base64,!!!!', // 非法 base64 → 过滤
      'data:image/png;base64,QUJJ', // 第 5 张合法 → 超 MAX_IMAGES 截断
    ]
    app.submitText('multi', images)
    assert.ok(out.chunks.join('').includes('📎 4 images attached'), '气泡写 4 images')
    assert.deepEqual(got, images.slice(0, 4), 'onSubmitCallback 收到同一规范化数组')
  })
})

test('视觉模型支持的 TIFF/BMP 附件不会被 inline MIME 过滤丢弃', async () => {
  await withImageEnv('none', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    const images = [
      'data:image/tiff;base64,QUJD',
      'data:image/bmp;base64,QUJF',
    ]
    let callbackImages: string[] | undefined
    app.onSubmit((_text, submitted) => { callbackImages = submitted })
    app.submitText('legacy-formats', images)
    assert.deepEqual(callbackImages, images, '回调保留视觉服务支持的 TIFF/BMP data URL')
    assert.ok(out.chunks.join('').includes('📎 2 images attached'), '终端不 inline 时保留文本占位')
  })
})

test('overlay 激活期间带图提交用占位项预订逻辑位，回放不被后排 commit 越过', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'SU1HR0VE' }
    })

    app.activateOverlay('choice-panel')
    app.commitStatic('ASSISTANT_BEFORE')   // 预排的 assistant commit
    app.submitText('img-msg', ['data:image/png;base64,QUJD']) // 慢转码带图提交
    app.commitStatic('ASSISTANT_AFTER')    // prepare 期间后排的 assistant commit
    release()
    await tick()
    assert.ok(
      !out.chunks.join('').includes('ASSISTANT_BEFORE'),
      'overlay 激活期间主屏 commit 仍排队（含已兑现的占位项）',
    )

    out.clear()
    app.deactivateOverlay()
    await tick()
    const text = out.chunks.join('')
    const iBefore = text.indexOf('ASSISTANT_BEFORE')
    const iBubble = text.indexOf('img-msg')
    const iImg = text.indexOf('SU1HR0VE')
    const iAfter = text.indexOf('ASSISTANT_AFTER')
    assert.ok(iBefore !== -1 && iBubble !== -1 && iImg !== -1 && iAfter !== -1, '回放内容完整')
    assert.ok(iBefore < iBubble, '预排 assistant commit 先于用户气泡')
    assert.ok(iBubble < iImg, '图片在所属气泡之后')
    assert.ok(iImg < iAfter, '占位项保证图片提交不被 prepare 期间后排的 commit 越过')
  })
})

// ── 统一 main commit 队列回归 ─────────────────────────────

test('overlay 退出回放已就绪的带图提交：clear→write→render 连续，中间无 live 帧', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'UkVBRFk=' }
    })

    app.activateOverlay('choice-panel')
    app.submitText('ready-bubble', ['data:image/png;base64,QUJD'])
    release()
    await tick() // prepare 完成时 overlay 仍激活——队列保留，一个字节都不写
    assert.ok(!out.chunks.join('').includes('ready-bubble'), 'overlay 激活期间不得写主屏')

    out.clear()
    app.deactivateOverlay()
    await tick()

    const chunks = out.chunks
    const bubbleIdx = chunks.findIndex(c => c.includes('ready-bubble'))
    assert.ok(bubbleIdx > 0, '退出 overlay 后气泡落 scrollback')
    // 原子提交窗口：擦除 live region（ERASE_SCREEN_END）与气泡必须相邻，
    // 中间不得夹 live 帧（❯）——否则原子窗口被掏空。
    assert.ok(
      chunks[bubbleIdx - 1]!.includes('\x1B[0J'),
      '擦除与气泡相邻——原子窗口内无 live 帧插入',
    )
    const renderIdx = chunks.findIndex((c, i) => i > bubbleIdx && c.includes('❯'))
    assert.ok(renderIdx > bubbleIdx, '写入之后重绘 live region')
  })
})

test('慢 prepare 未完成时退出 overlay：prepare 完成后原子写入主屏', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'U0xPV0lNRw==' }
    })

    app.activateOverlay('choice-panel')
    app.submitText('slow-bubble', ['data:image/png;base64,QUJD'])
    app.deactivateOverlay()
    await tick()
    assert.ok(
      !out.chunks.join('').includes('slow-bubble'),
      'prepare 未完成：退出 overlay 也不得先擦后等',
    )

    release()
    await tick()
    const joined = out.chunks.join('')
    assert.ok(joined.includes('slow-bubble'), 'prepare 完成后气泡落 scrollback')
    assert.ok(joined.includes('U0xPV0lNRw=='), '图片序列随之写出')
    assert.ok(
      joined.indexOf('\x1B[?1049l') < joined.indexOf('slow-bubble'),
      '写入发生在退出 alt screen 之后',
    )
    // 原子性：气泡前一 chunk 是擦除（clear→write 连续）
    const chunks = out.chunks
    const bubbleIdx = chunks.findIndex(c => c.includes('slow-bubble'))
    assert.ok(chunks[bubbleIdx - 1]!.includes('\x1B[0J'), 'prepare 完成后仍是原子提交窗口')
  })
})

test('pump await 期间 overlay 重激活：ALT_SCREEN_ON→OFF 之间无气泡/图片字节', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'TEFURQ==' }
    })

    // 主屏提交慢图：pump 启动并停在 await ready 上
    app.submitText('late-bubble', ['data:image/png;base64,QUJD'])
    await tick(20)
    // pump 等待期间打开 overlay，随后 prepare 完成——pump 唤醒必须看到
    // overlay 激活并保留队首退出，而不是把主屏内容写进 alt screen。
    app.activateOverlay('choice-panel')
    release()
    await tick()
    assert.ok(!out.chunks.join('').includes('late-bubble'), 'overlay 激活期间气泡不得写入')
    assert.ok(!out.chunks.join('').includes('TEFURQ=='), '图片序列不得写进 alt screen')

    app.deactivateOverlay()
    await tick()
    const full = out.chunks.join('')
    const iOn = full.indexOf('\x1B[?1049h')
    const iOff = full.indexOf('\x1B[?1049l', iOn)
    assert.ok(iOn !== -1 && iOff !== -1, 'alt screen 进出序列完整')
    const between = full.slice(iOn, iOff)
    assert.ok(!between.includes('late-bubble') && !between.includes('TEFURQ=='), 'alt screen 内零主屏字节')
    assert.ok(full.indexOf('late-bubble') > iOff, '退出 alt screen 后泵出气泡')
    assert.ok(full.indexOf('TEFURQ==') > full.indexOf('late-bubble'), '图片在所属气泡之后')
  })
})

test('主屏 prepare 期间开 overlay 再提交第二条：回放顺序不倒', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    let release1!: () => void
    let release2!: () => void
    const gate1 = new Promise<void>(r => { release1 = r })
    const gate2 = new Promise<void>(r => { release2 = r })
    setTermImagePreparer(async (dataUrl) => {
      if (dataUrl.endsWith('b25l')) { await gate1; return { b64: 'SU1HXzE=' } }
      await gate2
      return { b64: 'SU1HXzI=' }
    })

    // 第一条在主屏 prepare（pump await 中）；期间打开 overlay 并提交第二条。
    // 旧实现第一条 prepare 完成后会直写主屏、越过第二条的占位 → 物理倒序。
    app.submitText('img-one', ['data:image/png;base64,b25l'])
    await tick(20)
    app.activateOverlay('choice-panel')
    app.submitText('img-two', ['data:image/png;base64,dHdv'])
    // 第二条先 ready、第一条后 ready（overlay 仍激活）——队列位置在调用当刻
    // 已预订，ready 早晚不影响物理顺序。
    release2()
    await tick(20)
    release1()
    await tick(20)
    assert.ok(!out.chunks.join('').includes('img-one'), 'overlay 激活期间不得写主屏')

    app.deactivateOverlay()
    await tick()
    const joined = out.chunks.join('')
    const iOne = joined.indexOf('img-one')
    const iImg1 = joined.indexOf('SU1HXzE=')
    const iTwo = joined.indexOf('img-two')
    const iImg2 = joined.indexOf('SU1HXzI=')
    assert.ok(iOne !== -1 && iImg1 !== -1 && iTwo !== -1 && iImg2 !== -1, '回放内容完整')
    assert.ok(iOne < iImg1, '第一张图片在所属气泡之后')
    assert.ok(iImg1 < iTwo, '第一条提交不被第二条越过（调用顺序即物理顺序）')
    assert.ok(iTwo < iImg2, '第二张图片在所属气泡之后')
  })
})

test('一轮 pump 等待期间第二轮 overlay 退出：只有一个 pump 实例、队列不倒序', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'TVVURVg=' }
    })

    app.activateOverlay('choice-panel')
    app.commitStatic('SYNC_A')
    app.submitText('mutex-bubble', ['data:image/png;base64,QUJD'])
    // 第一次退出：pump 同步排空 SYNC_A 后停在图片的 await ready 上
    app.deactivateOverlay()
    await tick(20)
    // pump 等待期间再开/再退一轮 overlay 并排队 SYNC_B——requestPump 必须
    // 识别已有 pump 实例而不并发启动第二个（否则两条泵交错回放、重复擦写）。
    app.activateOverlay('choice-panel')
    app.commitStatic('SYNC_B')
    app.deactivateOverlay()
    await tick(20)
    release()
    await tick()

    const joined = out.chunks.join('')
    const count = (s: string) => app.getScrollbackContent().split(s).length - 1
    assert.equal(count('SYNC_A'), 1, 'SYNC_A 恰好写一次')
    assert.equal(count('SYNC_B'), 1, 'SYNC_B 恰好写一次（无并发 pump 重复回放）')
    assert.equal(app.getScrollbackContent().split('mutex-bubble').length - 1, 1, '真实 scrollback 气泡恰好写一次')
    const iA = joined.indexOf('SYNC_A')
    const iBubble = joined.indexOf('mutex-bubble')
    const iImg = joined.indexOf('TVVURVg=')
    const iB = joined.indexOf('SYNC_B')
    assert.ok(iA < iBubble && iBubble < iImg && iImg < iB, 'FIFO：SYNC_A → 气泡+图片 → SYNC_B')
  })
})

test('deferred write 抛错：无 unhandledRejection，后续同步 commit 仍执行', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      app.activateOverlay('choice-panel')
      // 直接注入一个 ready 会兑现「抛错写闭包」的条目（等价旧 deferred slot
      // 兑现后 write 抛出的形态）；后面再排一个正常同步 commit。
      const pending = (app as unknown as {
        enqueueMainCommit(ready: Promise<() => void>): Promise<void> | null
      }).enqueueMainCommit(Promise.resolve(() => { throw new Error('write exploded') }))
      app.commitStatic('AFTER_THROW')
      app.deactivateOverlay()
      await tick()
      assert.ok(pending, '异步条目返回完成 Promise')
      await pending
      assert.ok(out.chunks.join('').includes('AFTER_THROW'), '单条目异常不丢剩余队列')
      await tick(20)
      assert.deepEqual(rejections, [], '写闭包抛错不得成为 unhandled rejection')
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }
  })
})

test('队列空闲时 commitStatic 仍在返回前完成（同步 fast path）', () => {
  const { app, out } = makeApp({ cols: 80, rows: 24 })
  app.commitStatic('SYNC_STATIC')
  assert.ok(out.chunks.join('').includes('SYNC_STATIC'), '返回前已落 scrollback（零 tick）')
})

test('async barrier 后的同步 commit 严格排队、不越过 barrier', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'QkFSUklFUg==' }
    })

    app.submitText('barrier-bubble', ['data:image/png;base64,QUJD'])
    app.commitStatic('SYNC_AFTER')
    await tick(20)
    // barrier（带图 prepare）未完成：同步 commit 不得直写越过——这是设计意图
    // 的行为变化（统一队列的代价）：严格 FIFO 优先于同步直写。
    assert.ok(!out.chunks.join('').includes('SYNC_AFTER'), 'barrier 未完成时同步项不得越过')
    release()
    await tick()
    const joined = out.chunks.join('')
    const iBubble = joined.indexOf('barrier-bubble')
    const iImg = joined.indexOf('QkFSUklFUg==')
    const iAfter = joined.indexOf('SYNC_AFTER')
    assert.ok(iBubble !== -1 && iImg !== -1 && iAfter !== -1, '全部内容最终写出')
    assert.ok(iBubble < iImg && iImg < iAfter, '同步项严格排在 barrier 之后')
  })
})

// ── 写入失败的显式 false 契约 ─────────────────────────────

/** 注入一次性写失败：commit.write 下一次调用抛错后自动恢复原实现。 */
function injectOneShotWriteFailure(app: unknown): void {
  const commit = (app as { commit: { write: (...args: never[]) => void } }).commit
  const origWrite = commit.write.bind(commit)
  let shouldThrow = true
  commit.write = ((...args: unknown[]) => {
    if (shouldThrow) {
      shouldThrow = false
      throw new Error('stdout broken')
    }
    return origWrite(...(args as never[]))
  }) as typeof commit.write
}

test('写入失败：完成 Promise resolve false（不 reject），后续队列条目不受影响', async () => {
  await withImageEnv('none', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      app.activateOverlay('choice-panel') // 强制走队列路径（必须返回 Promise）
      injectOneShotWriteFailure(app)
      const pending = (app as unknown as {
        commitUserPrompt(content: string): Promise<boolean> | null
      }).commitUserPrompt('fragile')
      assert.ok(pending, 'overlay 激活时 commitUserPrompt 透传完成 Promise')
      app.commitStatic('AFTER_BROKEN') // 排在失败条目之后
      app.deactivateOverlay() // pump 回放：第一条写抛错，第二条正常写出
      const written = await pending
      assert.equal(written, false, '写入抛错被跳过 → resolve false（不 reject）')
      assert.ok(out.chunks.join('').includes('AFTER_BROKEN'), '单条目失败不丢剩余队列')
      await tick(20)
      assert.deepEqual(rejections, [], '不得产生 unhandled rejection')
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }
  })
})

test('submitText 显示失败：警告落 scrollback、agent 仍启动、无 unhandledRejection', async () => {
  await withImageEnv('none', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      app.activateOverlay('choice-panel')
      injectOneShotWriteFailure(app)
      let started = false
      app.onSubmit(() => { started = true })
      app.submitText('fragile')
      await tick(20)
      assert.equal(started, false, '提交未落地前 agent 不得启动')
      app.deactivateOverlay() // pump 回放 → 写抛错 → pending resolve false
      await tick()
      assert.ok(started, '显示失败不阻塞 agent 启动')
      assert.ok(
        out.chunks.join('').includes('⚠ 用户消息显示失败'),
        '显示失败先 commitStatic 一条 muted 警告',
      )
      await tick(20)
      assert.deepEqual(rejections, [], '不得产生 unhandled rejection')
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }
  })
})

test('同步 fast path 写入失败：转为 false，仍启动 agent 并显示警告', async () => {
  await withImageEnv('none', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    injectOneShotWriteFailure(app)
    let started = false
    app.onSubmit(() => { started = true })
    app.submitText('sync fragile')
    await tick()
    assert.equal(started, true, '同步写失败不应阻止 agent 启动')
    assert.ok(out.chunks.join('').includes('⚠ 用户消息显示失败'), '同步写失败应显示警告')
  })
})

test('普通输入 handleInputSubmit awaitUserCommit=false：显示警告后仍执行后续提交动作', async () => {
  await withImageEnv('none', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      injectOneShotWriteFailure(app)
      let submitted = ''
      app.onSubmit((text) => { submitted = text })
      await (app as unknown as {
        handleInputSubmit(text: string, images?: string[]): Promise<void>
      }).handleInputSubmit('ordinary fragile')

      assert.equal(submitted, 'ordinary fragile', '显示失败后仍执行普通提交回调')
      assert.ok(out.chunks.join('').includes('⚠ 用户消息显示失败'), 'awaitUserCommit=false 应显示警告')
      await tick(20)
      assert.deepEqual(rejections, [], 'awaitUserCommit 失败不得产生 unhandled rejection')
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }
  })
})

// ── onSubmit 注册处的 async catch 收口 ─────────────────────

test('真实 Enter 按键链路 onSubmit 抛错：注册处 catch 收口为警告行，无 unhandledRejection', async () => {
  const { app, out, stdin } = makeApp({ cols: 80, rows: 24 })
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    app.onSubmit(() => { throw new Error('callback exploded') })
    for (const ch of 'zzthrow') stdin.dataHandler!(ch)
    stdin.dataHandler!('\r') // Enter → InputLine onSubmit → handleInputSubmit（async）
    await tick()
    const joined = out.chunks.join('')
    assert.ok(joined.includes('zzthrow'), '用户气泡已写 scrollback')
    assert.ok(joined.includes('⚠ 提交处理出错'), '回调异常被注册处 catch 收口为警告行')
    assert.ok(joined.includes('callback exploded'), '警告含原始错误信息')
    await tick(20)
    assert.deepEqual(rejections, [], 'async 回调异常不得成为 unhandled rejection')
  } finally {
    process.removeListener('unhandledRejection', onRejection)
  }
})

// ── 按协议显式定义的光标收尾字节 ───────────────────────────

test('iTerm2 图片序列收尾为 \\x07\\r\\n：光标在图片末行右缘，归列首并落到图片下方', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    setTermImagePreparer(async () => ({ b64: 'QUJD' }))
    app.submitText('img-iterm', ['data:image/png;base64,QUJD'])
    await tick()
    const chunk = out.chunks.find(c => c.includes('\x1B]1337;File='))
    assert.ok(chunk, 'iTerm2 序列已写出')
    assert.ok(
      chunk!.endsWith('\x07\r\n'),
      `序列收尾必须是 \\x07\\r\\n，实际: ${JSON.stringify(chunk!.slice(-8))}`,
    )
  })
})

test('kitty 图片序列收尾为 \\x1B\\\\\\r：光标已在图片下方 col c，仅归列首', async () => {
  await withImageEnv('kitty', async () => {
    const { app, out } = makeApp({ cols: 80, rows: 24 })
    setTermImagePreparer(async () => ({ b64: 'QUJD' }))
    app.submitText('img-kitty', ['data:image/png;base64,QUJD'])
    await tick()
    const chunk = out.chunks.find(c => c.includes('\x1B_G'))
    assert.ok(chunk, 'kitty 序列已写出')
    assert.ok(
      chunk!.endsWith('\x1B\\\r'),
      `序列收尾必须是 \\x1B\\\\\\r，实际: ${JSON.stringify(chunk!.slice(-8))}`,
    )
    assert.ok(!chunk!.endsWith('\n'), 'kitty 收尾不得带 \\n（光标已下移 r 行，补 \\n 会多一个空行）')
  })
})

// ── overlay 退出统一收口 ──────────────────────────────────

test('键盘 Esc 直连退出 overlay + 队列非空：回放走统一收口，恰好一帧 live、FIFO 不倒', async () => {
  const { app, out, stdin } = makeApp({ cols: 80, rows: 24 })
  app.registerOverlays({})
  app.activateOverlay('choice-panel') // activateOverlay 已置 escapeImmediate，裸 \x1B 即时派发
  app.commitStatic('QUEUED_X') // overlay 激活期间排队的主屏 commit
  assert.ok(!out.chunks.join('').includes('QUEUED_X'), 'overlay 激活期间不写主屏')

  stdin.dataHandler!('\x1B') // 真实 Esc 按键 → exitOverlayCore 统一收口
  await tick()

  const chunks = out.chunks
  assert.equal(app.getScrollbackContent().split('QUEUED_X').length - 1, 1, '排队 commit 恰好回放一次，视口预览不算新提交')
  const offIdx = chunks.findIndex(c => c.includes('\x1B[?1049l'))
  assert.ok(offIdx !== -1, 'alt screen 退出序列已写')
  assert.ok(
    chunks.findIndex(c => c.includes('QUEUED_X')) > offIdx,
    '退出 alt screen 之后才回放主屏 commit',
  )
  // 收口核心：suppress 窗口内回放只写 scrollback 不画 live 帧，退出后唯一一次
  // renderLive——无收口的旧直连路径会先 flushNow 画一帧再 renderLive 画一帧（叠影）。
  const liveFrames = chunks.slice(offIdx).filter(c => c.includes('❯'))
  assert.equal(liveFrames.length, 1, '回放后只有唯一 live 帧（无叠影）')
})

test('键盘 Esc 退出时 async ready 回放仍只产生一帧 live', async () => {
  await withImageEnv('iterm2', async () => {
    const { app, out, stdin } = makeApp({ cols: 80, rows: 24 })
    app.registerOverlays({})
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    setTermImagePreparer(async () => {
      await gate
      return { b64: 'RVND' }
    })
    app.activateOverlay('choice-panel')
    app.submitText('async-esc', ['data:image/png;base64,QUJD'])
    stdin.dataHandler!('\x1B')
    release()
    await tick()
    const chunks = out.chunks
    const offIdx = chunks.findIndex(c => c.includes('\x1B[?1049l'))
    assert.ok(offIdx !== -1, 'alt screen 已退出')
    const afterExit = chunks.slice(offIdx).join('')
    assert.ok(afterExit.includes('async-esc'), 'async commit 在退出后回放')
    assert.equal(app.getScrollbackContent().split('async-esc').length - 1, 1, '真实 scrollback 用户气泡只回放一次')
    assert.equal(afterExit.split('RVND').length - 1, 1, '图片序列只回放一次')
  })
})

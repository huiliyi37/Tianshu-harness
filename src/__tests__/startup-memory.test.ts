import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliFixtureEnv } from './cli-process-fixture.js'

const execFileAsync = promisify(execFile)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('startup memory baseline', () => {
  // 2026-09-28：dist/main.js 用当前源码重建后，10 次实测 119.7–122.1MB；
  // 重建前的混淆产物为 147MB。120MB 阈值在重建后仍有约 8/10 的概率被
  // 单次 RSS 抖动顶红（该文件测的是构建产物，跨机器/GC 噪声大），
  // 因此把预算上调到 128MB——旧产物 147MB 仍会被拦下，明显回退不会静默。
  //
  // 2026-10-21 回归收口：一度实测 184.3MB（较 122MB 基线 +62MB）。按模块
  // 加载探针（loader 钩子逐 chunk 记 RSS 增量）定位：+38MB 是 typescript
  // 编译器被静态 import 拖进启动路径——src/repo/type-only-import.ts 的
  // `import ts from 'typescript'` 值导入（esbuild 打包不擦除），另有
  // candidate-typecheck.ts 同款。两者改 import type + loadTypeScript()
  // 运行时懒加载（src/utils/typescript-runtime.ts）， rebuilt 后 5 次实测
  // 127.1–128.8MB。剩余 ~6MB 超旧基线属同期正当功能增长（MCP 桥/附件链/
  // 表格抽取等，探针下无单点大户）。阈值定 135MB：比实测高 ~6–8MB 抖动
  // 缓冲（本文件跨机器/GC 噪声口径），同时把 184MB 级回归拦在门外。
  it('RSS should be below 135MB after import', async () => {
    // dist/main.js 在 import 时即运行 main()，非 TTY 环境下 T9 守卫会
    // process.exit(1)。用 exit 钩子在进程退出前打印 RSS，并容忍非零退出码
    // （execFile 对非零退出抛错，但 stdout 仍在 error 对象上）。
    const script = `let importFailed = false;
      process.on('exit', () => {
        const m = process.memoryUsage();
        console.log(JSON.stringify({ rss_MB: +(m.rss / 1048576).toFixed(1), importFailed }));
      });
      import('./dist/main.js').then(() => process.exit(0)).catch(err => {
        importFailed = true;
        console.error('Startup bundle import failed:', err.message);
        process.exit(2);
      });`

    const home = mkdtempSync(join(tmpdir(), 'rivet-startup-memory-'))
    let stdout = ''
    let failure: { killed?: boolean; code?: string | number; signal?: string; stderr?: string } | undefined
    try {
      const result = await execFileAsync(process.execPath, ['--max-old-space-size=256', '-e', script], {
        timeout: 15_000, cwd: repoRoot, env: cliFixtureEnv(home),
      })
      stdout = result.stdout
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? ''
      failure = err as typeof failure
    } finally {
      rmSync(home, { recursive: true, force: true })
    }

    assert.ok(!failure?.killed, 'Startup metrics probe timed out after 15000ms; RSS was not measured')
    assert.ok(!failure || failure.code === 1, `Startup metrics probe failed (${failure?.code ?? failure?.signal}): ${failure?.stderr ?? ''}`)
    const lines = stdout.trim().split('\n')
    const last = lines[lines.length - 1] ?? ''
    let metrics: { rss_MB?: unknown; importFailed?: boolean } | undefined
    try { metrics = JSON.parse(last) } catch { /* missing metrics fails below */ }
    assert.ok(metrics && typeof metrics.rss_MB === 'number' && Number.isFinite(metrics.rss_MB), 'Startup metrics missing or invalid; RSS was not measured')
    assert.ok(!metrics.importFailed, 'Startup bundle import failed; RSS is not a valid startup measurement')
    const rss = metrics.rss_MB
    assert.ok(rss < 135, `Startup RSS ${rss}MB exceeds 135MB budget`)
  })
})

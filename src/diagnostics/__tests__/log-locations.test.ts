import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveLogLocations,
  statLogLocations,
  formatLogLocationReport,
  latestSessionId,
  type LogLocation,
} from '../log-locations.js'

/** 只改这两个变量，其余环境保持原样——避免污染并发测试。 */
const ENV_KEYS = ['RIVET_HOME', 'RIVET_SESSION_DIR', 'RIVET_DESKTOP_DIR'] as const
const saved: Record<string, string | undefined> = {}
const dirs: string[] = []

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'rivet-logloc-home-'))
  dirs.push(d)
  return d
}

function tempCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'rivet-logloc-proj-'))
  dirs.push(d)
  return d
}

function byId(locations: readonly LogLocation[], id: string): LogLocation {
  const hit = locations.find(l => l.id === id)
  assert.ok(hit, `报告里缺少 ${id}——入口少一条用户就得回去翻源码`)
  return hit
}

describe('日志落点解析：数据根', () => {
  it('RIVET_HOME 生效时所有落点都挂在它下面，且来源被如实标注', () => {
    const home = tempHome()
    process.env['RIVET_HOME'] = home
    const cwd = tempCwd()

    const report = resolveLogLocations({ cwd, sessionId: 'sess-1' })

    assert.equal(report.rivetHome, home)
    assert.equal(report.homeSource, 'RIVET_HOME')
    // 项目内落点挂 cwd，其余一律挂 home——不允许出现第三个根。
    for (const loc of report.locations) {
      // 前缀判据必须用平台分隔符：Windows 上 home/cwd 是反斜杠形态，
      // 拼接 '/' 会让 in-home 的路径被判成「落在之外」的假红。
      const underHome = loc.path === home || loc.path.startsWith(home + sep)
      const underCwd = loc.path === cwd || loc.path.startsWith(cwd + sep)
      assert.ok(underHome || underCwd, `${loc.id} 落在 home/cwd 之外: ${loc.path}`)
    }
  })

  it('未设 RIVET_HOME 时标注为平台默认', () => {
    delete process.env['RIVET_HOME']
    const report = resolveLogLocations({ cwd: tempCwd() })
    assert.equal(report.homeSource, 'platform-default')
  })

  it('slug 由 cwd 派生，且报告里同时给出会话目录', () => {
    const home = tempHome()
    process.env['RIVET_HOME'] = home
    const cwd = tempCwd()

    const report = resolveLogLocations({ cwd })

    assert.match(report.projectSlug, /-[0-9a-f]{6}$/, 'slug 必须带 cwd 哈希后缀，否则同名项目会撞车')
    assert.equal(report.sessionDir, join(home, 'sessions', report.projectSlug))
  })

  it('RIVET_SESSION_DIR 这类分域覆盖必须被显式报告——否则用户找不到自己搬去了哪', () => {
    const home = tempHome()
    const altSessions = tempHome()
    process.env['RIVET_HOME'] = home
    process.env['RIVET_SESSION_DIR'] = altSessions

    const report = resolveLogLocations({ cwd: tempCwd(), sessionId: 'sess-1' })

    const hit = report.overrides.find(o => o.env === 'RIVET_SESSION_DIR')
    assert.ok(hit, '生效中的分域覆盖没被报告出来')
    assert.equal(hit.value, altSessions)
    // 覆盖生效时会话树整体搬走，且绕过 slug 分层。
    assert.equal(report.sessionDir, altSessions)
  })
})

describe('日志落点解析：六维遥测的双写缺口', () => {
  it('有 sessionId 时六维与认知帧落会话子目录', () => {
    const home = tempHome()
    process.env['RIVET_HOME'] = home
    const cwd = tempCwd()

    const report = resolveLogLocations({ cwd, sessionId: 'sess-9' })
    const expectDir = join(home, 'sessions', report.projectSlug, 'sess-9')

    assert.equal(byId(report.locations, 'sensorium').path, join(expectDir, 'sensorium.jsonl'))
    assert.equal(byId(report.locations, 'frames').path, join(expectDir, 'frames.jsonl'))
    assert.equal(byId(report.locations, 'cache-log').path, join(expectDir, 'cache-log.jsonl'))
  })

  it('无 sessionId 时六维回退到项目内 .rivet/ —— 这条回退路径实测仍在活跃，必须报出来', () => {
    const home = tempHome()
    process.env['RIVET_HOME'] = home
    const cwd = tempCwd()

    const report = resolveLogLocations({ cwd })

    assert.equal(byId(report.locations, 'sensorium').path, join(cwd, '.rivet', 'sensorium.jsonl'))
    assert.equal(byId(report.locations, 'frames').path, join(cwd, '.rivet', 'frames.jsonl'))
  })

  it('六维与帧必须标出各自的门控变量，否则用户不知道为什么文件是空的', () => {
    const report = resolveLogLocations({ cwd: tempCwd(), sessionId: 's' })
    assert.match(byId(report.locations, 'sensorium').gate ?? '', /RIVET_DEBUG_TELEMETRY/)
    assert.match(byId(report.locations, 'frames').gate ?? '', /RIVET_FRAME_TELEMETRY|RIVET_TELEMETRY_LITE/)
  })
})

describe('日志落点解析：桌面端第一现场', () => {
  it('必须报出 sidecar 日志目录与退出面包屑 —— 这是 GUI 启动失败唯一线索', () => {
    const home = tempHome()
    process.env['RIVET_HOME'] = home

    const report = resolveLogLocations({ cwd: tempCwd() })

    assert.equal(byId(report.locations, 'sidecar-logs').path, join(home, 'logs'))
    assert.equal(byId(report.locations, 'sidecar-exit').path, join(home, 'desktop', 'sidecar-exit.json'))
    assert.equal(byId(report.locations, 'desktop-sessions').path, join(home, 'desktop', 'sessions'))
  })

  it('RIVET_DESKTOP_DIR 覆盖时桌面落点跟着搬', () => {
    const home = tempHome()
    const altDesktop = tempHome()
    process.env['RIVET_HOME'] = home
    process.env['RIVET_DESKTOP_DIR'] = altDesktop

    const report = resolveLogLocations({ cwd: tempCwd() })

    assert.equal(byId(report.locations, 'sidecar-exit').path, join(altDesktop, 'sidecar-exit.json'))
    assert.ok(report.overrides.some(o => o.env === 'RIVET_DESKTOP_DIR'))
  })
})

describe('落点状态探测', () => {
  it('文件报字节数，目录报条目数，缺失的如实报 exists:false', () => {
    const home = tempHome()
    process.env['RIVET_HOME'] = home
    const cwd = tempCwd()
    const sessionId = 'sess-stat'

    // 造一个真实的会话子目录：一个有内容的 cache-log，一个空 logs 目录。
    const sdir = join(home, 'sessions', resolveLogLocations({ cwd }).projectSlug, sessionId)
    mkdirSync(sdir, { recursive: true })
    writeFileSync(join(sdir, 'cache-log.jsonl'), '{"a":1}\n', 'utf-8')
    mkdirSync(join(home, 'logs'), { recursive: true })
    writeFileSync(join(home, 'logs', 'sidecar-x.log'), 'boot\n', 'utf-8')

    const report = resolveLogLocations({ cwd, sessionId })
    const statuses = statLogLocations(report.locations)
    const find = (id: string) => {
      const hit = statuses.find(s => s.id === id)
      assert.ok(hit, `缺 ${id}`)
      return hit
    }

    const cache = find('cache-log')
    assert.equal(cache.exists, true)
    assert.equal(cache.bytes, 8)

    const logs = find('sidecar-logs')
    assert.equal(logs.exists, true)
    assert.equal(logs.entries, 1, '目录要报条目数，用户才知道有没有日志可看')

    assert.equal(find('sensorium').exists, false, '不存在就如实说不存在，不能凭路径假装有')
  })

  it('探测不得因权限或缺失而抛错 —— 排查工具自己崩了最没用', () => {
    process.env['RIVET_HOME'] = join(tmpdir(), 'rivet-does-not-exist-' + Date.now())
    const report = resolveLogLocations({ cwd: tempCwd() })
    assert.doesNotThrow(() => statLogLocations(report.locations))
  })
})

describe('最近会话兜底', () => {
  it('按 mtime 挑最新的 transcript，而不是字典序 —— 会话 id 不是时序的', () => {
    const dir = tempHome()
    // 字典序最小但最新：若实现按名字排序就会挑错。
    writeFileSync(join(dir, 'zzz-old.jsonl'), 'x\n', 'utf-8')
    writeFileSync(join(dir, 'aaa-new.jsonl'), 'x\n', 'utf-8')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'zzz-old.jsonl'), past, past)

    assert.equal(latestSessionId(dir), 'aaa-new')
  })

  it('跳过 worker 子会话 —— 它们与主会话共用目录且常常是最后写入的', () => {
    const dir = tempHome()
    writeFileSync(join(dir, 'main-sess.jsonl'), 'x\n', 'utf-8')
    // worker 更新（派发结束晚于用户最后一句话），按 mtime 会赢。
    writeFileSync(join(dir, 'worker-wo_abc-12345.jsonl'), 'x\n', 'utf-8')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'main-sess.jsonl'), past, past)

    assert.equal(latestSessionId(dir), 'main-sess', '挑中 worker 会让用户看到子代理的落点而非自己的对话')
  })

  it('只有 worker 会话时返回 undefined，而不是硬塞一个子代理会话', () => {
    const dir = tempHome()
    writeFileSync(join(dir, 'worker-wo_only-999.jsonl'), 'x\n', 'utf-8')
    assert.equal(latestSessionId(dir), undefined)
  })

  it('不把 claims 日志误当成会话 transcript', () => {
    const dir = tempHome()
    writeFileSync(join(dir, 'sess-a.claims.jsonl'), 'x\n', 'utf-8')
    assert.equal(latestSessionId(dir), undefined, 'claims 不是会话主体，挑中它会导出一堆空落点')
  })

  it('目录不存在时返回 undefined 而不抛错', () => {
    assert.equal(latestSessionId(join(tmpdir(), 'rivet-nope-' + Date.now())), undefined)
  })
})

describe('文本渲染', () => {
  it('渲染结果含数据根、会话目录、存在标记与门控说明', () => {
    const home = tempHome()
    process.env['RIVET_HOME'] = home
    const cwd = tempCwd()
    const report = resolveLogLocations({ cwd, sessionId: 'sess-fmt' })

    const text = formatLogLocationReport(report, statLogLocations(report.locations))

    assert.ok(text.includes(home), '必须打印数据根的真实绝对路径')
    assert.ok(text.includes('sess-fmt'), '必须打印当前会话 id')
    assert.ok(text.includes('RIVET_DEBUG_TELEMETRY'), '必须把门控变量带出来')
    assert.ok(text.includes('sidecar'), '桌面排查线索不能只在源码里')
  })

  it('无会话 id 时也能渲染，并提示六维走的是项目内回退路径', () => {
    const report = resolveLogLocations({ cwd: tempCwd() })
    const text = formatLogLocationReport(report, statLogLocations(report.locations))
    assert.ok(text.includes('.rivet'), '回退落点必须出现在输出里')
  })
})

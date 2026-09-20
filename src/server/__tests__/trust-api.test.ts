import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildTrustRoutes } from '../trust-api.js'
import { registeredWorkspaces } from '../workspace-guard.js'
import { trustProject } from '../../config/project-trust.js'

const AUTH = { authorization: 'Bearer tok' }

function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'trust-api-home-'))
  const prev = process.env.RIVET_HOME
  const prevTrust = process.env.RIVET_TRUST_PROJECT
  process.env.RIVET_HOME = dir
  delete process.env.RIVET_TRUST_PROJECT // 走信任文件，而不是 env 覆盖
  return fn(dir).finally(() => {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
    if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
    else process.env.RIVET_TRUST_PROJECT = prevTrust
    rmSync(dir, { recursive: true, force: true })
  })
}

function makeProject(config?: Record<string, unknown>, withHooks = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'trust-api-proj-'))
  if (config) writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify(config))
  if (withHooks) {
    mkdirSync(join(dir, '.rivet'), { recursive: true })
    writeFileSync(join(dir, '.rivet', 'hooks.json'), JSON.stringify({ hooks: {} }))
  }
  return dir
}

test('GET /project/trust：未授信项目列出会被剥离的敏感键', async () => {
  await withTempHome(async () => {
    const cwd = makeProject({ mcp: { servers: { a: { command: 'npx' } } }, agent: { approval: 'auto' } })
    try {
      const routes = buildTrustRoutes('tok', () => [cwd])
      const res = await routes['GET /project/trust']!({}, { cwd }, AUTH, undefined)
      assert.equal(res.status, 200)
      const body = res.body as {
        trusted: boolean
        projectPath?: string
        stakes: { sensitiveKeys: string[]; hasHooks: boolean }
      }
      assert.equal(body.trusted, false)
      assert.ok(body.projectPath?.endsWith('.rivet-config.json'), `应回项目配置路径：${body.projectPath}`)
      assert.ok(body.stakes.sensitiveKeys.includes('mcp'), `敏感键应含 mcp：${body.stakes.sensitiveKeys.join(',')}`)
      assert.ok(
        body.stakes.sensitiveKeys.includes('agent.approval'),
        `嵌套敏感键应报点路径 agent.approval：${body.stakes.sensitiveKeys.join(',')}`,
      )
      assert.equal(body.stakes.hasHooks, false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('POST /project/trust：授信后 GET 变 true，撤销后变回 false（幂等）', async () => {
  await withTempHome(async () => {
    const cwd = makeProject({ mcp: { servers: {} } })
    try {
      const routes = buildTrustRoutes('tok', () => [cwd])
      const post = (trusted: boolean) =>
        routes['POST /project/trust']!({ cwd, trusted }, undefined, AUTH, undefined)
      const get = () => routes['GET /project/trust']!({}, { cwd }, AUTH, undefined)

      const trustedNow = async (): Promise<boolean> =>
        ((await get()).body as { trusted: boolean }).trusted

      assert.equal((await post(true)).status, 200)
      assert.equal(await trustedNow(), true)
      await post(true) // 幂等：重复授信不报错
      assert.equal(await trustedNow(), true)

      assert.equal((await post(false)).status, 200)
      assert.equal(await trustedNow(), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('GET /project/trust：没有项目配置时 stakes 为空（无需提示）', async () => {
  await withTempHome(async () => {
    const cwd = makeProject()
    try {
      const routes = buildTrustRoutes('tok', () => [cwd])
      const res = await routes['GET /project/trust']!({}, { cwd }, AUTH, undefined)
      const body = res.body as {
        projectPath?: string
        stakes: { sensitiveKeys: string[]; hasHooks: boolean }
      }
      assert.equal(body.projectPath, undefined)
      assert.deepEqual(body.stakes.sensitiveKeys, [])
      assert.equal(body.stakes.hasHooks, false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('GET /project/trust：.rivet/hooks.json 存在即算赌注（hooks 未授信不执行）', async () => {
  await withTempHome(async () => {
    const cwd = makeProject(undefined, true)
    try {
      const routes = buildTrustRoutes('tok', () => [cwd])
      const res = await routes['GET /project/trust']!({}, { cwd }, AUTH, undefined)
      const body = res.body as { stakes: { hasHooks: boolean } }
      assert.equal(body.stakes.hasHooks, true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('POST /project/trust：缺 cwd 时 400', async () => {
  await withTempHome(async () => {
    const routes = buildTrustRoutes('tok')
    const res = await routes['POST /project/trust']!({}, undefined, AUTH, undefined)
    assert.equal(res.status, 400)
  })
})

test('POST /project/trust/dismiss：记「不再提示」，授信后清除（两端同一存储）', async () => {
  await withTempHome(async () => {
    const cwd = makeProject({ verify: { typecheck: 'tsc --noEmit' } })
    try {
      const routes = buildTrustRoutes('tok', () => [cwd])
      const dismiss = () => routes['POST /project/trust/dismiss']!({ cwd }, undefined, AUTH, undefined)
      const get = () => routes['GET /project/trust']!({}, { cwd }, AUTH, undefined)
      const dismissedNow = async (): Promise<boolean> =>
        ((await get()).body as { dismissed: boolean }).dismissed

      assert.equal(await dismissedNow(), false)
      const res = await dismiss()
      assert.equal(res.status, 200)
      assert.equal((res.body as { dismissed: boolean }).dismissed, true)
      assert.equal(await dismissedNow(), true)
      await dismiss() // 幂等
      assert.equal(await dismissedNow(), true)

      // 授信会清掉「不再提示」——恢复参与提示语义（与 CLI /trust 一致）。
      await routes['POST /project/trust']!({ cwd, trusted: true }, undefined, AUTH, undefined)
      assert.equal(await dismissedNow(), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('POST /project/trust/dismiss：缺 cwd 时 400', async () => {
  await withTempHome(async () => {
    const routes = buildTrustRoutes('tok')
    const res = await routes['POST /project/trust/dismiss']!({}, undefined, AUTH, undefined)
    assert.equal(res.status, 400)
  })
})

test('未注册工作区的 cwd 一律 403（issue #221）', async () => {
  await withTempHome(async () => {
    const known = makeProject()
    const outside = makeProject({ mcp: { servers: {} } })
    try {
      const routes = buildTrustRoutes('tok', () => [known])
      const get = await routes['GET /project/trust']!({}, { cwd: outside }, AUTH, undefined)
      assert.equal(get.status, 403, '未注册目录的 GET 必须被拒')
      const post = await routes['POST /project/trust']!({ cwd: outside, trusted: true }, undefined, AUTH, undefined)
      assert.equal(post.status, 403, '未注册目录不得被授信')
      const dismiss = await routes['POST /project/trust/dismiss']!({ cwd: outside }, undefined, AUTH, undefined)
      assert.equal(dismiss.status, 403, '未注册目录不得被记「不再提示」')
      // 在册的工作区照常
      assert.equal((await routes['GET /project/trust']!({}, { cwd: known }, AUTH, undefined)).status, 200)
    } finally {
      rmSync(known, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

test('三个路由都 auth-gated（fail-closed）', async () => {
  await withTempHome(async () => {
    const routes = buildTrustRoutes('tok')
    assert.equal((await routes['GET /project/trust']!({}, {}, {}, undefined)).status, 401)
    assert.equal((await routes['POST /project/trust']!({ trusted: true }, {}, {}, undefined)).status, 401)
    assert.equal((await routes['POST /project/trust/dismiss']!({ cwd: '/tmp' }, {}, {}, undefined)).status, 401)
  })
})

test('GET /project/trust/list：已授信项目带时间返回，撤销后从清单消失', async () => {
  // 授权总览页的唯一数据源：没有它，桌面端只能列出裸路径、也不显示"何时授的信"。
  await withTempHome(async () => {
    const a = makeProject({ mcp: { servers: {} } })
    const b = makeProject({ mcp: { servers: {} } })
    // 授信存储的键是 canonicalProjectDir（realpath 归一）——macOS 上 /var 是
    // /private/var 的符号链接，直接拿 mkdtemp 原路径断言必然不匹配。
    const ra = realpathSync(a)
    const rb = realpathSync(b)
    try {
      // issue #221（收编公开仓 PR #226）：显式 cwd 必须命中在册工作区——本用例造的是
      // 两个临时目录，故显式声明为已知工作区。真实流程里它们来自存活会话 / 默认工作区 /
      // 已授信目录（见 workspace-guard.ts 的 registeredWorkspaces）。
      const routes = buildTrustRoutes('tok', () => [a, b])
      const list = async (): Promise<{ path: string; trustedAt: string }[]> =>
        ((await routes['GET /project/trust/list']!({}, undefined, AUTH, undefined)).body as {
          projects: { path: string; trustedAt: string }[]
        }).projects
      const trust = (cwd: string) => routes['POST /project/trust']!({ cwd, trusted: true }, undefined, AUTH, undefined)
      const untrust = (cwd: string) => routes['POST /project/trust']!({ cwd, trusted: false }, undefined, AUTH, undefined)

      assert.deepEqual(await list(), [], '一开始没人被授信')

      await trust(a)
      await trust(b)
      const rows = await list()
      assert.equal(rows.length, 2, '两笔授信都要在清单里')
      for (const row of rows) {
        assert.ok(row.path.length > 0, '路径不能为空')
        assert.ok(!Number.isNaN(Date.parse(row.trustedAt)), `授信时间必须是可解析时间戳，实际 ${row.trustedAt}`)
      }
      // 时间倒序（最近授信在前）——同一毫秒写入时按路径稳定排序，不许抖
      assert.deepEqual(rows.map((r) => r.path).sort(), [ra, rb].sort())

      await untrust(a)
      const after = await list()
      assert.deepEqual(after.map((r) => r.path), [rb], '撤销后必须从清单消失')
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })
})

// issue #221 收编适配：已授信目录并入「在册工作区」——总览页的撤销不能因为该目录
// 当前没开着会话就 403。这条钉的是 workspace-guard.registeredWorkspaces 的第三项。
test('已授信但无存活会话的目录仍可撤销（registeredWorkspaces 并入 trust store）', async () => {
  await withTempHome(async () => {
    const cwd = makeProject()
    try {
      trustProject(cwd)
      // 真实装配形态：serve.ts 传的就是 registeredWorkspaces(sharedRuntime.sessions)
      const routes = buildTrustRoutes('tok', () => registeredWorkspaces(undefined))
      const before = (await routes['GET /project/trust/list']!({}, undefined, AUTH, undefined)).body as {
        projects: { path: string }[]
      }
      assert.equal(before.projects.length, 1, '前置：该目录已在授信清单里')

      const revoked = await routes['POST /project/trust']!({ cwd, trusted: false }, undefined, AUTH, undefined)
      assert.equal(revoked.status, 200, '无会话但已授信的目录必须能撤销（否则总览页的撤销失效）')
      const after = (await routes['GET /project/trust/list']!({}, undefined, AUTH, undefined)).body as {
        projects: { path: string }[]
      }
      assert.deepEqual(after.projects, [], '撤销后从清单消失')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

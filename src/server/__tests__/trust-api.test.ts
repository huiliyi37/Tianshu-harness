import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildTrustRoutes } from '../trust-api.js'

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
      const routes = buildTrustRoutes('tok')
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
      const routes = buildTrustRoutes('tok')
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
      const routes = buildTrustRoutes('tok')
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
      const routes = buildTrustRoutes('tok')
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
      const routes = buildTrustRoutes('tok')
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

test('三个路由都 auth-gated（fail-closed）', async () => {
  await withTempHome(async () => {
    const routes = buildTrustRoutes('tok')
    assert.equal((await routes['GET /project/trust']!({}, {}, {}, undefined)).status, 401)
    assert.equal((await routes['POST /project/trust']!({ trusted: true }, {}, {}, undefined)).status, 401)
    assert.equal((await routes['POST /project/trust/dismiss']!({ cwd: '/tmp' }, {}, {}, undefined)).status, 401)
  })
})

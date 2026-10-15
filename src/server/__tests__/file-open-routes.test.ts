import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFileOpenRoutes, startFilePreview, chromeCommand, disposeSessionFilePreviews } from '../file-open-routes.js'
import { createRouter } from '../index.js'
import type { RuntimeSessionManager } from '../session-manager.js'

test('real opening route requires authentication and explicit registered conversation root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-open-'))
  const launches: string[] = []
  const manager = { listSessions: () => [{ id: 's', cwd: root }] } as unknown as RuntimeSessionManager
  const call = createRouter(buildFileOpenRoutes(manager, 'test', async p => { launches.push(p) }))
  const body = { sessionId: 's', cwd: root, path: '中文 & page.html', action: 'chrome' }
  try {
    await writeFile(join(root, body.path), '<h1>test</h1>')
    assert.equal((await call('POST', '/file-open', body, {})).status, 401)
    assert.equal((await call('POST', '/file-open', { ...body, cwd: tmpdir() }, { authorization: 'Bearer test' })).status, 403)
    assert.equal((await call('POST', '/file-open', { ...body, cwd: undefined }, { authorization: 'Bearer test' })).status, 400)
    assert.equal((await call('POST', '/file-open', body, { authorization: 'Bearer test' })).status, 200)
    assert.deepEqual(launches, [await realpath(join(root, body.path))])
    const failure = createRouter(buildFileOpenRoutes(manager, 'test', async () => { throw Error('Chrome missing') }))
    assert.equal((await failure('POST', '/file-open', body, { authorization: 'Bearer test' })).status, 422)
    assert.deepEqual(chromeCommand(join(root, body.path), 'darwin').args.slice(0, 2), ['-a', 'Google Chrome'])
    assert.equal(fileURLToPath(chromeCommand(join(root, body.path), 'darwin').args[2]!), join(root, body.path))
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('HTML preview has separate capability origin, relative assets and fail-closed file boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-preview-'))
  const outside = await mkdtemp(join(tmpdir(), 'file-preview-outside-'))
  await mkdir(join(root, '页面'))
  await writeFile(join(root, '页面', 'demo.html'), '<link href="../style.css"><h1>demo</h1>')
  await writeFile(join(root, 'style.css'), 'h1{color:red}')
  await mkdir(join(root, '.rivet', 'artifacts'), { recursive: true })
  await writeFile(join(root, '.rivet', 'artifacts', 'demo.html'), 'artifact preview')
  await writeFile(join(root, 'secret.json'), '{"test":true}')
  await writeFile(join(outside, 'outside.js'), 'outside')
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const preview = await startFilePreview(root, join(root, '页面', 'demo.html'))
  try {
    assert.match(await (await fetch(preview.url)).text(), /demo/)
    assert.equal(await (await fetch(new URL('../style.css', preview.url))).text(), 'h1{color:red}')
    assert.equal(await (await fetch(new URL('../.rivet/artifacts/demo.html', preview.url))).text(), 'artifact preview')
    assert.equal((await fetch(new URL('../escape/outside.js', preview.url))).status, 403)
    assert.equal((await fetch(new URL('../secret.json', preview.url))).status, 403)
    assert.equal((await fetch(new URL('/style.css', preview.url))).status, 404)
    assert.equal((await fetch(preview.url, { method: 'POST' })).status, 404)
  } finally { await new Promise<void>(done => preview.server.close(() => done())); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('resource versions track served dependencies, renew and release even after deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-version-'))
  const manager = { listSessions: () => [{ id: 's', cwd: root }] } as unknown as RuntimeSessionManager
  const call = createRouter(buildFileOpenRoutes(manager, 'fixture'))
  const auth = { authorization: 'Bearer fixture' }, request = { sessionId: 's', cwd: root, path: 'demo.html' }
  try {
    await writeFile(join(root, 'demo.html'), '<script src="app.js"></script>')
    await writeFile(join(root, 'app.js'), 'window.version=1')
    await writeFile(join(root, 'scene.glb'), 'glb fixture')
    const opened = await call('POST', '/file-open', { ...request, action: 'preview' }, auth)
    const data = opened.body as { url: string; previewId: string }
    await fetch(data.url); await fetch(new URL('app.js', data.url))
    assert.equal((await fetch(new URL('scene.glb', data.url))).headers.get('content-type'), 'model/gltf-binary')
    const first = await call('POST', '/file-open', { ...request, action: 'status', previewId: data.previewId }, auth)
    const state = first.body as { version: string; servedVersion: string }
    assert.equal(state.version, state.servedVersion)
    await writeFile(join(root, 'app.js'), 'window.version=2')
    const changed = (await call('POST', '/file-open', { ...request, action: 'status', previewId: data.previewId }, auth)).body as typeof state
    assert.notEqual(changed.version, changed.servedVersion)
    assert.equal(changed.servedVersion, state.servedVersion)
    assert.equal((await call('POST', '/file-open', { ...request, action: 'status', previewId: 'foreign' }, auth)).status, 410)
    await rm(join(root, 'demo.html'))
    assert.equal((await call('POST', '/file-open', { ...request, action: 'release', previewId: data.previewId }, auth)).status, 200)
    await assert.rejects(fetch(data.url))
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('concurrent opens share one resource, expiry invalidates identity, and session disposal closes it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'preview-lifecycle-'))
  const manager = { listSessions: () => [{ id: 'life', cwd: root }] } as unknown as RuntimeSessionManager
  const call = createRouter(buildFileOpenRoutes(manager, 'fixture')), auth = { authorization: 'Bearer fixture' }
  const request = { sessionId: 'life', cwd: root, path: 'demo.html', action: 'preview' }
  try {
    await writeFile(join(root, 'demo.html'), '<h1>lifecycle</h1>')
    const results = await Promise.all(Array.from({ length: 4 }, () => call('POST', '/file-open', request, auth)))
    const resources = results.map(r => r.body as { url: string; previewId: string })
    assert.equal(new Set(resources.map(r => r.previewId)).size, 1)
    assert.equal(new Set(resources.map(r => r.url)).size, 1)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    await call('POST', '/file-open', { ...request, action: 'status', previewId: resources[0]!.previewId }, auth)
    t.mock.timers.tick(30 * 60 * 1000)
    assert.equal((await call('POST', '/file-open', { ...request, action: 'status', previewId: resources[0]!.previewId }, auth)).status, 410)
    t.mock.timers.reset()
    await assert.rejects(fetch(resources[0]!.url))
    const pending = call('POST', '/file-open', request, auth)
    disposeSessionFilePreviews('life')
    assert.equal((await pending).status, 410, 'disposal during creation cannot leave a loopback server')
    const reopened = (await call('POST', '/file-open', request, auth)).body as { url: string }
    disposeSessionFilePreviews('life')
    await assert.rejects(fetch(reopened.url))
  } finally { t.mock.timers.reset(); disposeSessionFilePreviews('life'); await rm(root, { recursive: true, force: true }) }
})

test('answer-me-with-html output under .am/pages is previewable while other hidden paths stay forbidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-preview-am-'))
  const manager = { listSessions: () => [{ id: 's', cwd: root }] } as unknown as RuntimeSessionManager
  const call = createRouter(buildFileOpenRoutes(manager, 'fixture'))
  const auth = { authorization: 'Bearer fixture' }
  const page = '.am/pages/Oracle-分页查询-取-10-条数据-20261010-114624.html'
  try {
    await mkdir(join(root, '.am', 'pages'), { recursive: true })
    await writeFile(join(root, page), '<link href="style.css"><h1>answer</h1>')
    await writeFile(join(root, '.am', 'pages', 'style.css'), 'h1{color:red}')
    await writeFile(join(root, '.am', 'runtime.json'), '{"internal":true}')
    await mkdir(join(root, '.notes'))
    await writeFile(join(root, '.notes', 'draft.html'), 'private')
    const opened = await call('POST', '/file-open', { sessionId: 's', cwd: root, path: page, action: 'preview' }, auth)
    assert.equal(opened.status, 200)
    const data = opened.body as { url: string }
    const served = await fetch(data.url)
    assert.equal(served.status, 200)
    assert.match(await served.text(), /<h1>answer<\/h1>/)
    assert.equal(await (await fetch(new URL('style.css', data.url))).text(), 'h1{color:red}')
    assert.equal((await fetch(new URL('../runtime.json', data.url))).status, 403)
    assert.equal((await fetch(new URL('../../.notes/draft.html', data.url))).status, 403)
  } finally { disposeSessionFilePreviews('s'); await rm(root, { recursive: true, force: true }) }
})

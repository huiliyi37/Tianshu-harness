import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readlinkSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { IMPORT_RESOURCE_TOOL, parseGitHubUrl, isSafeGitRef, setHttpFetchForTests, subpathEscapesContainer } from '../import-resource.js'
import type { ToolCallParams } from '../types.js'

function makeParams(input: Record<string, unknown>, cwd: string): ToolCallParams {
  return {
    input,
    toolUseId: 'test-import',
    cwd,
  }
}

describe('import_resource', () => {
  let tmpCwd: string
  let tmpExternal: string

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'import-test-'))
    tmpExternal = join(tmpCwd, '.rivet', 'external')
  })

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true })
  })

  // issue #119 — subpath 由模型/URL 构造，`blob/main/../../../../etc/passwd` 曾可
  // 越过 .rivet/external 读工作区外任意文件；审批 UI 只显示原始 URL，难以察觉。
  describe('subpath container guard', () => {
    it('rejects lexical .. traversal', () => {
      assert.equal(subpathEscapesContainer('/a/b/repo', '../../../../etc/passwd'), true)
      assert.equal(subpathEscapesContainer('/a/b/repo', 'sub/../../../etc/passwd'), true)
      assert.equal(subpathEscapesContainer('/a/b/repo', '..'), true)
    })

    it('allows in-tree subpaths, including harmless internal ..', () => {
      assert.equal(subpathEscapesContainer('/a/b/repo', 'src/index.ts'), false)
      assert.equal(subpathEscapesContainer('/a/b/repo', 'src/../README.md'), false)
      assert.equal(subpathEscapesContainer('/a/b/repo', ''), false)
    })

    it('rejects a symlink inside the container that points outside', () => {
      const root = mkdtempSync(join(tmpdir(), 'import-guard-'))
      try {
        mkdirSync(join(root, 'inner'), { recursive: true })
        symlinkSync('/etc', join(root, 'inner', 'link'))
        assert.equal(subpathEscapesContainer(root, 'inner/link/passwd'), true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('parseGitHubUrl', () => {
    it('parses simple owner/repo', () => {
      const result = parseGitHubUrl('github.com/user/repo')
      assert.deepEqual(result, { owner: 'user', repo: 'repo', ref: undefined, subpath: undefined })
    })

    it('parses https URL', () => {
      const result = parseGitHubUrl('https://github.com/owner/project')
      assert.deepEqual(result, { owner: 'owner', repo: 'project', ref: undefined, subpath: undefined })
    })

    it('parses URL with .git suffix', () => {
      const result = parseGitHubUrl('https://github.com/owner/project.git')
      assert.deepEqual(result, { owner: 'owner', repo: 'project', ref: undefined, subpath: undefined })
    })

    it('parses URL with tree ref and subpath', () => {
      const result = parseGitHubUrl('https://github.com/owner/project/tree/main/src/lib')
      assert.deepEqual(result, { owner: 'owner', repo: 'project', ref: 'main', subpath: 'src/lib' })
    })

    it('returns null for non-GitHub URLs', () => {
      assert.equal(parseGitHubUrl('https://example.com/file.txt'), null)
      assert.equal(parseGitHubUrl('/tmp/file.txt'), null)
    })
  })

  describe('local file import', () => {
    it('imports a local file via symlink', async () => {
      // Create an external file
      const externalDir = mkdtempSync(join(tmpdir(), 'ext-'))
      const externalFile = join(externalDir, 'test.txt')
      writeFileSync(externalFile, 'Hello, external world!')

      try {
        const result = await IMPORT_RESOURCE_TOOL.execute(makeParams({ source: externalFile }, tmpCwd))
        assert.equal(result.isError, undefined)

        // Should contain the local path
        assert.match(result.content, /已导入：/)
        assert.match(result.content, /\.rivet\/external\//)

        // File should be accessible — check the import directory exists
        assert.ok(existsSync(join(tmpCwd, '.rivet', 'external')))

        // Should include preview
        assert.match(result.content, /Hello, external world!/)
      } finally {
        rmSync(externalDir, { recursive: true, force: true })
      }
    })

    it('imports a directory via junction', async () => {
      const externalDir = mkdtempSync(join(tmpdir(), 'extdir-'))
      writeFileSync(join(externalDir, 'a.ts'), 'const a = 1')
      writeFileSync(join(externalDir, 'b.ts'), 'const b = 2')

      try {
        const result = await IMPORT_RESOURCE_TOOL.execute(makeParams({ source: externalDir }, tmpCwd))
        assert.equal(result.isError, undefined)
        assert.match(result.content, /类型：directory/)
        assert.match(result.content, /junction/)
      } finally {
        rmSync(externalDir, { recursive: true, force: true })
      }
    })

    it('returns error for nonexistent path', async () => {
      const result = await IMPORT_RESOURCE_TOOL.execute(
        makeParams({ source: '/nonexistent/path/file.txt' }, tmpCwd),
      )
      assert.equal(result.isError, true)
      assert.match(result.content, /路径不存在/)
    })

    it('returns error for empty source', async () => {
      const result = await IMPORT_RESOURCE_TOOL.execute(makeParams({ source: '' }, tmpCwd))
      assert.equal(result.isError, true)
      assert.match(result.content, /source 为必填项/)
    })

    it('expands ~ to HOME', async () => {
      // Just verify it doesn't crash — we can't test actual HOME reading without a real file
      const result = await IMPORT_RESOURCE_TOOL.execute(
        makeParams({ source: '~/nonexistent_test_file_xyz.txt' }, tmpCwd),
      )
      assert.equal(result.isError, true)
      // Should have expanded ~ to actual HOME path
      assert.doesNotMatch(result.content, /~/)
    })
  })

  describe('URL import', () => {
    it('returns error for unreachable URL', async () => {
      const result = await IMPORT_RESOURCE_TOOL.execute(
        makeParams({ source: 'https://nonexistent.invalid/test.txt' }, tmpCwd),
      )
      assert.equal(result.isError, true)
    })

    it('downloads a text file via httpFetchGuarded', async () => {
      // httpFetchGuarded 使用 undici，globalThis.fetch mock 无效；经测试注入点短路。
      setHttpFetchForTests(async () => ({
        status: 200,
        finalUrl: 'http://example.com/file.txt',
        contentType: 'text/plain',
        bytes: new TextEncoder().encode('downloaded content'),
      }))
      try {
        const result = await IMPORT_RESOURCE_TOOL.execute(
          makeParams({ source: 'http://example.com/file.txt' }, tmpCwd),
        )
        assert.equal(result.isError, undefined)
        assert.match(result.content, /已导入：/)
        assert.match(result.content, /downloaded content/)
      } finally {
        setHttpFetchForTests(null)
      }
    })

    it('rejects private IP URLs (SSRF)', async () => {
      const result = await IMPORT_RESOURCE_TOOL.execute(
        makeParams({ source: 'http://127.0.0.1/secret.txt' }, tmpCwd),
      )
      assert.equal(result.isError, true)
      assert.match(result.content, /Access denied/)
    })

    it('surfaces HTTP errors from the remote server', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => new Response('not found', { status: 404 })
      try {
        const result = await IMPORT_RESOURCE_TOOL.execute(
          makeParams({ source: 'http://example.com/missing.txt' }, tmpCwd),
        )
        assert.equal(result.isError, true)
        assert.match(result.content, /HTTP 404/)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('isSafeGitRef', () => {
    it('accepts normal branches/tags/commits', () => {
      assert.equal(isSafeGitRef('main'), true)
      assert.equal(isSafeGitRef('v2.18.0'), true)
      assert.equal(isSafeGitRef('feature/foo-bar'), true)
      assert.equal(isSafeGitRef('a1b2c3d'), true)
    })

    it('rejects refs starting with "-" (git option injection)', () => {
      assert.equal(isSafeGitRef('--upload-pack=touch /tmp/pwn'), false)
      assert.equal(isSafeGitRef('-x'), false)
    })

    it('rejects refs with whitespace, control chars, or git-invalid chars', () => {
      assert.equal(isSafeGitRef('a b'), false)
      assert.equal(isSafeGitRef('a\nb'), false)
      assert.equal(isSafeGitRef('a:b'), false)   // invalid in a git ref name
      assert.equal(isSafeGitRef('a?b'), false)
      assert.equal(isSafeGitRef(''), false)
    })

    it('rejects option-injecting ref via the GitHub import path', async () => {
      const result = await IMPORT_RESOURCE_TOOL.execute(
        makeParams({ source: 'github.com/owner/repo', ref: '--upload-pack=touch /tmp/pwn' }, tmpCwd),
      )
      assert.equal(result.isError, true)
      assert.match(result.content, /无效的 git ref/i)
    })
  })

  describe('GitHub URL parsing edge cases', () => {
    it('handles blob URLs', () => {
      const result = parseGitHubUrl('https://github.com/owner/repo/blob/main/README.md')
      assert.ok(result)
      assert.equal(result.owner, 'owner')
      assert.equal(result.repo, 'repo')
      assert.equal(result.ref, 'main')
      assert.equal(result.subpath, 'README.md')
    })

    it('returns null for empty string', () => {
      assert.equal(parseGitHubUrl(''), null)
    })
  })

  describe('tool metadata', () => {
    it('requires approval', () => {
      assert.equal(IMPORT_RESOURCE_TOOL.requiresApproval(makeParams({ source: '/tmp/x' }, tmpCwd)), true)
    })

    it('is not concurrency safe', () => {
      assert.equal(IMPORT_RESOURCE_TOOL.isConcurrencySafe(), false)
    })

    it('is always enabled', () => {
      assert.equal(IMPORT_RESOURCE_TOOL.isEnabled(), true)
    })

    it('has correct definition name', () => {
      assert.equal(IMPORT_RESOURCE_TOOL.definition.name, 'import_resource')
    })
  })
})

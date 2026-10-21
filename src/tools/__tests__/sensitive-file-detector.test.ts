import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  detectSensitiveFile,
  detectSensitiveFileOnDisk,
  detectSensitiveGitAdd,
  parseGitIndexCommits,
  gitCommitStagesSensitive,
  gitCommitStagesSensitiveDualView,
  AGGREGATE_ADD_MARKER,
} from '../sensitive-file-detector.js'

describe('sensitive-file-detector', () => {
  describe('detectSensitiveFile', () => {
    it('detects .env as sensitive', () => {
      const r = detectSensitiveFile('.env')
      assert.equal(r.sensitive, true)
      assert.equal(r.patternName, '.env (real)')
    })

    it('detects .env.local as sensitive', () => {
      assert.equal(detectSensitiveFile('.env.local').sensitive, true)
    })

    it('detects .env.production as sensitive', () => {
      assert.equal(detectSensitiveFile('.env.production').sensitive, true)
    })

    it('does NOT detect .env.example (whitelisted)', () => {
      assert.equal(detectSensitiveFile('.env.example').sensitive, false)
    })

    it('does NOT detect .env.template (whitelisted)', () => {
      assert.equal(detectSensitiveFile('.env.template').sensitive, false)
    })

    it('detects credentials.json', () => {
      const r = detectSensitiveFile('config/credentials.json')
      assert.equal(r.sensitive, true)
    })

    it('detects SSH private keys', () => {
      assert.equal(detectSensitiveFile('~/.ssh/id_rsa').sensitive, true)
      assert.equal(detectSensitiveFile('id_ed25519').sensitive, true)
    })

    it('detects .pem and .key files', () => {
      assert.equal(detectSensitiveFile('certs/server.pem').sensitive, true)
      assert.equal(detectSensitiveFile('tls/private.key').sensitive, true)
    })

    it('detects .npmrc', () => {
      assert.equal(detectSensitiveFile('.npmrc').sensitive, true)
    })

    it('detects secrets.json', () => {
      assert.equal(detectSensitiveFile('secrets.json').sensitive, true)
      assert.equal(detectSensitiveFile('config/tokens.yaml').sensitive, true)
    })

    it('does NOT detect .ts source files (auth/token-manager.ts)', () => {
      assert.equal(detectSensitiveFile('src/auth/token-manager.ts').sensitive, false)
    })

    it('does NOT detect .js source files', () => {
      assert.equal(detectSensitiveFile('src/auth/secrets.js').sensitive, false)
    })

    it('does NOT detect test files', () => {
      assert.equal(detectSensitiveFile('src/env.test.ts').sensitive, false)
    })

    it('does NOT detect regular source files', () => {
      assert.equal(detectSensitiveFile('src/agent/loop.ts').sensitive, false)
    })

    it('does NOT detect markdown docs', () => {
      assert.equal(detectSensitiveFile('docs/secrets.md').sensitive, false)
    })
  })

  // issue #136 — 目录白名单收窄：scripts/、fixtures/ 不再整目录放行，真实凭证
  // 形态（.env、credentials.json）无论在哪个目录都拦；源码/生成脚本不受影响。
  describe('detectSensitiveFile — directory whitelist removed (issue #136)', () => {
    it('detects .env inside scripts/', () => {
      assert.equal(detectSensitiveFile('scripts/.env').sensitive, true)
    })

    it('detects credentials.json inside fixtures/', () => {
      assert.equal(detectSensitiveFile('fixtures/credentials.json').sensitive, true)
      assert.equal(detectSensitiveFile('FIXTURES/.env').sensitive, true)
    })

    it('still allows credential generation scripts and templates', () => {
      assert.equal(detectSensitiveFile('Scripts/gen-creds.ts').sensitive, false)
      assert.equal(detectSensitiveFile('scripts/gen-tokens.sh').sensitive, false)
      assert.equal(detectSensitiveFile('docs/.ENV.EXAMPLE').sensitive, false)
    })
  })

  describe('detectSensitiveFile — normalization robustness (M3)', () => {
    it('detects case variants', () => {
      assert.equal(detectSensitiveFile('.ENV').sensitive, true)
      assert.equal(detectSensitiveFile('.Env.Local').sensitive, true)
      assert.equal(detectSensitiveFile('CREDENTIALS.JSON').sensitive, true)
      assert.equal(detectSensitiveFile('DEBUG.KEYSTORE').sensitive, true)
    })

    it('detects trailing separator / trailing dot / trailing space forms', () => {
      assert.equal(detectSensitiveFile('.env/').sensitive, true)
      assert.equal(detectSensitiveFile('.env.').sensitive, true)
      assert.equal(detectSensitiveFile('.env ').sensitive, true)
      assert.equal(detectSensitiveFile('config/credentials.json/').sensitive, true)
    })

    it('detects backslash-separated Windows paths', () => {
      assert.equal(detectSensitiveFile('C:\\repo\\.env').sensitive, true)
      assert.equal(detectSensitiveFile('C:\\repo\\config\\credentials.json').sensitive, true)
      assert.equal(detectSensitiveFile('C:\\Users\\x\\.ssh\\id_rsa').sensitive, true)
    })

    it('detects NTFS alternate-data-stream forms (::$DATA opens the file itself on Win32)', () => {
      for (const p of ['.env::$DATA', '.ENV::$data', '.env:stream:$DATA', '.env.local::$DATA', 'id_rsa::$DATA',
        'credentials.json::$DATA', 'C:\\repo\\.env::$DATA', 'sub/../.env::$DATA', 'server.key:x', '.env.::$DATA']) {
        assert.equal(detectSensitiveFile(p).sensitive, true, p)
      }
    })

    it('stream suffix cannot borrow a whitelist extension', () => {
      assert.equal(detectSensitiveFile('.env:notes.md').sensitive, true)
      assert.equal(detectSensitiveFile('credentials.json:x.test.ts').sensitive, true)
    })

    it('drive letters and ordinary colon-free paths are unaffected', () => {
      assert.equal(detectSensitiveFile('C:\\repo\\src\\index.ts').sensitive, false)
      assert.equal(detectSensitiveFile('C:/repo/README.md').sensitive, false)
      assert.equal(detectSensitiveFile('docs/.env.example::$DATA').sensitive, false)
    })

    it('whitelists still apply case-insensitively', () => {
      assert.equal(detectSensitiveFile('Scripts/gen-creds.ts').sensitive, false)
      assert.equal(detectSensitiveFile('docs/.ENV.EXAMPLE').sensitive, false)
    })

    it('returns the original path untouched', () => {
      const r = detectSensitiveFile('.ENV/')
      assert.equal(r.path, '.ENV/')
      assert.equal(r.sensitive, true)
    })
  })

  describe('detectSensitiveFile — default read-grant blind spots (M4)', () => {
    it('detects extensionless credentials (cargo/gem)', () => {
      assert.equal(detectSensitiveFile('~/.cargo/credentials').sensitive, true)
      assert.equal(detectSensitiveFile('~/.gem/credentials').sensitive, true)
      assert.equal(detectSensitiveFile('credentials').sensitive, true)
      assert.equal(detectSensitiveFile('C:\\Users\\x\\.cargo\\credentials').sensitive, true)
    })

    it('detects .netrc and .git-credentials', () => {
      assert.equal(detectSensitiveFile('~/.netrc').sensitive, true)
      assert.equal(detectSensitiveFile('~/.git-credentials').sensitive, true)
      assert.equal(detectSensitiveFile('C:\\Users\\x\\_netrc').sensitive, false) // _netrc 不在模式内
    })

    it('detects Android debug.keystore', () => {
      assert.equal(detectSensitiveFile('android/debug.keystore').sensitive, true)
      assert.equal(detectSensitiveFile('debug.keystore').sensitive, true)
    })

    it('does NOT flag source files with credentials in the stem', () => {
      assert.equal(detectSensitiveFile('src/credentials.ts').sensitive, false)
      assert.equal(detectSensitiveFile('src/credentials.test.ts').sensitive, false)
      assert.equal(detectSensitiveFile('docs/credentials.md').sensitive, false)
    })

    it('does NOT flag settings.xml (too generic, deliberately excluded)', () => {
      assert.equal(detectSensitiveFile('~/.m2/settings.xml').sensitive, false)
    })
  })

  describe('detectSensitiveGitAdd', () => {
    it('detects git add .env', () => {
      const files = detectSensitiveGitAdd('git add .env')
      assert.deepEqual(files, ['.env'])
    })

    it('detects git add with multiple files including sensitive', () => {
      const files = detectSensitiveGitAdd('git add src/foo.ts .env credentials.json')
      assert.ok(files.includes('.env'))
      assert.ok(files.includes('credentials.json'))
    })

    it('returns empty for git add with no sensitive files', () => {
      const files = detectSensitiveGitAdd('git add src/foo.ts src/bar.ts')
      assert.equal(files.length, 0)
    })

    it('returns empty for non-git-add commands', () => {
      const files = detectSensitiveGitAdd('git status')
      assert.equal(files.length, 0)
    })

    it('handles git add with flags', () => {
      const files = detectSensitiveGitAdd('git add -A')
      assert.deepEqual(files, [AGGREGATE_ADD_MARKER]) // 聚合形态 → 哨兵（issue #136）
    })

    it('flags aggregate staging forms with the aggregate marker (issue #136)', () => {
      assert.deepEqual(detectSensitiveGitAdd('git add .'), [AGGREGATE_ADD_MARKER])
      assert.deepEqual(detectSensitiveGitAdd('git add ./'), [AGGREGATE_ADD_MARKER])
      assert.deepEqual(detectSensitiveGitAdd('git add --all'), [AGGREGATE_ADD_MARKER])
      assert.deepEqual(detectSensitiveGitAdd('GIT ADD -A'), [AGGREGATE_ADD_MARKER])
    })

    it('collects concrete hits alongside the aggregate marker', () => {
      const files = detectSensitiveGitAdd('git add . .env')
      assert.ok(files.includes(AGGREGATE_ADD_MARKER))
      assert.ok(files.includes('.env'))
    })

    it('flags -A/--all mixed with explicit sensitive paths', () => {
      const files = detectSensitiveGitAdd('git add -A credentials.json')
      assert.ok(files.includes(AGGREGATE_ADD_MARKER))
      assert.ok(files.includes('credentials.json'))
    })

    it('matches case-insensitively (PowerShell/cmd command casing)', () => {
      const files = detectSensitiveGitAdd('GIT ADD .env')
      assert.deepEqual(files, ['.env'])
    })

    it('detects cased sensitive file arguments', () => {
      const files = detectSensitiveGitAdd('git add src/a.ts .ENV debug.KEYSTORE')
      assert.ok(files.includes('.ENV'))
      assert.ok(files.includes('debug.KEYSTORE'))
    })

    it('does not flag unparseable/odd commands (no crash, no false gate)', () => {
      assert.equal(detectSensitiveGitAdd('').length, 0)
      assert.equal(detectSensitiveGitAdd('git add').length, 0)
      assert.equal(detectSensitiveGitAdd('git add   ').length, 0)
    })
  })

  describe('stacked .env suffixes and git add bypass forms', () => {
    it('flags framework-standard stacked .env variants', () => {
      for (const f of ['.env.production.local', '.env.development.local', '.env.test.local', '.env.test', 'apps/web/.env.staging.local']) {
        assert.equal(detectSensitiveFile(f).sensitive, true, f)
      }
    })

    it('keeps templates and source files unflagged', () => {
      for (const f of ['.env.example', '.env.sample', 'src/env.test.ts', 'config.env.ts']) {
        assert.equal(detectSensitiveFile(f).sensitive, false, f)
      }
    })

    it('strips quotes around git add arguments', () => {
      assert.deepEqual(detectSensitiveGitAdd('git add ".env"'), ['.env'])
      assert.deepEqual(detectSensitiveGitAdd("git add '.env.production.local'"), ['.env.production.local'])
    })

    it('recognizes git global options before add', () => {
      assert.deepEqual(detectSensitiveGitAdd('git -C repo add .env'), ['.env'])
      assert.deepEqual(detectSensitiveGitAdd('git -c core.autocrlf=false add credentials.json'), ['credentials.json'])
    })

    it('treats non-enumerable pathspecs as aggregate', () => {
      for (const c of ['git add .\\', 'git add *', 'git add -u', 'git add --update', 'git add :/']) {
        assert.deepEqual(detectSensitiveGitAdd(c), [AGGREGATE_ADD_MARKER], c)
      }
    })
  })
  describe('detectSensitiveFileOnDisk — canonical on-disk name', () => {
    it('passes through lexical hits and non-existent paths', () => {
      assert.equal(detectSensitiveFileOnDisk('/no/such/dir/.env').sensitive, true)
      assert.equal(detectSensitiveFileOnDisk('/no/such/dir/notes.txt').sensitive, false)
    })

    it('catches a harmless-looking symlink to .env and keeps the original path', (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'sens-disk-'))
      try {
        writeFileSync(join(dir, '.env'), 'SECRET=1\n')
        try { symlinkSync(join(dir, '.env'), join(dir, 'notes.txt')) } catch { t.skip('symlink not permitted'); return }
        const r = detectSensitiveFileOnDisk(join(dir, 'notes.txt'))
        assert.equal(r.sensitive, true)
        assert.equal(r.path, join(dir, 'notes.txt'))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('expands Windows 8.3 short names (ENV~1, CREDEN~1.JSO)', (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'sens-disk-'))
      try {
        writeFileSync(join(dir, '.env'), 'SECRET=1\n')
        writeFileSync(join(dir, 'credentials.json'), '{}')
        writeFileSync(join(dir, 'readme-long-name.md'), '#')
        if (!existsSync(join(dir, 'ENV~1'))) { t.skip('volume does not generate 8.3 short names'); return }
        assert.equal(detectSensitiveFileOnDisk(join(dir, 'ENV~1')).sensitive, true)
        assert.equal(detectSensitiveFileOnDisk(join(dir, 'CREDEN~1.JSO')).sensitive, true)
        assert.equal(detectSensitiveFileOnDisk(join(dir, 'README~1.MD')).sensitive, false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('parseGitIndexCommits', () => {
    const base = { onlyFiles: false, repoArgs: [], uncertainRepo: false }
    const indexCommit = { files: [], commitsIndex: true, stagesAllTracked: false, ...base }
    it('bare / -m commit commits the whole index', () => {
      assert.deepEqual(parseGitIndexCommits('git commit'), [indexCommit])
      assert.deepEqual(parseGitIndexCommits('git commit -m "wip"'), [indexCommit])
    })

    it('detects -a/--all (incl. combined -am) and skips the message value', () => {
      assert.deepEqual(parseGitIndexCommits('git commit -a -m "wip"'), [{ ...indexCommit, stagesAllTracked: true }])
      assert.deepEqual(parseGitIndexCommits('git commit -am "wip"'), [{ ...indexCommit, stagesAllTracked: true }])
      assert.deepEqual(parseGitIndexCommits('git commit --all'), [{ ...indexCommit, stagesAllTracked: true }])
    })

    it('does not mistake `-m .env` message for a file operand', () => {
      // `git commit -m .env` 的 .env 是 message；按名检查会多一次审批但不漏判
      assert.deepEqual(parseGitIndexCommits('git commit -m .env'), [indexCommit])
    })

    it('collects explicit pathspec/--only operands (bare pathspec = --only semantics)', () => {
      assert.deepEqual(parseGitIndexCommits('git commit --only -- .env'),
        [{ files: ['.env'], commitsIndex: false, stagesAllTracked: false, onlyFiles: true, repoArgs: [], uncertainRepo: false }])
      // 实测：`git commit -m msg -- src/a.ts` 只提交列出的文件（已暂存的其余文件保持 staged）
      assert.deepEqual(parseGitIndexCommits('git commit -m msg -- src/a.ts "src/b.ts"'),
        [{ files: ['src/a.ts', 'src/b.ts'], commitsIndex: false, stagesAllTracked: false, onlyFiles: true, repoArgs: [], uncertainRepo: false }])
    })

    it('P1-3: --include commits the whole index, not just the listed files', () => {
      const r = parseGitIndexCommits('git commit --include README.md -m fixture')
      assert.equal(r.length, 1)
      assert.equal(r[0]!.commitsIndex, true)
      assert.equal(r[0]!.onlyFiles, false)
      assert.deepEqual(r[0]!.files, ['README.md'])
    })

    it('P1-3: --author/--date values are not file operands (index check must not be skipped)', () => {
      // 旧逻辑把 "John" 当成文件操作数 → files 非空 → 跳过暂存区检查（漏拦）
      const r = parseGitIndexCommits('git commit --author "John Doe <j@x.com>" -m msg')
      assert.deepEqual(r[0]!.files, [])
      assert.equal(r[0]!.commitsIndex, true)
      const r2 = parseGitIndexCommits('git commit --date "2026-01-01 00:00:00" --cleanup=strip -m msg')
      assert.deepEqual(r2[0]!.files, [])
      assert.equal(r2[0]!.commitsIndex, true)
      // -t（--template 取值）合写形态：`git commit -at tpl -m msg` 的 tpl 不是文件
      const r3 = parseGitIndexCommits('git commit -at tpl -m msg')
      assert.deepEqual(r3[0]!.files, [])
      assert.equal(r3[0]!.stagesAllTracked, true)
    })

    it('P1-2: retains the real repo location from -C/--git-dir/--work-tree', () => {
      const r = parseGitIndexCommits('git -C sub commit -m x')
      assert.deepEqual(r[0]!.repoArgs, ['-C', 'sub'])
      assert.equal(r[0]!.uncertainRepo, false)
      const r2 = parseGitIndexCommits('git --git-dir=/x/.git --work-tree=/x commit -m y')
      assert.deepEqual(r2[0]!.repoArgs, ['--git-dir=/x/.git', '--work-tree=/x'])
      const r3 = parseGitIndexCommits('git -C"/my repo" commit')
      assert.deepEqual(r3[0]!.repoArgs, ['-C', '/my repo'])
    })

    it('P1-2: GIT_DIR env prefix is uncertain → conservative approval', () => {
      const r = parseGitIndexCommits('GIT_DIR=/elsewhere/.git git commit -m x')
      assert.equal(r.length, 1)
      assert.equal(r[0]!.uncertainRepo, true)
      // 无害环境变量不触发
      const r2 = parseGitIndexCommits('FOO=bar git commit -m x')
      assert.equal(r2[0]!.uncertainRepo, false)
    })

    it('handles git global opts and stops at shell separators', () => {
      assert.deepEqual(parseGitIndexCommits('git -C sub commit -m x'),
        [{ ...indexCommit, repoArgs: ['-C', 'sub'] }])
      assert.deepEqual(parseGitIndexCommits('git add -A && git commit -m "wip"'), [indexCommit])
      assert.equal(parseGitIndexCommits('echo hi').length, 0)
    })

    it('does not match obfuscated `git${IFS}commit` in the raw view (dual-view job)', () => {
      assert.equal(parseGitIndexCommits('git${IFS}commit -m x').length, 0)
    })
  })

  describe('gitCommitStagesSensitive (real git)', () => {
    function makeRepo(): string {
      const dir = mkdtempSync(join(tmpdir(), 'commit-gate-'))
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
      writeFileSync(join(dir, 'README.md'), 'hi')
      execFileSync('git', ['add', '.'], { cwd: dir })
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
      return dir
    }

    it('flags bare `git commit -m` when the index holds a sensitive file', () => {
      const dir = makeRepo()
      try {
        writeFileSync(join(dir, '.env'), 'K=V')
        execFileSync('git', ['add', '.env'], { cwd: dir })
        assert.equal(gitCommitStagesSensitive(dir, 'git commit -m fixture'), true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('does not flag a clean index', () => {
      const dir = makeRepo()
      try {
        assert.equal(gitCommitStagesSensitive(dir, 'git commit -m fixture'), false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('P1-2: `git -C <B> commit` checks repo B, not the tool cwd (repo A)', () => {
      const repoA = makeRepo() // 干净仓库：工具 cwd
      const repoB = makeRepo()
      try {
        writeFileSync(join(repoB, '.env'), 'K=V')
        execFileSync('git', ['add', '.env'], { cwd: repoB })
        // 旧逻辑固定查 cwd（repoA）→ 漏拦；现在必须查到 repoB 的暂存区
        assert.equal(gitCommitStagesSensitive(repoA, `git -C ${repoB} commit -m fixture`), true)
        // 反向：repoB 干净、repoA 脏时，-C 指向干净仓库不应误报
        assert.equal(gitCommitStagesSensitive(repoB, `git -C ${repoA} commit -m fixture`), false)
      } finally {
        rmSync(repoA, { recursive: true, force: true })
        rmSync(repoB, { recursive: true, force: true })
      }
    })

    it('P1-3: `git commit --include README.md` still inspects the index', () => {
      const dir = makeRepo()
      try {
        writeFileSync(join(dir, '.env'), 'K=V')
        execFileSync('git', ['add', '.env'], { cwd: dir })
        // --include 会提交整个 index：只查 README.md 就跳过是漏拦
        assert.equal(gitCommitStagesSensitive(dir, 'git commit --include README.md -m fixture'), true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('P1-3: `--author` value is not a file operand; the index is still inspected', () => {
      const dir = makeRepo()
      try {
        writeFileSync(join(dir, '.env'), 'K=V')
        execFileSync('git', ['add', '.env'], { cwd: dir })
        assert.equal(gitCommitStagesSensitive(dir, 'git commit --author "Jane <j@x.com>" -m fixture'), true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('bare pathspec only commits the listed files (no index check needed)', () => {
      const dir = makeRepo()
      try {
        writeFileSync(join(dir, '.env'), 'K=V')
        execFileSync('git', ['add', '.env'], { cwd: dir })
        // 只提交 README.md：暂存区的 .env 不入库 → 不拦
        assert.equal(gitCommitStagesSensitive(dir, 'git commit -m fixture -- README.md'), false)
        // 但列出敏感文件本身要拦
        assert.equal(gitCommitStagesSensitive(dir, 'git commit --only -- .env'), true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('directory and wildcard pathspecs inspect the files they select', () => {
      const dir = makeRepo()
      try {
        mkdirSync(join(dir, 'config'))
        writeFileSync(join(dir, 'config', '.env'), 'K=V')
        execFileSync('git', ['add', 'config/.env'], { cwd: dir })
        assert.equal(gitCommitStagesSensitive(dir, 'git commit -m fixture -- config'), true)
        assert.equal(gitCommitStagesSensitive(dir, 'git commit -m fixture -- "config/*"'), true)
        assert.equal(gitCommitStagesSensitive(dir, 'git commit -m fixture -- README.md'), false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('uncertain repo location (GIT_DIR prefix) fails closed', () => {
      const dir = makeRepo()
      try {
        assert.equal(gitCommitStagesSensitive(dir, 'GIT_DIR=/elsewhere/.git git commit -m x'), true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('dual view: obfuscated `git${IFS}-C <B> commit` still checks repo B', () => {
      // raw 视图正则匹配不上 ${IFS}；normalizeBashCommand 又会剥掉 -C——
      // 专用去混淆视图必须保留定位参数，否则在干净 cwd 下漏拦
      const repoA = makeRepo()
      const repoB = makeRepo()
      try {
        writeFileSync(join(repoB, '.env'), 'K=V')
        execFileSync('git', ['add', '.env'], { cwd: repoB })
        assert.equal(gitCommitStagesSensitiveDualView(repoA, `git\${IFS}-C ${repoB} commit -m fixture`), true)
        assert.equal(gitCommitStagesSensitiveDualView(repoA, `g\\it -C ${repoB} commit -m fixture`), true)
        // 干净仓库常规流不受影响
        assert.equal(gitCommitStagesSensitiveDualView(repoA, 'git commit -m fixture'), false)
      } finally {
        rmSync(repoA, { recursive: true, force: true })
        rmSync(repoB, { recursive: true, force: true })
      }
    })
  })
})

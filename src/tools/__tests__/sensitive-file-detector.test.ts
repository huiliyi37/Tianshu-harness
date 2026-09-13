import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectSensitiveFile,
  detectSensitiveGitAdd,
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
})

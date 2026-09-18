import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GitignoreFilter } from '../gitignore.js'

describe('GitignoreFilter', () => {
  it('matches Windows-style relative paths against slash-based ignore patterns', () => {
    const filter = new GitignoreFilter('C:\\repo', ['dist/', 'src/generated/*.ts'])

    assert.equal(filter.isIgnored('C:\\repo', 'C:\\repo\\dist\\bundle.js'), true)
    assert.equal(filter.isIgnored('C:\\repo', 'C:\\repo\\src\\generated\\api.ts'), true)
    assert.equal(filter.isIgnored('C:\\repo', 'C:\\repo\\src\\handwritten\\api.ts'), false)
  })

  it('does NOT apply gitignore to paths outside the project tree', () => {
    // .rivet is in .gitignore, but ~/.rivet/sessions/ is outside the project
    const filter = new GitignoreFilter('/Users/me/project', ['.rivet', 'node_modules'])

    assert.equal(
      filter.isIgnored('/Users/me/project', '/Users/me/project/.rivet/knowledge/memory.jsonl'),
      true,
      'in-project .rivet paths should still be gitignored',
    )
    // Cross-platform: any absolute path whose prefix differs from cwd
    // must not be blocked, regardless of OS path conventions.
    assert.equal(
      filter.isIgnored('/Users/me/project', '/Users/me/.rivet/sessions/some-slug/session.jsonl'),
      false,
      'OUTSIDE-project paths should NOT be gitignored even if pattern matches',
    )
    assert.equal(
      filter.isIgnored('/home/me/project', '/home/me/.rivet/sessions/x.jsonl'),
      false,
      'different-home outside-project paths should NOT be blocked',
    )
  })

  it('honours root-anchored patterns (/foo) only at the repo root', () => {
    const filter = new GitignoreFilter('/repo', ['/js'])

    assert.equal(filter.isIgnored('/repo', '/repo/js'), true, 'the anchored dir itself')
    assert.equal(filter.isIgnored('/repo', '/repo/js/bundle.js'), true, 'a file under it')
    assert.equal(
      filter.isIgnored('/repo', '/repo/vendor/js/a.js'),
      false,
      'a same-named dir deeper down must NOT be covered by a root anchor',
    )
  })

  it('expands ** across zero or more directory levels', () => {
    const secrets = new GitignoreFilter('/repo', ['**/secrets.json'])
    assert.equal(secrets.isIgnored('/repo', '/repo/secrets.json'), true, 'zero-depth (root) match')
    assert.equal(secrets.isIgnored('/repo', '/repo/a/b/secrets.json'), true, 'nested match')
    assert.equal(secrets.isIgnored('/repo', '/repo/a/b/config.json'), false)

    const dir = new GitignoreFilter('/repo', ['foo/**'])
    assert.equal(dir.isIgnored('/repo', '/repo/foo/x.js'), true, 'direct child')
    assert.equal(dir.isIgnored('/repo', '/repo/foo/a/b.js'), true, 'deep child')
    assert.equal(dir.isIgnored('/repo', '/repo/bar/a/b.js'), false)
  })

  it('still applies ignore rules to in-tree names starting with two dots', () => {
    const filter = new GitignoreFilter('/repo', ['node_modules'])

    assert.equal(
      filter.isIgnored('/repo', '/repo/..cache/node_modules/a.js'),
      true,
      'a dir literally named "..cache" is inside the tree and stays ignorable',
    )
    // A genuine parent hop is still outside the tree and bypasses gitignore.
    assert.equal(filter.isIgnored('/repo', '/repo/../node_modules/a.js'), false)
  })
})

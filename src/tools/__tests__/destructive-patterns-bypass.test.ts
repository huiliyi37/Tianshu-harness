import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { GIT_CLEAR_RE } from '../destructive-patterns.js'

describe('GIT_CLEAR_RE 绕过', () => {
  const mustMatch = [
    'git -C repo reset --hard',
    'git --no-pager reset --hard HEAD',
    'git -c core.pager=cat clean -fd',
    'git --git-dir .git stash',
    'git --work-tree . reset --hard',
    'git --git-dir=.git stash',
    'cd x&&git reset --hard',
    'cd x;git clean -fd',
    '(git stash)',
    'git restore a.ts',
  ]
  for (const cmd of mustMatch) {
    test(`拦截: ${cmd}`, () => assert.equal(GIT_CLEAR_RE.test(cmd), true))
  }
  const mustNot = [
    'git stash list',
    'git status',
    'echo digit reset --hard',
  ]
  for (const cmd of mustNot) {
    test(`放行: ${cmd}`, () => assert.equal(GIT_CLEAR_RE.test(cmd), false))
  }
})

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { matchesDangerousBash, bashCommandMayWrite, isDestructiveGitAction, normalizeBashCommand } from '../approval-risk.js'

describe('git 全局参数不应绕过审批门', () => {
  const dangerous = [
    'git -C repo reset --hard',
    'git --no-pager reset --hard HEAD',
    'git -c core.pager=cat clean -fd',
    'git --git-dir=.git --work-tree=. checkout -- .',
    'git --git-dir .git stash',
    'git -C a -C b reset --hard',
  ]
  for (const cmd of dangerous) {
    test(`危险: ${cmd}`, () => assert.equal(matchesDangerousBash(cmd), true))
  }
  test('写入判定同样覆盖', () => {
    assert.equal(bashCommandMayWrite('git -C repo commit -m x'), true)
  })
  test('isDestructiveGitAction 覆盖', () => {
    assert.equal(isDestructiveGitAction('bash', { command: 'git -C repo reset HEAD~1' }), true)
  })
  test('只读命令不受影响', () => {
    assert.equal(matchesDangerousBash('git -C repo status'), false)
    assert.equal(matchesDangerousBash('git --no-pager log -5'), false)
    assert.equal(matchesDangerousBash('git stash list'), false)
  })
  test('归一化只剥全局参数，不动子命令参数', () => {
    assert.equal(normalizeBashCommand('git -C repo log --oneline -5'), 'git log --oneline -5')
  })
})

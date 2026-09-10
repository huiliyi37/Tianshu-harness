import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordSkillLoadErrors,
  getSkillLoadErrorsForSession,
  forgetSkillLoadErrors,
} from '../skill-load-errors.js'

test('record → get：按会话记录并读回', () => {
  recordSkillLoadErrors('s1', ['a: 坏 frontmatter', 'b: .claude/skills 里找不到'])
  assert.deepEqual(getSkillLoadErrorsForSession('s1'), ['a: 坏 frontmatter', 'b: .claude/skills 里找不到'])
  assert.deepEqual(getSkillLoadErrorsForSession('unknown'), [], '未知会话返回空数组而非 undefined')
})

test('record 空数组 = 清理：不残留上一轮的错误', () => {
  recordSkillLoadErrors('s2', ['旧错误'])
  recordSkillLoadErrors('s2', [])
  assert.deepEqual(getSkillLoadErrorsForSession('s2'), [])
})

test('record 拷贝入参：调用方后续改数组不影响已记录内容', () => {
  const errors = ['x']
  recordSkillLoadErrors('s3', errors)
  errors.push('y')
  assert.deepEqual(getSkillLoadErrorsForSession('s3'), ['x'])
})

test('forget 后读回空（会话销毁时内存有界）', () => {
  recordSkillLoadErrors('s4', ['z'])
  forgetSkillLoadErrors('s4')
  assert.deepEqual(getSkillLoadErrorsForSession('s4'), [])
})

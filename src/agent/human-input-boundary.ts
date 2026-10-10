import type { AgentLoop } from './loop.js'
import { extractTaskContract, mergeFollowUpIntoContract, type TurnMode } from '../context/task-contract.js'

/** Task identity is explicit human input; follow-up guidance retains verification ownership. */
export function applyHumanInputBoundary(self: AgentLoop, turnMode: TurnMode, userInput: string): void {
    if (turnMode === 'task' && self.activeInputOrigin === 'human') {
      self.taskContract = extractTaskContract(userInput, self.session.getTurnCount())
      // 证据义务任务边界：上一个用户任务的未决义务全部作废（satisfied 历史
      // 保留），latch 清空——新任务从干净的义务面开始。
      self.obligations.supersedeOpen()
      // 策略周期边界（§3）：人类新任务开启新周期——周期内此前见过的策略族重新
      // 变「新」（不沦为会话终身集合），但周期起点时的当前动作继承为基线
      // （重置本身不得制造新族）。纯只读审查任务同样算边界——不要求文件/Todo/
      // 验证变化。非 human 来源（runtime_command/hook/compact/自动继续）不续期。
      self.courseEpisodes.start('human-task')
      self.workFacts.acceptHumanConstraints(userInput, true)
    } else if (turnMode === 'followUp' && self.activeInputOrigin === 'human') {
      // 同任务的人工 followUp：保留任务归属，只推进引导边界——此前「同一条失败
      // 验证反复重跑」的假采纳不该因为用户补了一句话而被洗白。
      self.courseEpisodes.start('human-guidance')
      self.workFacts.acceptHumanConstraints(userInput)
      // P5: inherit the active contract, but fold in any new constraints/files
      // from this follow-up (multi-line corrections whose constraint sits past
      // the first line are classified followUp yet must reach the task-anchor).
      if (self.taskContract) {
        self.taskContract = mergeFollowUpIntoContract(
          self.taskContract,
          userInput,
          self.session.getTurnCount(),
        )
      }
    } else if (!self.taskContract || self.taskContract.status === 'ready_to_deliver') {
      self.taskContract = undefined
    }

}

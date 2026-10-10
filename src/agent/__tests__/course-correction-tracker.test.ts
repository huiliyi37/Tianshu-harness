import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CourseCorrectionTracker, courseFamily } from '../course-correction-tracker.js'

const ev = (turn: number, name: string, target = '', extra: Record<string, unknown> = {}) =>
  ({ turn, name, target, isError: false, ...extra })

/** 计划 §3「核销周期」矩阵：策略新颖性跨核销窗口存续。 */
describe('CourseCorrectionTracker — 周期内新族才是改道', () => {
  it('投递后同周期首次出现的新族 → 满足；同族重来不再满足', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'read_file', 'a.ts'))
    t.deliver('d1')
    t.observe(ev(2, 'edit_file', 'a.ts'))
    assert.equal(t.satisfies('d1'), true, 'edit 族在投递后首次出现 → 改道成立')

    t.observe(ev(3, 'read_file', 'b.ts'))
    t.deliver('d2')
    t.observe(ev(4, 'read_file', 'c.ts'))
    assert.equal(t.satisfies('d2'), false, 'read 族已在基线内 → 换文件不算改道')
  })

  it('投递前已见的族不因再次出现而满足（基线不可变）', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'bash', 'npm test', { verificationAttempted: true }))
    t.deliver('d1')
    t.observe(ev(2, 'bash', 'npm test', { verificationAttempted: true }))
    assert.equal(t.satisfies('d1'), false, 'verify 族在投递前已见')
  })

  it('六周期「读三轮 → 同一失败 npm test」：至多首次核销，不再每周期假采纳', () => {
    const t = new CourseCorrectionTracker()
    let adopted = 0
    for (let cycle = 0; cycle < 6; cycle++) {
      const base = cycle * 6 + 1
      t.observe(ev(base, 'read_file', `m${base}.ts`))
      t.observe(ev(base + 1, 'read_file', `l${base}.ts`))
      t.observe(ev(base + 2, 'bash', `sed -n 1,40p s${base}.sh`, { readonlyShell: true }))
      const id = `cycle-${cycle}`
      t.deliver(id)
      t.observe(ev(base + 3, 'bash', 'npm test -- --test-name-pattern=foo', { verificationAttempted: true }))
      if (t.satisfies(id)) adopted++
    }
    assert.equal(adopted, 1, `同一失败验证重复六周期只应首次核销，得 ${adopted} —— 这正是回归的形态`)
  })

  it('同族换文件、只读 bash 换 read_file → 都不算改道', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'read_file', 'a.ts'))
    t.deliver('d1')
    t.observe(ev(2, 'read_file', 'a.ts'))
    assert.equal(t.satisfies('d1'), false)

    const t2 = new CourseCorrectionTracker()
    t2.observe(ev(1, 'bash', 'sed -n 1,20p x.sh', { readonlyShell: true }))
    t2.deliver('d2')
    t2.observe(ev(2, 'read_file', 'b.ts'))
    assert.equal(t2.satisfies('d2'), false, '只读侦察换外衣（bash→read_file）不算改道')
  })

  it('新周期继承当前动作作为基线——重置本身不制造新族', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'read_file', 'a.ts'))
    t.deliver('d1')
    t.startEpisode('human-task')
    t.observe(ev(2, 'read_file', 'b.ts'))
    assert.equal(t.satisfies('d1'), false, '跨周期投递不核销（旧提醒已被进展替代）')

    t.deliver('d2')
    t.observe(ev(3, 'read_file', 'c.ts'))
    assert.equal(t.satisfies('d2'), false, '新周期起点已见的 read 族不得算新策略')
  })

  it('新周期里此前见过的族重新变新（不沦为会话终身集合）', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'bash', 'npm test', { verificationAttempted: true }))
    t.observe(ev(2, 'read_file', 'a.ts')) // 周期起点时的「当前动作」= read
    t.startEpisode('human-task')
    t.deliver('d1')
    t.observe(ev(3, 'bash', 'npm test', { verificationAttempted: true }))
    assert.equal(t.satisfies('d1'), true, '新任务下再次尝试验证是合理改道，不能终身封住')
  })

  it('同一轮内按事件序号判先后：先投递后工具算改道，先工具后投递不算', () => {
    const t = new CourseCorrectionTracker()
    t.deliver('early')
    t.observe(ev(5, 'edit_file', 'a.ts'))
    assert.equal(t.satisfies('early'), true)

    t.observe(ev(5, 'run_tests', 'a.test.ts'))
    t.deliver('late')
    assert.equal(t.satisfies('late'), false, '投递前一刻已跑的验证不算它促成的改道')
  })

  it('无投递基线记录时保守返回 false（不凭观察窗猜）', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'edit_file', 'a.ts'))
    assert.equal(t.satisfies('never-delivered'), false)
  })

  it('自愈判定 sawNovelFamilySince：对照周期内累积，不是滚动三轮窗口', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'read_file', 'a.ts'))
    t.observe(ev(2, 'read_file', 'b.ts'))
    assert.equal(t.sawNovelFamilySince(2), false, '窗口内只有已见族')
    t.observe(ev(3, 'edit_file', 'a.ts'))
    assert.equal(t.sawNovelFamilySince(2), true)
    assert.equal(t.sawNovelFamilySince(4), false, '起点之后无事件')
  })

  it('reset 清空周期与族集合', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'edit_file', 'a.ts'))
    assert.equal(t.seenFamilies.size, 1)
    t.reset()
    assert.equal(t.seenFamilies.size, 0)
    assert.equal(t.episode, 0)
  })
})

describe('courseFamily — 稳定工具名归族（不吃自由文本）', () => {
  it('读/写/验证族按表归并，只读 shell 与 read 同族', () => {
    assert.equal(courseFamily(ev(1, 'read_file', 'a.ts')), 'read')
    assert.equal(courseFamily(ev(1, 'grep', 'x')), 'read')
    assert.equal(courseFamily(ev(1, 'edit_file', 'a.ts')), 'edit')
    assert.equal(courseFamily(ev(1, 'run_tests', 'x')), 'verify')
    assert.equal(courseFamily(ev(1, 'bash', 'npm test', { verificationAttempted: true })), 'verify')
    assert.equal(courseFamily(ev(1, 'bash', 'sed -n 1,20p x.sh', { readonlyShell: true })), 'read')
    assert.equal(courseFamily(ev(1, 'bash', 'git commit -m x')), 'bash')
  })

  it('未知工具以稳定工具名为族——不拿 target 自由文本生成新族', () => {
    const a = courseFamily(ev(1, 'some_new_tool', 'x.ts'))
    const b = courseFamily(ev(2, 'some_new_tool', 'y.ts'))
    assert.equal(a, 'some_new_tool')
    assert.equal(a, b, '同工具不同 target 必须同族')
  })
})

describe('novelty facts survive history retention and respect episodes', () => {
  it('new episode recognizes a formerly seen family and never treats its inherited action as novel', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'run_tests'))
    t.observe(ev(2, 'read_file'))
    t.startEpisode('human-task')
    t.observe(ev(3, 'read_file'))
    assert.equal(t.sawNovelFamilySince(3), false)
    t.deliver('new')
    t.observe(ev(4, 'run_tests'))
    assert.equal(t.satisfies('new'), true)
    assert.equal(t.sawNovelFamilySince(4), true)
  })
  it('evicting observations cannot turn repeated families into novelty or erase a real adoption', () => {
    const t = new CourseCorrectionTracker()
    t.observe(ev(1, 'read_file'))
    t.deliver('d')
    t.observe(ev(2, 'run_tests'))
    for (let turn = 3; turn < 600; turn++) t.observe(ev(turn, 'read_file'))
    assert.equal(t.satisfies('d'), true)
    assert.equal(t.sawNovelFamilySince(590), false)
  })
})

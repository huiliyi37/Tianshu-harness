import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTraceStore,
  startTraceEvent,
  finishTraceEvent,
  recordTraceEvent,
  getDoomLoopLevel,
  getClassDoomLoopLevel,
  combineDoomLoopLevels,
  offendingFingerprints,
  getToolStormLevel,
  fingerprintToolCall,
  fingerprintToolClass,
  bashCommandClass,
  recordToolFingerprint,
  recordToolNamedFingerprint,
  getDoomLoopThresholds,
  NORMAL_DOOM_THRESHOLDS,
  GOAL_DOOM_THRESHOLDS,
  type TraceEvent,
  type TraceEventStartInput,
} from '../trace-store.js'

describe('trace-store', () => {
  it('records a running event and finishes it with duration', () => {
    let store = createTraceStore(10)
    store = startTraceEvent(store, {
      id: 'tool-1',
      turn: 3,
      kind: 'tool',
      name: 'run_tests',
      startedAt: 1000,
      summary: 'npm test',
    })

    assert.equal(store.events.length, 1)
    assert.equal(store.events[0]!.status, 'running')

    store = finishTraceEvent(store, 'tool-1', {
      status: 'failed',
      endedAt: 1250,
      rawPath: '/tmp/rivet-raw/x.raw',
    })

    assert.equal(store.events[0]!.status, 'failed')
    assert.equal(store.events[0]!.durationMs, 250)
    assert.equal(store.events[0]!.rawPath, '/tmp/rivet-raw/x.raw')
  })

  it('does not allow completion fields when starting an event', () => {
    const input = {
      id: 'tool-1',
      turn: 3,
      kind: 'tool',
      name: 'run_tests',
      startedAt: 1000,
    } satisfies TraceEventStartInput

    assert.equal(input.startedAt, 1000)
  })

  it('caps events to the configured maximum', () => {
    let store = createTraceStore(2)
    const event = (id: string): TraceEvent => ({
      id,
      turn: 1,
      kind: 'tool',
      name: id,
      status: 'passed',
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    })

    store = recordTraceEvent(store, event('a'))
    store = recordTraceEvent(store, event('b'))
    store = recordTraceEvent(store, event('c'))

    assert.deepEqual(store.events.map(e => e.id), ['b', 'c'])
  })

  it('detects repeated tool call fingerprints with consecutive and window strategies', () => {
    const fp = fingerprintToolCall('read_file', { file_path: 'src/a.ts' }, 'passed')
    const fpB = fingerprintToolCall('write_file', { file_path: 'src/b.ts' }, 'passed')

    // Normal mode thresholds: warnConsec=3, blockConsec=5, warnFreq=5, blockFreq=7
    const nt = NORMAL_DOOM_THRESHOLDS.exact

    // 3 consecutive (2 repeats) → none (below warnConsec=3)
    assert.equal(getDoomLoopLevel([fp, fp, fp], nt), 'none')
    // 4 consecutive (3 repeats) → warn
    assert.equal(getDoomLoopLevel([fp, fp, fp, fp], nt), 'warn')
    // 5 consecutive (4 repeats) → still warn (need 6 for blocked)
    assert.equal(getDoomLoopLevel([fp, fp, fp, fp, fp], nt), 'warn')
    // 6 consecutive (5 repeats) → blocked
    assert.equal(getDoomLoopLevel([fp, fp, fp, fp, fp, fp], nt), 'blocked')

    // Normal iteration: alternating tools → ok
    assert.equal(getDoomLoopLevel([fp, fpB, fp, fpB, fp], nt), 'none')
  })

  it('marks repeated failed tool fingerprints with consecutive-only doom loop', () => {
    let store = createTraceStore()
    const fp = fingerprintToolCall('bash', { command: 'npm test' }, 'error')
    // 4 entries → 3 consecutive → warn (warnConsec=3)
    store = recordToolFingerprint(store, fp)
    store = recordToolFingerprint(store, fp)
    store = recordToolFingerprint(store, fp)
    store = recordToolFingerprint(store, fp)
    assert.equal(getDoomLoopLevel(store.toolFingerprints), 'warn')

    // 6 entries → 5 consecutive → blocked (blockConsec=5)
    store = recordToolFingerprint(store, fp)
    assert.equal(getDoomLoopLevel(store.toolFingerprints), 'warn')
    store = recordToolFingerprint(store, fp)
    assert.equal(getDoomLoopLevel(store.toolFingerprints), 'blocked')
  })
})

describe('getToolStormLevel', () => {
  it('returns none for fewer than 4 tool calls', () => {
    assert.equal(getToolStormLevel(['grep', 'grep', 'grep']), 'none')
  })

  it('returns warn for 4 consecutive same-type calls', () => {
    assert.equal(getToolStormLevel(['grep', 'grep', 'grep', 'grep']), 'warn')
  })

  it('returns warn for 5-7 consecutive same-type calls', () => {
    assert.equal(getToolStormLevel(['grep', 'grep', 'grep', 'grep', 'grep']), 'warn')
    assert.equal(getToolStormLevel(Array(7).fill('grep')), 'warn')
  })

  it('returns storm for 8+ consecutive same-type calls', () => {
    assert.equal(getToolStormLevel(Array(8).fill('grep')), 'storm')
  })

  it('returns none when tool types alternate', () => {
    assert.equal(getToolStormLevel(['grep', 'read_file', 'grep', 'read_file']), 'none')
  })

  it('detects storm with different fingerprints but same tool type', () => {
    const names = Array(10).fill('grep')
    assert.equal(getToolStormLevel(names), 'storm')
  })

  it('resets consecutive count on tool type change', () => {
    const names = ['grep', 'grep', 'grep', 'read_file', 'grep', 'grep', 'grep']
    assert.equal(getToolStormLevel(names), 'none')
  })

  it('only considers the last 12 entries', () => {
    const old = Array(20).fill('read_file')
    const spacer = ['grep', 'bash', 'read_file', 'write_file', 'grep', 'bash',
      'read_file', 'write_file', 'grep', 'bash', 'read_file', 'write_file', 'grep']
    assert.equal(getToolStormLevel([...old, ...spacer]), 'none')
  })
})

describe('recordToolNamedFingerprint', () => {
  it('records both fingerprint and tool name', () => {
    let store = createTraceStore()
    store = recordToolNamedFingerprint(store, 'fp1', 'grep')
    store = recordToolNamedFingerprint(store, 'fp2', 'grep')
    assert.deepEqual(store.toolFingerprints, ['fp1', 'fp2'])
    assert.deepEqual(store.toolNameHistory, ['grep', 'grep'])
  })

  it('caps tool name history to 20', () => {
    let store = createTraceStore()
    for (let i = 0; i < 25; i++) {
      store = recordToolNamedFingerprint(store, `fp${i}`, `tool${i}`)
    }
    assert.equal(store.toolNameHistory!.length, 20)
    assert.equal(store.toolNameHistory![0], 'tool5')
    assert.equal(store.toolNameHistory![19], 'tool24')
  })
})

describe('bashCommandClass', () => {
  it('merges git status pipe variants into one class', () => {
    assert.equal(bashCommandClass('git status --porcelain'), 'git:status')
    assert.equal(bashCommandClass('git status --porcelain | sed -n 1,50p'), 'git:status')
    assert.equal(bashCommandClass('git status --porcelain | head -100'), 'git:status')
    assert.equal(bashCommandClass('git status --porcelain | tee /tmp/s.txt'), 'git:status')
    assert.equal(bashCommandClass('git status --porcelain > /tmp/out && cat /tmp/out'), 'git:status')
  })

  it('detects git embedded after other binaries (cd, env vars)', () => {
    assert.equal(bashCommandClass('cd /repo && git log --oneline'), 'git:log')
    assert.equal(bashCommandClass('GIT_PAGER=cat git diff --stat'), 'git:diff')
  })

  it('distinguishes git subcommands', () => {
    assert.notEqual(bashCommandClass('git status'), bashCommandClass('git add -A'))
    assert.notEqual(bashCommandClass('git log'), bashCommandClass('git commit -m x'))
  })

  it('includes subcommand for known multi-sub binaries', () => {
    assert.equal(bashCommandClass('npm test'), 'npm:test')
    assert.equal(bashCommandClass('npm run build'), 'npm:run')
    assert.notEqual(bashCommandClass('npm test'), bashCommandClass('npm install'))
  })

  it('falls back to binary name for plain commands', () => {
    assert.equal(bashCommandClass('ls -la src'), 'ls')
    assert.equal(bashCommandClass('/usr/bin/python3 script.py'), 'python3')
    assert.equal(bashCommandClass(''), 'empty')
  })

  it('skips leading env assignments', () => {
    assert.equal(bashCommandClass('NODE_ENV=test npx tsx --test foo.ts'), 'npx:tsx')
  })
})

describe('fingerprintToolClass', () => {
  it('returns class fingerprint only for failing bash commands', () => {
    // Successful bash = normal exploration, no class fingerprint
    assert.equal(fingerprintToolClass('bash', { command: 'git status | head' }, 'success'), null)
    // Failing bash = potential doom loop, class fingerprint recorded
    assert.equal(fingerprintToolClass('bash', { command: 'git push --force' }, 'error'), 'git:push·error')
  })

  it('returns null for non-bash tools', () => {
    assert.equal(fingerprintToolClass('read_file', { path: '/a.ts' }, 'success'), null)
    assert.equal(fingerprintToolClass('grep', { pattern: 'x' }, 'error'), null)
  })
})

describe('recordToolFingerprint with class fingerprint', () => {
  it('records class fingerprint alongside exact fingerprint', () => {
    let store = createTraceStore()
    store = recordToolFingerprint(store, 'fp1', 'git:status·success')
    store = recordToolFingerprint(store, 'fp2', null)
    assert.deepEqual(store.toolFingerprints, ['fp1', 'fp2'])
    assert.deepEqual(store.bashClassFingerprints, ['git:status·success'])
  })

  it('caps class fingerprints to 20', () => {
    let store = createTraceStore()
    for (let i = 0; i < 25; i++) {
      store = recordToolFingerprint(store, `fp${i}`, `class${i}`)
    }
    assert.equal(store.bashClassFingerprints!.length, 20)
  })
})

describe('getClassDoomLoopLevel', () => {
  const nt = NORMAL_DOOM_THRESHOLDS.class

  it('returns none for varied command classes', () => {
    assert.equal(getClassDoomLoopLevel(['git:status·success', 'npm:test·success', 'rg·success', 'ls·success']), 'none')
  })

  it('warns on 7th consecutive same-class call (sed/head/tee variants merged)', () => {
    assert.equal(getClassDoomLoopLevel(Array(7).fill('git:status·success'), nt), 'warn')
  })

  it('blocks on 10th consecutive same-class call', () => {
    assert.equal(getClassDoomLoopLevel(Array(10).fill('git:status·success'), nt), 'blocked')
  })

  it('does not flag 6 consecutive same-class calls (legit iteration headroom)', () => {
    assert.equal(getClassDoomLoopLevel(Array(6).fill('rg·success'), nt), 'none')
  })

  it('blocks when one class dominates the window even non-consecutively', () => {
    // 10/12 same class → blockFreq=10 met (window=12)
    const fps = ['git:status·success', 'ls·success', 'git:status·success', 'git:status·success',
      'git:status·success', 'git:status·success', 'git:status·success', 'git:status·success',
      'git:status·success', 'git:status·success', 'git:status·success', 'git:status·success']
    assert.equal(getClassDoomLoopLevel(fps, nt), 'blocked')
  })
})

describe('combineDoomLoopLevels', () => {
  it('returns the strictest level', () => {
    assert.equal(combineDoomLoopLevels('none', 'warn'), 'warn')
    assert.equal(combineDoomLoopLevels('blocked', 'warn'), 'blocked')
    assert.equal(combineDoomLoopLevels('none', 'none'), 'none')
    assert.equal(combineDoomLoopLevels('warn', 'blocked'), 'blocked')
  })
})

describe('offendingFingerprints', () => {
  it('returns empty when nothing is looping', () => {
    assert.equal(offendingFingerprints(['a', 'b', 'c', 'a', 'b']).size, 0)
  })

  it('flags a fingerprint repeated to the frequency threshold (6+ in window)', () => {
    // 6 of 'x' in an 8-window → 'x' is the offender, 'y' is not.
    const offenders = offendingFingerprints(['x', 'x', 'x', 'y', 'x', 'x', 'y', 'x'])
    assert.ok(offenders.has('x'))
    assert.ok(!offenders.has('y'))
  })

  it('flags a fingerprint repeated consecutively to threshold (4 identical)', () => {
    const offenders = offendingFingerprints(['a', 'b', 'x', 'x', 'x', 'x'])
    assert.ok(offenders.has('x'))
    assert.ok(!offenders.has('a'))
    assert.ok(!offenders.has('b'))
  })

  it('isolates the offender so a different call would not match (deadlock fix)', () => {
    // The bug: hitting blocked blocked every tool. The fix blocks only the
    // looping fingerprint, so a fresh tool's fingerprint is absent here and
    // would be allowed through to refresh the window.
    const looping = Array(6).fill('loop-fp')
    const offenders = offendingFingerprints(looping)
    assert.ok(offenders.has('loop-fp'))
    assert.ok(!offenders.has('some-other-tool-fp'))
  })

  it('honors custom class-level thresholds (window 10, freq 8, consec 6)', () => {
    // Below class thresholds → no offender.
    assert.equal(offendingFingerprints(Array(5).fill('c'), 10, 8, 6).size, 0)
    // 7 consecutive identical (consec run of 6 repeats) → offender.
    assert.ok(offendingFingerprints(Array(7).fill('c'), 10, 8, 6).has('c'))
  })
})

describe('goal-aware doom-loop thresholds', () => {
  it('normal mode warns earlier than goal mode', () => {
    const fp = fingerprintToolCall('bash', { command: 'grep foo' }, 'error')
    // 4 identical (maxConsec=3) → normal warns (warnConsec=3), goal none (warnConsec=3, need 4+)
    const four = [fp, fp, fp, fp]
    assert.equal(getDoomLoopLevel(four, NORMAL_DOOM_THRESHOLDS.exact), 'warn')
    assert.equal(getDoomLoopLevel(four, GOAL_DOOM_THRESHOLDS.exact), 'warn')
  })

  it('goal mode requires more repetitions to block', () => {
    const fp = fingerprintToolCall('bash', { command: 'grep foo' }, 'error')
    // 6 identical (maxConsec=5) → normal blocked (blockConsec=5), goal warn (blockConsec=6)
    const six = Array(6).fill(fp)
    assert.equal(getDoomLoopLevel(six, NORMAL_DOOM_THRESHOLDS.exact), 'blocked')
    assert.equal(getDoomLoopLevel(six, GOAL_DOOM_THRESHOLDS.exact), 'warn')
    // 7 identical (maxConsec=6) → goal blocked
    const seven = Array(7).fill(fp)
    assert.equal(getDoomLoopLevel(seven, GOAL_DOOM_THRESHOLDS.exact), 'blocked')
  })

  it('goal mode class thresholds are more lenient', () => {
    const cf = 'git:status·success'
    // 7 same class → normal warn (warnConsec=6 met), goal none (warnConsec=7)
    assert.equal(getClassDoomLoopLevel(Array(7).fill(cf), NORMAL_DOOM_THRESHOLDS.class), 'warn')
    assert.equal(getClassDoomLoopLevel(Array(7).fill(cf), GOAL_DOOM_THRESHOLDS.class), 'none')
    // 11 same class → goal warn (warnConsec=7), goal blocked at blockConsec=10
    assert.equal(getClassDoomLoopLevel(Array(11).fill(cf), GOAL_DOOM_THRESHOLDS.class), 'blocked')
  })

  it('getDoomLoopThresholds switches by goalActive flag', () => {
    assert.equal(getDoomLoopThresholds(false), NORMAL_DOOM_THRESHOLDS)
    assert.equal(getDoomLoopThresholds(true), GOAL_DOOM_THRESHOLDS)
  })
})

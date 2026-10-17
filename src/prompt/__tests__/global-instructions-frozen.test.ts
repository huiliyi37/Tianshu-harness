import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildStableVolatileBlock,
} from '../volatile.js'
import { FROZEN_BLOCK_CAPS } from '../block-policy.js'
import { loadUserInstructionsBlock } from '../../config/user-instructions.js'

type StableVolatileContext = Parameters<typeof buildStableVolatileBlock>[0]

function makeBaseContext(): StableVolatileContext {
  return {
    cwd: process.cwd(),
    blockCaps: undefined,
    blockToggles: undefined,
    cwdRelation: undefined,
    rivetMd: undefined,
    gitStatus: undefined,
    workingSet: undefined,
    activeDomain: undefined,
    sessionMemoryBlock: undefined,
    projectMemoryBlock: undefined,
    knowledgeManifestBlock: undefined,
    seedCapsuleBlock: undefined,
    projectIndexBlock: undefined,
  } as StableVolatileContext
}

describe('global instructions in the frozen volatile block', () => {
  it('is byte-for-byte unchanged when global instructions are not configured', () => {
    const base = makeBaseContext()
    const withoutKey = buildStableVolatileBlock(base)
    const withUndefined = buildStableVolatileBlock({
      ...base,
      globalInstructionsBlock: undefined,
    } as StableVolatileContext)

    assert.equal(withoutKey, withUndefined)
    assert.equal(withoutKey.includes('<global-instructions>'), false)
  })

  it('renders global instructions before project instructions', () => {
    const output = buildStableVolatileBlock({
      ...makeBaseContext(),
      rivetMd: '# Project instructions',
      globalInstructionsBlock: 'Global instructions',
    } as StableVolatileContext)

    const globalIndex = output.indexOf('<global-instructions>')
    const projectIndex = output.indexOf('<project-instructions>')

    assert.notEqual(globalIndex, -1)
    assert.notEqual(projectIndex, -1)
    assert.ok(globalIndex < projectIndex)
  })

  it('renders global and project instructions as independent parts', () => {
    const output = buildStableVolatileBlock({
      ...makeBaseContext(),
      rivetMd: '# Project instructions',
      globalInstructionsBlock: 'Global instructions',
    } as StableVolatileContext)

    const globalEnd = output.indexOf('</global-instructions>')
    const projectStart = output.indexOf('<project-instructions>')

    assert.ok(globalEnd >= 0)
    assert.ok(projectStart > globalEnd)

    const between = output.slice(
      globalEnd + '</global-instructions>'.length,
      projectStart,
    )
    assert.equal(between, '\n\n')
  })

  it('preserves markdown tables inside the global instructions block', () => {
    const globalTable = '| a | b |\n| - | - |\n| 1 | 2 |'
    const projectTable = '| project | table |\n| - | - |\n| p | q |'

    const output = buildStableVolatileBlock({
      ...makeBaseContext(),
      rivetMd: `Project text\n\n${projectTable}\n\nMore project text`,
      globalInstructionsBlock: `Global text\n\n${globalTable}`,
      projectIndexBlock: 'x',
    } as StableVolatileContext)

    assert.ok(output.includes(globalTable))
  })

  it('escapes XML-sensitive characters in global instructions', () => {
    const output = buildStableVolatileBlock({
      ...makeBaseContext(),
      globalInstructionsBlock: 'a & b < c > d "quoted"',
    } as StableVolatileContext)

    assert.ok(output.includes('&amp;'))
    assert.ok(output.includes('&lt;'))
    assert.ok(output.includes('&gt;'))
    assert.ok(output.includes('&quot;'))
    // 作用域必须收窄到全局段：其余块（如 shell-note）本就含字面 && 等未转义文本，
    // 对整段输出跑这个正则必然误报。
    const start = output.indexOf('<global-instructions>')
    const end = output.indexOf('</global-instructions>')
    assert.ok(start >= 0 && end > start, 'global instructions block must be present')
    const segment = output.slice(start, end)
    assert.equal(
      segment.match(/&(?!(amp|lt|gt|quot|#)\w*;)/),
      null,
    )
  })

  it('truncates an oversized global block and lets it consume the project budget', () => {
    const output = buildStableVolatileBlock({
      ...makeBaseContext(),
      rivetMd: 'Project instructions',
      globalInstructionsBlock: 'g'.repeat(20_000),
    } as StableVolatileContext)

    assert.ok(output.includes('<global-instructions>'))
    assert.equal(output.includes('<project-instructions>'), false)
    assert.ok(output.includes('truncated'))
  })

  it('truncates escaped global instructions without malformed entities', () => {
    const output = buildStableVolatileBlock({
      ...makeBaseContext(),
      globalInstructionsBlock: '&'.repeat(6000),
    } as StableVolatileContext)
    const start = output.indexOf('<global-instructions>')
    const end = output.indexOf('</global-instructions>')
    assert.ok(start >= 0 && end > start, 'global instructions block must be present')
    const segment = output.slice(start, end)
    assert.ok(segment.includes('truncated'))
    assert.equal(
      segment.match(/&(?!(amp|lt|gt|quot|#)\w*;)/),
      null,
    )
  })

  it('keeps the global and project blocks within the shared cap', () => {
    // The headed prefix is selectable without fallback. The final section is
    // 6 chars (8 with its 2-char join), so only a missing partsGap can fit it.
    const projectSections = Array.from(
      { length: 59 },
      (_, index) => `## Section ${index}\n${'p'.repeat(100)}`,
    )
    const projectPrefix = projectSections.join('\n\n')
    const projectMd = [
      `${projectPrefix}${'p'.repeat(6900 - projectPrefix.length)}`,
      '## z\na',
    ].join('\n\n')
    assert.equal(projectMd.length, 6908)

    const output = buildStableVolatileBlock({
      ...makeBaseContext(),
      rivetMd: projectMd,
      globalInstructionsBlock: 'g'.repeat(1000),
    } as StableVolatileContext)
    const globalStart = output.indexOf('<global-instructions>')
    const globalEnd = output.indexOf('</global-instructions>')
    const projectStart = output.indexOf('<project-instructions>')
    const projectEnd = output.indexOf('</project-instructions>', projectStart)
    assert.ok(globalStart >= 0 && globalEnd > globalStart)
    assert.ok(projectStart > globalEnd && projectEnd > projectStart)
    const globalBlock = output.slice(
      globalStart,
      globalEnd + '</global-instructions>'.length,
    )
    const projectBlock = output.slice(
      projectStart,
      projectEnd + '</project-instructions>'.length,
    )
    const partsGap = output.slice(
      globalEnd + '</global-instructions>'.length,
      projectStart,
    )
    assert.equal(partsGap, '\n\n')
    assert.equal(projectBlock.includes('truncated'), false)
    assert.ok(
      globalBlock.length + 2 + projectBlock.length
        <= FROZEN_BLOCK_CAPS.projectInstructions,
    )
  })

  it('preserves a short global block when the project block is large', () => {
    const output = buildStableVolatileBlock({
      ...makeBaseContext(),
      rivetMd: 'p'.repeat(7000),
      globalInstructionsBlock: 'g'.repeat(30),
    } as StableVolatileContext)
    const globalStart = output.indexOf('<global-instructions>')
    const globalEnd = output.indexOf('</global-instructions>')
    const projectStart = output.indexOf('<project-instructions>')
    assert.ok(globalStart >= 0 && globalEnd > globalStart && projectStart > globalEnd)
    const globalBlock = output.slice(
      globalStart,
      globalEnd + '</global-instructions>'.length,
    )
    assert.ok(globalBlock.includes('g'.repeat(30)))
    assert.equal(globalBlock.includes('truncated'), false)
  })

  it('drops an oversized file through the real loader path', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-global-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      const instructionsPath = join(home, 'instructions.md')
      writeFileSync(
        instructionsPath,
        'x'.repeat(FROZEN_BLOCK_CAPS.projectInstructions + 1),
        'utf8',
      )
      writeFileSync(
        configPath,
        JSON.stringify({
          agent: {
            userInstructions: {
              enabled: true,
              path: instructionsPath,
            },
          },
        }),
        'utf8',
      )

      const previousHome = process.env.RIVET_HOME
      const previousConfigPath = process.env.RIVET_CONFIG_PATH
      try {
        process.env.RIVET_HOME = home
        process.env.RIVET_CONFIG_PATH = configPath
        const loaded = loadUserInstructionsBlock()
        assert.equal(loaded, undefined)
        const output = buildStableVolatileBlock({
          ...makeBaseContext(),
          globalInstructionsBlock: loaded,
        } as StableVolatileContext)
        assert.equal(output.includes('<global-instructions>'), false)
      } finally {
        if (previousHome === undefined) {
          delete process.env.RIVET_HOME
        } else {
          process.env.RIVET_HOME = previousHome
        }
        if (previousConfigPath === undefined) {
          delete process.env.RIVET_CONFIG_PATH
        } else {
          process.env.RIVET_CONFIG_PATH = previousConfigPath
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

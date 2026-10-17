import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadUserInstructionsBlock } from '../user-instructions.js'
import { FROZEN_BLOCK_CAPS } from '../../prompt/block-policy.js'

function withConfigEnvironment<T>(
  home: string,
  configPath: string,
  callback: () => T,
): T {
  const previousHome = process.env.RIVET_HOME
  const previousConfigPath = process.env.RIVET_CONFIG_PATH

  process.env.RIVET_HOME = home
  process.env.RIVET_CONFIG_PATH = configPath

  try {
    return callback()
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
}

function writeConfig(configPath: string, value: unknown): void {
  writeFileSync(configPath, JSON.stringify(value), 'utf8')
}

function userConfig(
  enabled: boolean,
  path?: string,
): { agent: { userInstructions: { enabled: boolean; path?: string } } } {
  return {
    agent: {
      userInstructions: path === undefined
        ? { enabled }
        : { enabled, path },
    },
  }
}

describe('loadUserInstructionsBlock', () => {
  it('returns undefined when the global config file does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'missing-config.json')
      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns undefined when enabled is missing or false', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')

      writeConfig(configPath, { agent: { userInstructions: {} } })
      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)

      writeConfig(configPath, userConfig(false))
      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns undefined without throwing when enabled is true but path is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      writeConfig(configPath, userConfig(true))

      assert.doesNotThrow(() => {
        assert.equal(withConfigEnvironment(home, configPath, () => (
          loadUserInstructionsBlock()
        )), undefined)
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns undefined when path is relative', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      writeConfig(configPath, userConfig(true, 'instructions.md'))

      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns undefined when path is outside rivetHome()', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    const outside = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-outside-'))
    try {
      const configPath = join(home, 'config.json')
      const instructionsPath = join(outside, 'instructions.md')
      writeFileSync(instructionsPath, 'outside', 'utf8')
      writeConfig(configPath, userConfig(true, instructionsPath))

      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('returns undefined when path points to a directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      const directoryPath = join(home, 'instructions')
      mkdirSync(directoryPath)
      writeConfig(configPath, userConfig(true, directoryPath))

      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('accepts a file inside a junction configured as RIVET_HOME', t => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    const target = join(root, 'target')
    const linkPath = join(root, 'home-link')
    try {
      mkdirSync(target)
      try {
        symlinkSync(target, linkPath, 'junction')
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'EPERM' || error.code === 'EEXIST')
        ) {
          t.skip(`junction creation is unavailable (${String(error.code)})`)
          return
        }
        throw error
      }

      const configPath = join(linkPath, 'config.json')
      const instructionsPath = join(linkPath, 'instructions.md')
      writeFileSync(instructionsPath, 'inside junction home', 'utf8')
      writeConfig(configPath, userConfig(true, instructionsPath))
      assert.equal(withConfigEnvironment(linkPath, configPath, () => (
        loadUserInstructionsBlock()
      )), 'inside junction home')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a symlink that escapes rivetHome()', t => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    const outside = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-outside-'))
    const escaped = join(home, 'escaped')
    const instructionsPath = join(outside, 'instructions.md')
    try {
      writeFileSync(instructionsPath, 'outside', 'utf8')
      try {
        symlinkSync(outside, escaped, 'junction')
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'EPERM' || error.code === 'EEXIST')
        ) {
          t.skip(`junction creation is unavailable (${String(error.code)})`)
          return
        }
        throw error
      }

      const configPath = join(home, 'config.json')
      const linkedInstructionsPath = join(escaped, 'instructions.md')
      writeConfig(configPath, userConfig(true, linkedInstructionsPath))
      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('returns the contents of a valid file', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      const instructionsPath = join(home, 'instructions.md')
      writeFileSync(instructionsPath, 'use the project conventions', 'utf8')
      writeConfig(configPath, userConfig(true, instructionsPath))

      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), 'use the project conventions')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('removes a UTF-8 BOM from the returned value', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      const instructionsPath = join(home, 'instructions.md')
      writeFileSync(
        instructionsPath,
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('instructions with bom', 'utf8'),
        ]),
      )
      writeConfig(configPath, userConfig(true, instructionsPath))

      const result = withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      ))
      assert.equal(result, 'instructions with bom')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('normalizes CRLF line endings to LF', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      const instructionsPath = join(home, 'instructions.md')
      writeFileSync(instructionsPath, 'first\r\nsecond\r\n', 'utf8')
      writeConfig(configPath, userConfig(true, instructionsPath))

      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), 'first\nsecond')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns undefined for invalid UTF-8 bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      const instructionsPath = join(home, 'instructions.md')
      writeFileSync(instructionsPath, Buffer.from([0xff, 0xfe, 0xfd]))
      writeConfig(configPath, userConfig(true, instructionsPath))

      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns undefined when the file exceeds the project instruction cap', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      const instructionsPath = join(home, 'instructions.md')
      writeFileSync(
        instructionsPath,
        'x'.repeat(FROZEN_BLOCK_CAPS.projectInstructions + 1),
        'utf8',
      )
      writeConfig(configPath, userConfig(true, instructionsPath))

      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns undefined when the file contains only whitespace', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-user-instructions-'))
    try {
      const configPath = join(home, 'config.json')
      const instructionsPath = join(home, 'instructions.md')
      writeFileSync(instructionsPath, ' \r\n\t  ', 'utf8')
      writeConfig(configPath, userConfig(true, instructionsPath))

      assert.equal(withConfigEnvironment(home, configPath, () => (
        loadUserInstructionsBlock()
      )), undefined)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

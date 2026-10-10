import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializePlugins } from '../plugin-loader.js'
import { ToolRegistry } from '../../tools/registry.js'

test('plugin command entries and counts exclude metadata for directory and explicit file paths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'plugin-command-metadata-'))
  const prior = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  try {
    const dir = join(home, 'plugins', 'metadata-proof'), commands = join(dir, 'commands')
    mkdirSync(commands, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'metadata-proof', version: '1.0.0', type: 'module', tianshu: {
      name: 'metadata-proof', version: '1.0.0', description: 'Synthetic plugin', entry: 'index.js',
      tools: [{ name: 'metadata_proof_tool', description: 'Fixture' }], permissions: { fs: true }, commands: ['commands', '._explicit.md'],
    } }))
    writeFileSync(join(dir, 'index.js'), `export const tools = [{ definition: { name: 'metadata_proof_tool', description: 'Fixture', input_schema: { type: 'object', properties: {} } }, execute: async () => ({ content: 'ok' }), requiresApproval: () => false, isConcurrencySafe: () => false, isEnabled: () => true }];`)
    writeFileSync(join(commands, 'deploy.md'), 'Deploy fixture')
    writeFileSync(join(commands, '.notes.md'), 'Ordinary dotfile command fixture')
    writeFileSync(join(commands, '._deploy.md'), 'Companion fixture')
    writeFileSync(join(dir, '._explicit.md'), 'Explicit companion fixture')
    const result = await initializePlugins(undefined, new ToolRegistry(), home)
    assert.equal(result.loaded, 1)
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.commands.map(command => command.name).sort(), ['.notes', 'deploy'])
    assert.equal(result.results[0]?.commandCount, 2)
    assert.deepEqual(result.results[0]?.commands, result.commands)
  } finally {
    if (prior === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prior
    rmSync(home, { recursive: true, force: true })
  }
})

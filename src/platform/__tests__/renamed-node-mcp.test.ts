import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveNodeStdioCommand, buildStdioEnvWithNodePath } from '../resolve-node-cli.js'

const host = 'C:\\天枢 App\\node-runtime\\win-x64\\tianshu-runtime.exe'
const deps = { platform: 'win32' as const, execPath: host, existsSync: () => false }

test('Windows Node aliases launch the current host without depending on node.exe or cmd', () => {
  for (const command of ['node', 'node.exe', 'node.cmd', 'NODE.EXE', 'tianshu-runtime.exe']) {
    const args = ['C:\\用户目录\\MCP server\\index.js', '--flag']
    const resolved = resolveNodeStdioCommand(command, args, deps)
    assert.deepEqual(resolved, { command: host, args })
    assert.notEqual(resolved.args, args)
  }
})

test('only a missing legacy sibling executable migrates; external and existing paths remain intact', () => {
  const legacy = host.replace('tianshu-runtime.exe', 'node.exe')
  assert.equal(resolveNodeStdioCommand(legacy, [], deps).command, host)
  assert.equal(resolveNodeStdioCommand(legacy, [], { ...deps, existsSync: () => true }).command, legacy)
  for (const command of ['D:\\custom\\node.exe', '.\\node.exe', 'python', 'node.bat']) {
    assert.equal(resolveNodeStdioCommand(command, [], deps).command, command)
  }
  assert.equal(resolveNodeStdioCommand('node', [], { ...deps, platform: 'linux' }).command, 'node')
})

test('npm and npx use renamed host while preserving arguments and child PATH', () => {
  for (const kind of ['npm', 'npx']) {
    const cli = `C:\\天枢 App\\node-runtime\\win-x64\\node_modules\\npm\\bin\\${kind}-cli.js`
    assert.deepEqual(resolveNodeStdioCommand(kind, ['-y', 'tianshu-mcp'], {
      ...deps, existsSync: p => p === cli,
    }), { command: host, args: [cli, '-y', 'tianshu-mcp'] })
    assert.equal(resolveNodeStdioCommand(kind, [], deps).command, kind)
  }
  const env = buildStdioEnvWithNodePath(undefined, { ...deps, getDefaultEnvironment: () => ({ SystemRoot: 'C:\\Windows' }) })
  assert.equal(env.PATH, 'C:\\天枢 App\\node-runtime\\win-x64;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem')
})

test('production transport consumes the rename-aware resolver', () => {
  const source = readFileSync(new URL('../../mcp/transport-factory.ts', import.meta.url), 'utf8')
  assert.match(source, /const resolved = resolveNodeStdioCommand\(cfg\.command!, cfg\.args \?\? \[\]\)/)
})

test('renamed runtime performs a real production npx MCP handshake and lists tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tianshu-renamed-mcp-'))
  try {
    const executable = join(dir, 'tianshu-runtime.exe')
    copyFileSync(process.execPath, executable)
    const npmBin = join(dir, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'npm/bin')
    mkdirSync(npmBin, { recursive: true })
    // A local CLI fixture speaks MCP without downloads, keys or skill installation.
    writeFileSync(join(npmBin, 'npx-cli.js'), `
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: process.execPath, version: '1' } }
          : { tools: [{ name: 'fixture', description: 'Local fixture', inputSchema: { type: 'object' } }] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      });
    `)
    // Compile the real transport and SDK; this fixture tests the renamed host,
    // npx resolver and MCP protocol without adding tsx cold-loading to its budget.
    const bundle = join(dir, 'production-transport.cjs')
    await build({
      entryPoints: [fileURLToPath(new URL('../../mcp/transport-factory.ts', import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
    })
    const module = pathToFileURL(bundle).href
    const script = join(dir, 'probe.mjs')
    writeFileSync(script, `
      import assert from 'node:assert/strict';
      import { createTransport } from ${JSON.stringify(module)};
      const { client, transport } = await createTransport({ command: 'npx', args: ['-y', 'fixture'] }, { timeoutMs: 5000 });
      try {
        assert.equal(client.getServerVersion().name, process.execPath);
        assert.equal((await client.listTools()).tools[0].name, 'fixture');
        console.log('handshake OK');
      } finally { await transport.close(); }
    `)
    const { stdout } = await promisify(execFile)(executable, [script], { timeout: 15000 })
    assert.match(stdout, /handshake OK/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

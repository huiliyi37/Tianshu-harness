import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { cliFixtureEnv } from '../../../__tests__/cli-process-fixture.js'

/** Compile the real fixture imports before its PTY phase; tsx cache writes must not hold the child open. */
export async function withPtyFixture<T>(source: string, run: (argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'rivet-pty-fixture-'))
  try {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const home = join(root, 'home'), driver = join(root, 'driver.mjs')
    mkdirSync(home)
    writeFileSync(join(home, 'config.json'), '{}')
    await build({
      stdin: { contents: source, resolveDir: repoRoot, sourcefile: 'pty-driver.mjs', loader: 'js' },
      outfile: driver, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent', packages: 'external',
      banner: { js: "import { createRequire as __ptyCreateRequire } from 'node:module'; const require = __ptyCreateRequire(import.meta.url);" },
      plugins: [{ name: 'fixture-imports', setup(builder) {
        builder.onResolve({ filter: /^file:/ }, args => {
          const path = fileURLToPath(args.path)
          const ts = path.replace(/\.js$/, '.ts')
          return { path: existsSync(ts) ? ts : path }
        })
        builder.onResolve({ filter: /^[^./]/ }, args => {
          if (args.path.startsWith('node:')) return
          try { return { path: createRequire(args.importer || join(repoRoot, 'package.json')).resolve(args.path), external: true } }
          catch { return } // Optional packages remain external and fail normally if the fixture uses them.
        })
      } }],
    })
    return run([process.execPath, driver], { cwd: root, env: cliFixtureEnv(home) })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

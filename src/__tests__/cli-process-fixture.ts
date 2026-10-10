import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Exercise the release entry when built; source remains the unbuilt fallback. */
export function cliProcessArgs(repoRoot: string, args: string[]): string[] {
  const built = join(repoRoot, 'dist', 'main.js')
  if (existsSync(built)) return [built, ...args]
  console.error('[CLI fixture] dist/main.js is absent; exercising src/main.ts through tsx')
  return ['--import', pathToFileURL(require.resolve('tsx')).href, join(repoRoot, 'src', 'main.ts'), ...args]
}

export function cliFixtureEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, RIVET_CONFIG_PATH: join(home, 'config.json'), RIVET_HOME: home }
  delete env.RIVET_SESSION_DIR
  delete env.NODE_TEST_CONTEXT
  return env
}

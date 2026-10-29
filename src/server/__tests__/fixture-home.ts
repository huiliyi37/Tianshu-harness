import { join } from 'node:path'

export function useFixtureHome(home: string): () => void {
  const previousHome = process.env.RIVET_HOME
  const previousConfigPath = process.env.RIVET_CONFIG_PATH
  process.env.RIVET_HOME = home
  process.env.RIVET_CONFIG_PATH = join(home, 'config.json')
  let restored = false
  return () => {
    if (restored) return
    restored = true
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    if (previousConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = previousConfigPath
  }
}

import type { FrontendPreferences } from '../frontend-preferences.js'
import { isCapturedPty } from '../terminal-profile.js'

/** Native scrollback is the default on all platforms; fullscreen remains an explicit choice. */
export function resolveFrontendRenderer(mode: FrontendPreferences['renderer'], tty: boolean | undefined, screenReader: boolean,
  env: NodeJS.ProcessEnv = process.env, _platform: NodeJS.Platform = process.platform): 'classic' | 'fullscreen' {
  if (screenReader || tty !== true || mode === 'classic' || env.TERM === 'dumb' || isCapturedPty(env)) return 'classic'
  if (mode === 'fullscreen') return 'fullscreen'
  return 'classic'
}

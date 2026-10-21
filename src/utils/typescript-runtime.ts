import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let loaded: typeof import('typescript') | undefined

/** Load the compiler only when a typecheck or syntax inspection actually runs. */
export function loadTypeScript(): typeof import('typescript') | null {
  try { return loaded ??= require('typescript') as typeof import('typescript') }
  catch { return null }
}

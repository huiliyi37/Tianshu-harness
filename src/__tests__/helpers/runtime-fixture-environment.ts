export const runtimeFixtureFetch = globalThis.fetch

interface FixtureEnvironment {
  values: Record<string, string | undefined>
  fetchImpl: typeof fetch
}

const environments: FixtureEnvironment[] = []
let baseline: Map<string, string | undefined> | undefined
let previousFetch: typeof fetch | undefined

function applyEnvironment(): void {
  const active = environments.at(-1)
  for (const [name, original] of baseline ?? []) {
    const value = active && Object.hasOwn(active.values, name) ? active.values[name] : original
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  globalThis.fetch = active?.fetchImpl ?? previousFetch ?? runtimeFixtureFetch
  if (!active) {
    baseline = undefined
    previousFetch = undefined
  }
}

export function installRuntimeFixtureEnvironment(values: Record<string, string | undefined>, fetchImpl: typeof fetch): () => void {
  if (!baseline) {
    baseline = new Map()
    previousFetch = globalThis.fetch
  }
  for (const name of Object.keys(values)) if (!baseline.has(name)) baseline.set(name, process.env[name])
  const environment = { values: { ...values }, fetchImpl }
  environments.push(environment)
  applyEnvironment()
  let released = false
  return () => {
    if (released) return
    released = true
    environments.splice(environments.indexOf(environment), 1)
    applyEnvironment()
  }
}

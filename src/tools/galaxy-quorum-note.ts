export function quorumOriginalPassed(risks: readonly string[]): number | undefined {
  for (const risk of risks) {
    const match = /^quorum: group .* not reached — (\d+)\/\d+ passed/.exec(risk)
    if (match) return Number(match[1])
  }
  return undefined
}

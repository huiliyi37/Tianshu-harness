export function delegateProfilesFromInput(input: Record<string, unknown>): string[] {
  const names: string[] = []
  if (typeof input.profile === 'string') names.push(input.profile)
  if (Array.isArray(input.tasks)) {
    for (const task of input.tasks) {
      if (task && typeof task === 'object' && typeof (task as { profile?: unknown }).profile === 'string') {
        names.push((task as { profile: string }).profile)
      }
    }
  }
  return names
}

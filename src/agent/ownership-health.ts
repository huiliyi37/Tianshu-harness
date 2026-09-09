export interface OwnershipHealthInput {
  ownedFiles: string[]
  coOwnedFiles: string[]
  externalFiles: string[]
  dirtyFiles: string[]
}

export interface OwnershipHealthReport {
  untrackedDirtyOwned: string[]
  dirtyCoOwned: string[]
  dirtyExternal: string[]
  cleanOwned: string[]
  warningLines: string[]
  infoLines: string[]
}

export function summarizeOwnershipHealth(input: OwnershipHealthInput): OwnershipHealthReport {
  const owned = new Set(input.ownedFiles)
  const coOwned = new Set(input.coOwnedFiles)
  const external = new Set(input.externalFiles)
  const dirty = new Set(input.dirtyFiles)

  const untrackedDirtyOwned = input.dirtyFiles.filter(f => owned.has(f)).sort()
  const dirtyCoOwned = input.dirtyFiles.filter(f => coOwned.has(f)).sort()
  const dirtyExternal = input.dirtyFiles.filter(f => external.has(f)).sort()
  const cleanOwned = input.ownedFiles.filter(f => !dirty.has(f)).sort()
  const warningLines: string[] = []
  const infoLines: string[] = []

  for (const f of input.dirtyFiles) {
    if (!owned.has(f) && !coOwned.has(f) && !external.has(f)) {
      warningLines.push(`Dirty file has no ownership classification: ${f}`)
    }
  }
  if (dirtyCoOwned.length > 0) {
    infoLines.push(`${dirtyCoOwned.length} co-owned file(s) present. These files are shared with other sessions and require extra caution when committing.`)
  }
  if (untrackedDirtyOwned.length === 0 && dirtyExternal.length > 0 && warningLines.length === 0 && dirtyCoOwned.length === 0) {
    infoLines.push('No current owned dirty files. External dirty files are present and excluded from delivery scope.')
  }

  return { untrackedDirtyOwned, dirtyCoOwned, dirtyExternal, cleanOwned, warningLines, infoLines }
}

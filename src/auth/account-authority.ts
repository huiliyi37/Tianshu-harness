interface AccountAuthority { clear(): void }
const authorities = new Map<string, Set<WeakRef<AccountAuthority>>>()

export function observeAccountAuthority(home: string, authority: AccountAuthority): void {
  let current = authorities.get(home)
  if (!current) { current = new Set(); authorities.set(home, current) }
  for (const reference of current) if (!reference.deref()) current.delete(reference)
  current.add(new WeakRef(authority))
}

export function invalidateAccountAuthority(home: string): void {
  const current = authorities.get(home)
  if (!current) return
  for (const reference of current) {
    const authority = reference.deref()
    if (authority) authority.clear()
    else current.delete(reference)
  }
  if (!current.size) authorities.delete(home)
}

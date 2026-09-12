/**
 * 版本解析与比较（纯函数，无 IO）。
 *
 * 从 `updater.ts` 沿接缝拆出：这些比较同时被 `/update` 的版本检查与 Windows
 * 自更新脚本消费，而 updater.ts 已越过 800 行红线
 * （src/__tests__/architecture-guards.test.ts 的 max-lines ratchet）。
 */

/** 解析 semver：返回 [major, minor, patch, prerelease?]，缺失段补 0，忽略 build 元数据。 */
export function parseSemver(version: string): [number, number, number, prerelease?: string] {
  const clean = version.replace(/^v/, '')
  const plusIdx = clean.indexOf('+')
  const base = plusIdx >= 0 ? clean.slice(0, plusIdx) : clean
  const split = base.split('-', 2)
  const core = split[0] ?? '0'
  const pre = split[1]
  const parts = core.split('.').map(x => {
    const n = Number.parseInt(x, 10)
    return Number.isFinite(n) ? n : 0
  })
  while (parts.length < 3) parts.push(0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, pre]
}

function comparePrerelease(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const xa = pa[i]
    const xb = pb[i]
    if (xa === undefined) return -1
    if (xb === undefined) return 1
    const na = Number.parseInt(xa, 10)
    const nb = Number.parseInt(xb, 10)
    const bothNumeric = Number.isFinite(na) && Number.isFinite(nb)
    if (bothNumeric) {
      if (na !== nb) return na - nb
    } else {
      const sa = bothNumeric ? undefined : xa
      const sb = bothNumeric ? undefined : xb
      if (sa !== undefined && sb !== undefined) {
        if (sa !== sb) return sa < sb ? -1 : 1
      }
    }
  }
  return 0
}

/** 取版本 core 的全部数字段（major.minor.patch[.build…]），非数字段记 0。
 *  parseSemver 只保留前三段，这里用于比较多出的第 4+ 段（canary / 构建号）。 */
function coreSegments(version: string): number[] {
  const clean = version.replace(/^v/, '')
  const plusIdx = clean.indexOf('+')
  const base = plusIdx >= 0 ? clean.slice(0, plusIdx) : clean
  const core = (base.split('-', 2)[0] ?? '0').split('.')
  return core.map(x => {
    const n = Number.parseInt(x, 10)
    return Number.isFinite(n) ? n : 0
  })
}

/** `/update` 实际安装的版本规格。横幅承诺的是 `check.latest`，安装必须用同一个版本
 *  而不是 npm 的 `latest` dist-tag——两者在 npm 尚未发布该版本时会漂移（issue #115）。
 *  npm 版本规格不带 `v` 前缀。 */
export function updateInstallSpec(latest: string): string {
  return latest.replace(/^v/, '')
}

/** Semver 比较。返回值 < 0 表示 a < b。
 *  先比主版本三段，再比第 4+ 段（缺失视为 0），最后比 prerelease。 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] as number
    const bi = pb[i] as number
    if (ai !== bi) return ai - bi
  }
  // issue #121 — canary/构建号落在第 4+ 段；不比较会让 1.2.3.4 与 1.2.3 判等。
  const segA = coreSegments(a)
  const segB = coreSegments(b)
  const segLen = Math.max(segA.length, segB.length)
  for (let i = 3; i < segLen; i++) {
    const ai = segA[i] ?? 0
    const bi = segB[i] ?? 0
    if (ai !== bi) return ai - bi
  }
  const preA = pa[3]
  const preB = pb[3]
  if (!preA && !preB) return 0
  if (!preA) return 1
  if (!preB) return -1
  return comparePrerelease(preA, preB)
}

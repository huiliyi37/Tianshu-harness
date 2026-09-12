/**
 * Filter foreign-arch optional platform packages when staging the sidecar
 * node_modules tree. Shared by stage-runtime-deps.js and its tests.
 */

/**
 * @param {string} name package name, e.g. @esbuild/darwin-x64 or @ast-grep/napi-darwin-arm64
 * @param {'arm64'|'x64'} keepArch
 * @returns {boolean} true if this package is for a different CPU arch and must not be staged
 */
export function isForeignPlatformPackage(name, keepArch) {
  /** @type {RegExpMatchArray | null} */
  let m =
    name.match(/^@esbuild\/(?:darwin|linux|win32|android|freebsd|netbsd|openbsd|sunos|aix)-(arm64|x64|ia32|arm)$/) ||
    name.match(/^@ast-grep\/napi-(?:darwin|linux|win32)-(arm64|x64)(?:-(gnu|musl))?$/) ||
    name.match(/^napi-(?:darwin|linux|win32)-(arm64|x64)(?:-(gnu|musl))?$/) ||
    // @napi-rs 系（pdfjs-dist → @napi-rs/canvas 等）：命名 <pkg>-<os>-<arch>[-<libc>]，
    // win32 的 libc 是 msvc（非 musl/gnu，与 gnu 同视为可留）。
    name.match(/^@napi-rs\/[a-z0-9-]+-(?:darwin|linux|win32|android|freebsd)-(arm64|x64|ia32|arm)(?:-(gnu|musl|msvc))?$/)
  if (!m) return false
  const raw = m[1]
  // Desktop ships only arm64/x64. Treat ia32/armv7 as always foreign.
  if (raw === 'ia32' || raw === 'arm') return true
  // musl 变体永远 foreign：桌面基准是 glibc（ubuntu 构建），musl .node 会让
  // linuxdeploy 的 ldd 退出码 1 直接崩（2026-09-03 Linux AppImage 实证；
  // 2026-09-13 @napi-rs/canvas-linux-x64-musl 复发——pdfjs-dist 带入）。
  if (m[2] === 'musl') return true
  return raw !== keepArch
}

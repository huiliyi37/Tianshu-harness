import type { MirrorsConfig } from '../config/schema.js'

/**
 * When autoFallback is enabled, inject git early-fail env vars so that
 * `git clone https://github.com/...` commands abort quickly on slow
 * connections (instead of hanging for 2 minutes). This lets the user see
 * the error and manually try a mirror.
 */
export function gitCloneEarlyFailEnv(command: string, config: MirrorsConfig): Record<string, string> {
  if (config.autoFallback === false) return {}
  if (!/\bgit\b.*\bclone\b.*github\.com/.test(command)) return {}
  return {
    GIT_HTTP_LOW_SPEED_LIMIT: '1000',
    GIT_HTTP_LOW_SPEED_TIME: '15',
  }
}

export type MirrorEcosystem = 'npm' | 'pypi' | 'go' | 'rust' | 'github'

export type GithubMirrorId = NonNullable<MirrorsConfig['github']>
export type NpmMirrorId = NonNullable<MirrorsConfig['npm']>
export type PypiMirrorId = NonNullable<MirrorsConfig['pypi']>
export type GoMirrorId = NonNullable<MirrorsConfig['go']>
export type RustMirrorId = NonNullable<MirrorsConfig['rust']>

export interface GithubMirror {
  id: GithubMirrorId
  name: string
  /** URL template with `{repo}` placeholder, e.g. `https://kkgithub.com/{repo}`. */
  template: string
}

export const GITHUB_MIRRORS: Record<Exclude<GithubMirrorId, 'default'>, GithubMirror> = {
  gitcode: { id: 'gitcode', name: 'GitCode GitHub 镜像', template: 'https://gitcode.com/gh_mirror/{repo}' },
  kkgithub: { id: 'kkgithub', name: 'kkgithub', template: 'https://kkgithub.com/{repo}' },
  fastgit: { id: 'fastgit', name: 'fastgit', template: 'https://hub.fastgit.xyz/{repo}' },
}

export const NPM_MIRRORS: Record<Exclude<NpmMirrorId, 'default'>, string> = {
  taobao: 'https://registry.npmmirror.com',
  tencent: 'https://mirrors.cloud.tencent.com/npm/',
  huawei: 'https://repo.huaweicloud.com/repository/npm/',
}

export const PYPI_MIRRORS: Record<Exclude<PypiMirrorId, 'default'>, { url: string; trustedHost: string }> = {
  tsinghua: { url: 'https://pypi.tuna.tsinghua.edu.cn/simple', trustedHost: 'pypi.tuna.tsinghua.edu.cn' },
  aliyun: { url: 'https://mirrors.aliyun.com/pypi/simple/', trustedHost: 'mirrors.aliyun.com' },
  tencent: { url: 'https://mirrors.cloud.tencent.com/pypi/simple/', trustedHost: 'mirrors.cloud.tencent.com' },
}

export const GO_MIRRORS: Record<Exclude<GoMirrorId, 'default'>, string> = {
  goproxy_cn: 'https://goproxy.cn,direct',
  aliyun: 'https://mirrors.aliyun.com/goproxy/,direct',
}

export const RUST_MIRRORS: Record<Exclude<RustMirrorId, 'default'>, { dist: string; update: string }> = {
  tsinghua: {
    dist: 'https://mirrors.tuna.tsinghua.edu.cn/rustup',
    update: 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup',
  },
  tuna: {
    dist: 'https://mirrors.tuna.tsinghua.edu.cn/rustup',
    update: 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup',
  },
  ustc: {
    dist: 'https://mirrors.ustc.edu.cn/rust-static',
    update: 'https://mirrors.ustc.edu.cn/rust-static/rustup',
  },
}

/** Preset defaults when `preset: 'china'` and an ecosystem is set to 'default'. */
const CHINA_PRESET: Omit<Required<MirrorsConfig>, 'enabled'> = {
  preset: 'china',
  github: 'gitcode',
  npm: 'taobao',
  pypi: 'tsinghua',
  go: 'goproxy_cn',
  rust: 'tsinghua',
  autoFallback: true,
  fallbackMemoryMinutes: 10,
  fallbackTimeoutSec: 60,
}

function resolveWithPreset(
  value: string,
  preset: MirrorsConfig['preset'],
  presetValue: string,
): string | undefined {
  if (value !== 'default') return value
  if (preset === 'china') return presetValue
  return undefined
}

/** Build environment variables to inject into bash executions for enabled mirrors. */
export function buildMirrorEnv(config: MirrorsConfig): Record<string, string> {
  if (!config.enabled) return {}

  const env: Record<string, string> = {}

  const npmId = resolveWithPreset(config.npm, config.preset, CHINA_PRESET.npm) as Exclude<NpmMirrorId, 'default'> | undefined
  if (npmId) {
    const url = NPM_MIRRORS[npmId]
    env.npm_config_registry = url
    env.YARN_REGISTRY = url
    env.PNPM_REGISTRY = url
  }

  const pypiId = resolveWithPreset(config.pypi, config.preset, CHINA_PRESET.pypi) as Exclude<PypiMirrorId, 'default'> | undefined
  if (pypiId) {
    const mirror = PYPI_MIRRORS[pypiId]
    env.PIP_INDEX_URL = mirror.url
    env.PIP_TRUSTED_HOST = mirror.trustedHost
  }

  const goId = resolveWithPreset(config.go, config.preset, CHINA_PRESET.go) as Exclude<GoMirrorId, 'default'> | undefined
  if (goId) {
    env.GOPROXY = GO_MIRRORS[goId]
  }

  const rustId = resolveWithPreset(config.rust, config.preset, CHINA_PRESET.rust) as Exclude<RustMirrorId, 'default'> | undefined
  if (rustId) {
    const mirror = RUST_MIRRORS[rustId]
    env.RUSTUP_DIST_SERVER = mirror.dist
    env.RUSTUP_UPDATE_ROOT = mirror.update
  }

  return env
}

/** Resolve the effective GitHub mirror id, applying preset defaults. */
export function resolveGithubMirrorId(config: MirrorsConfig): Exclude<GithubMirrorId, 'default'> | undefined {
  if (!config.enabled) return undefined
  return resolveWithPreset(config.github, config.preset, CHINA_PRESET.github) as Exclude<GithubMirrorId, 'default'> | undefined
}

/**
 * Rewrite GitHub URLs in a shell command to use the configured mirror.
 * Only rewrites https://github.com/<owner>/<repo> patterns that commonly
 * appear in `git clone`, `git remote add`, or curl/wget commands.
 */
export function rewriteGitHubUrls(command: string, config: MirrorsConfig): string {
  const mirrorId = resolveGithubMirrorId(config)
  if (!mirrorId) return command
  const mirror = GITHUB_MIRRORS[mirrorId]
  if (!mirror) return command

  return command.replace(
    /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/g,
    (_match, repo: string) => mirror.template.replace('{repo}', repo),
  )
}

/** Human-readable summary of the effective mirror settings. */
export function formatMirrorStatus(config: MirrorsConfig): string {
  const lines: string[] = []
  lines.push(`Mirror mode: ${config.enabled ? 'enabled' : 'disabled'}`)
  if (config.enabled) {
    lines.push(`Preset: ${config.preset}`)
    const github = resolveGithubMirrorId(config)
    lines.push(`GitHub mirror: ${github ? GITHUB_MIRRORS[github].name : '(none)'}`)
    const npm = resolveWithPreset(config.npm, config.preset, CHINA_PRESET.npm) as Exclude<NpmMirrorId, 'default'> | undefined
    lines.push(`npm mirror: ${npm ? NPM_MIRRORS[npm] : '(none)'}`)
    const pypi = resolveWithPreset(config.pypi, config.preset, CHINA_PRESET.pypi) as Exclude<PypiMirrorId, 'default'> | undefined
    lines.push(`PyPI mirror: ${pypi ? PYPI_MIRRORS[pypi].url : '(none)'}`)
    const go = resolveWithPreset(config.go, config.preset, CHINA_PRESET.go) as Exclude<GoMirrorId, 'default'> | undefined
    lines.push(`Go proxy: ${go ? GO_MIRRORS[go] : '(none)'}`)
    const rust = resolveWithPreset(config.rust, config.preset, CHINA_PRESET.rust) as Exclude<RustMirrorId, 'default'> | undefined
    lines.push(`Rust mirror: ${rust ? RUST_MIRRORS[rust].dist : '(none)'}`)
  }
  return lines.join('\n')
}

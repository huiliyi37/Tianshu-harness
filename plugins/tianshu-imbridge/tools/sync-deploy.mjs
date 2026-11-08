#!/usr/bin/env node
/**
 * 部署副本同步器（一行命令把开发位置推到天枢正在加载的插件目录，并逐字节核对）。
 *
 * 为什么要有它：手工 `tar | tar` 依赖 WSL 的 shell；实测这台机器的常驻 shell 会挂
 * （PTY 起不来），而 cp/tar 又容易漏文件。用插件的宿主运行时（Windows node）跑本脚本，
 * 不依赖 shell，也不依赖任何第三方依赖。
 *
 * 用法：
 *   "<天枢的 node.exe>" tools/sync-deploy.mjs [--to <部署目录>] [--dry]
 * 默认部署目录从 RIVET_HOME 推：<RIVET_HOME>\plugins\tianshu-imbridge
 *
 * 退出码：0 = 同步完成且核对通过；1 = 有差异或出错（明细打在 stderr / stdout）。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV_ROOT = resolve(HERE, '..')
const SKIP_DIRS = new Set(['node_modules', '.git'])
const SKIP_FILES = new Set(['package-lock.json'])

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  const idx = process.argv.indexOf(`--${name}`)
  return idx >= 0 ? process.argv[idx + 1] : null
}

function resolveDeployRoot() {
  const explicit = argValue('to')
  if (explicit) return resolve(explicit)
  const home = typeof process.env.RIVET_HOME === 'string' ? process.env.RIVET_HOME.trim() : ''
  if (!home) {
    console.error('既没有 --to，也没有 RIVET_HOME：不知道该同步到哪里。')
    process.exitCode = 1
    return null
  }
  return join(home, 'plugins', 'tianshu-imbridge')
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      for (const nested of walkFiles(join(dir, entry.name))) yield nested
      continue
    }
    if (SKIP_FILES.has(entry.name)) continue
    yield join(dir, entry.name)
  }
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function main() {
  const deployRoot = resolveDeployRoot()
  if (!deployRoot) return
  const dry = process.argv.includes('--dry')

  if (!existsSync(deployRoot)) {
    console.error(`部署目录不存在，先确认插件已安装：${deployRoot}`)
    process.exitCode = 1
    return
  }

  const copied = []
  const same = []
  for (const source of walkFiles(DEV_ROOT)) {
    const relative = source.slice(DEV_ROOT.length + 1)
    const target = join(deployRoot, relative)
    if (existsSync(target) && statSync(target).isFile() && sha(source) === sha(target)) {
      same.push(relative)
      continue
    }
    if (!dry) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    }
    copied.push(relative)
  }

  // 反向核对：开发位置已删、部署副本还留着的文件（避免陈旧代码被加载）
  const stale = []
  if (existsSync(deployRoot)) {
    for (const file of walkFiles(deployRoot)) {
      const relative = file.slice(deployRoot.length + 1)
      if (!existsSync(join(DEV_ROOT, relative))) stale.push(relative)
    }
  }

  console.log(`${dry ? '[dry-run] ' : ''}开发位置：${DEV_ROOT}`)
  console.log(`${dry ? '[dry-run] ' : ''}部署副本：${deployRoot}`)
  console.log(`一致未动：${same.length} 个`)
  console.log(`${dry ? '待复制' : '已复制'}：${copied.length} 个${copied.length ? `\n  ${copied.join('\n  ')}` : ''}`)
  if (stale.length) {
    console.log(`⚠️ 部署副本独有的陈旧文件（开发位置已无，建议手工确认）：${stale.length} 个\n  ${stale.join('\n  ')}`)
  }

  // 同步后复核
  let mismatch = 0
  for (const source of walkFiles(DEV_ROOT)) {
    const relative = source.slice(DEV_ROOT.length + 1)
    const target = join(deployRoot, relative)
    if (!existsSync(target) || sha(source) !== sha(target)) {
      mismatch += 1
      console.error(`!! 复核不一致：${relative}`)
    }
  }
  console.log(mismatch === 0 && !dry ? '✅ 逐字节一致' : (dry ? '（dry-run 不做复核）' : `!! ${mismatch} 个不一致`))
  if (mismatch > 0) process.exitCode = 1
}

main()

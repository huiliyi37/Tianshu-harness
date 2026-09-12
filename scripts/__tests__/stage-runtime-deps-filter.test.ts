import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isForeignPlatformPackage } from '../runtime-platform-filter.js'

test('isForeignPlatformPackage detects @esbuild platform pkgs', () => {
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-x64', 'arm64'), true)
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-arm64', 'arm64'), false)
  assert.equal(isForeignPlatformPackage('@esbuild/darwin-arm64', 'x64'), true)
  assert.equal(isForeignPlatformPackage('@esbuild/linux-x64', 'x64'), false)
})

test('isForeignPlatformPackage detects @ast-grep napi pkgs', () => {
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-darwin-x64', 'arm64'), true)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-darwin-arm64', 'arm64'), false)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi', 'arm64'), false)
  // musl 变体永远 foreign（桌面 glibc 基准;linuxdeploy 对 musl .node 跑 ldd 会崩）
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-linux-x64-musl', 'x64'), true)
  assert.equal(isForeignPlatformPackage('@ast-grep/napi-linux-x64-gnu', 'x64'), false)
  assert.equal(isForeignPlatformPackage('napi-linux-x64-musl', 'x64'), true)
})

test('isForeignPlatformPackage detects @napi-rs pkgs（pdfjs-dist → canvas）', () => {
  // 2026-09-13 Linux AppImage 实证：@napi-rs/canvas-linux-x64-musl 混入 staging
  // → linuxdeploy 对该 .node 跑 ldd 退出码 1 → std::runtime_error 打包崩。
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-linux-x64-musl', 'x64'), true)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-linux-x64-gnu', 'x64'), false)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-linux-arm64-gnu', 'x64'), true)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-darwin-arm64', 'arm64'), false)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-darwin-x64', 'arm64'), true)
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas-win32-x64-msvc', 'x64'), false)
  // 包本体（无平台后缀）永远保留
  assert.equal(isForeignPlatformPackage('@napi-rs/canvas', 'x64'), false)
})

test('isForeignPlatformPackage leaves non-platform packages alone', () => {
  assert.equal(isForeignPlatformPackage('esbuild', 'arm64'), false)
  assert.equal(isForeignPlatformPackage('typescript', 'arm64'), false)
  assert.equal(isForeignPlatformPackage('@ast-grep/lang-python', 'arm64'), false)
})

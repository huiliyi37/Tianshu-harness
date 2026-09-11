import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { SCAN_EXCLUDE_DIRS, isScanExcludedDir } from '../scan-excludes.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('scan excludes', () => {
  it('covers the trees that cost the most to walk', () => {
    // `target` is the one that went missing from two hand-kept copies, and it is
    // the largest tree a Rust/Tauri checkout owns (4.2GB here). `TianshuData` is
    // the desktop app's runtime data directory, which currently nests inside it.
    for (const name of ['node_modules', '.git', 'dist', 'build', 'target', 'TianshuData']) {
      assert.ok(isScanExcludedDir(name), `${name} must be pruned`)
    }
  })

  it('leaves .rivet searchable', () => {
    // Plans, skills and project knowledge live there; read_file exempts it for
    // the same reason. Tools that want it skipped (ast search) add it locally.
    assert.equal(isScanExcludedDir('.rivet'), false)
    assert.equal(isScanExcludedDir('src'), false)
    assert.equal(isScanExcludedDir('docs'), false)
  })

  it('is the single source every walker derives from', () => {
    // This list lived in seven files that had each drifted apart; the two that
    // had lost `target` were the ones walking into the build tree. A literal
    // re-declaration anywhere is how that comes back.
    const walkers = [
      '../glob.ts',
      '../grep.ts',
      '../repo-map.ts',
      '../ast-shared.ts',
      '../inspect-project.ts',
      '../file-info.ts',
      '../../server/file-list.ts',
    ]
    for (const path of walkers) {
      const src = read(path)
      // .js = 编译产物说明符约定，.ts = strip-types 运行时约定（CPU worker 按
      // 原生 node 加载，.js 指向 .ts 文件会直接终止 worker）——两者都算派生。
      assert.match(src, /scan-excludes\.(js|ts)/, `${path} must derive from the shared baseline`)
      assert.doesNotMatch(
        src,
        /'node_modules',\s*'\.git'/,
        `${path} re-declares the list instead of importing it`,
      )
    }
  })

  it('is a floor, not a replacement — callers keep their own extras', () => {
    // Folding in the baseline must not quietly drop what a tool already skipped
    // for its own reasons; that would trade one drift for another.
    const ast = read('../ast-shared.ts')
    assert.match(ast, /\.\.\.SCAN_EXCLUDE_DIRS/)
    assert.match(ast, /'\.rivet'/, 'AST search still skips stored plans and knowledge')
    assert.match(ast, /'\.nyc_output'/)

    const repoMap = read('../repo-map.ts')
    assert.match(repoMap, /\.\.\.SCAN_EXCLUDE_DIRS/)
    assert.match(repoMap, /'coverage'/)
    assert.match(repoMap, /'\.cache'/)
  })

  it('baseline membership is what callers actually get', () => {
    assert.ok(SCAN_EXCLUDE_DIRS.has('target'))
    assert.equal(SCAN_EXCLUDE_DIRS.has('.rivet'), false)
  })
})

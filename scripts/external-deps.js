/**
 * external-deps.js — 单一数据源：dist 运行时外部依赖清单。
 *
 * 收敛三处曾各自维护、靠人工同步的清单（2026-08-10 之前）：
 *   - tsup.config.ts `external`（打包器不内联）
 *   - scripts/runtime-import-scan.js `ALLOWED_EXTERNALS`（dist 裸导入扫描允许集）
 *   - scripts/stage-runtime-deps.js `ROOTS`（随包分发到 dist/node_modules 的载荷）
 *
 * 语义分层（不是同一份列表的三次复制）：
 *   - RUNTIME_BUNDLED —— 必须随包分发才能在打包 sidecar 中解析的包
 *     （stage-runtime-deps ROOTS 的直接来源）。
 *   - SCAN_ALLOWED —— dist 产物中允许出现的裸导入全集（runtime-import-scan
 *     的允许集）。= RUNTIME_BUNDLED ∪ 特性门后惰性解析/可选依赖。
 *
 * 不变量（verifyConsistency 强制）：
 *   1. RUNTIME_BUNDLED ⊆ SCAN_ALLOWED —— 随包分发的包必然以裸导入出现在产物里；
 *   2. 两清单各自无重复；
 *   3. tsup `noExternal`（强制内联）与 RUNTIME_BUNDLED 互斥 —— 见 tsup.config.ts
 *      构建期自检。exceljs 曾同时出现在 noExternal 与 ROOTS（注释互相矛盾），
 *      已裁定走随包分发路线：doc-extract.ts 是变量动态 import + 缺失时降级
 *      soffice，22MB 不进主 bundle。
 *
 * 修改依赖清单只改这里；改完跑 `npm run build` 与
 * `node scripts/assert-runtime-imports.js` 验证两条链。
 */

/** 随包分发到 dist/node_modules 的根包（stage-runtime-deps ROOTS 的来源）。
 *  每项注释说明"为什么不能内联进主 bundle"。 */
export const RUNTIME_BUNDLED = [
  'esbuild', // syntax-check JS/TS parser（native Go binary）
  'typescript', // in-process tsc LSP fallback
  '@ast-grep/napi', // structural search / ast-edit（native addon）
  '@ast-grep/lang-json',
  '@ast-grep/lang-python',
  'web-tree-sitter', // tree-sitter chunker（wasm loader）
  'tree-sitter-wasms', // grammar .wasm 文件（按路径加载）
  'playwright-core', // headless chromium driver（变量化动态 import——tsup 无法内联）
  'exceljs', // Office .xlsx 读写（文档附件管线）。变量动态 import + 缺失降级
  // soffice；纯 JS 体积 ~22MB 不宜内联进主 bundle，随包分发。
  'pdfjs-dist', // .pdf 文本抽取兜底引擎（pdftotext 缺失时顶上的纯 JS 路径）。
  // 动态 import legacy/build/pdf.mjs + standard_fonts 按路径加载——不能内联，随包分发。
]

/** dist 产物裸导入扫描允许集（runtime-import-scan ALLOWED_EXTERNALS 的来源）。 */
export const SCAN_ALLOWED = [
  ...RUNTIME_BUNDLED,
  // native 动态加载：走 native-resolver 专用通道（wrapper 由
  // stage-cli-sqlite-wrapper.js 单独分发，native 二进制由 pack-native.js 打包），
  // 不进 RUNTIME_BUNDLED 的 closure 复制。
  'better-sqlite3',
  // dev-only devtools（ink 的可选依赖）；未安装时 ink devtools 不可用，
  // 主功能不依赖，不随包分发。
  'react-devtools-core',
  // optional Office docx reader（npm i mammoth），走 lazy，不随包分发。
  'mammoth',
  // 可选剪贴板原生库，未安装时静默回退 shell 链；当前无消费点，仅预留。
  '@mariozechner/clipboard',
  // Landlock 沙箱 launcher（Linux 预编译二进制经其自身 optionalDeps 分发）。
  // 惰性 require + probe fail-closed：未安装/非 Linux/内核不强制 → 探测失败
  // → 回退 bwrap/firejail 之后的 none（sandbox-profile.ts defaultLandlockUsable）。
  // 不进 RUNTIME_BUNDLED（桌面 mac/win 用不到 Linux 二进制）。
  '@huiliyi37/node-addon-landlock-run',
]

/** 一致性校验。默认校验本模块导出的清单；测试可注入伪造清单。 */
export function verifyConsistency({ runtimeBundled = RUNTIME_BUNDLED, scanAllowed = SCAN_ALLOWED } = {}) {
  const dup = (name, list) => {
    const seen = new Set()
    for (const item of list) {
      if (seen.has(item)) throw new Error(`external-deps: ${name} 含重复条目 '${item}'`)
      seen.add(item)
    }
  }
  dup('RUNTIME_BUNDLED', runtimeBundled)
  dup('SCAN_ALLOWED', scanAllowed)

  const allowedSet = new Set(scanAllowed)
  const missing = runtimeBundled.filter((p) => !allowedSet.has(p))
  if (missing.length > 0) {
    throw new Error(
      `external-deps: RUNTIME_BUNDLED ⊆ SCAN_ALLOWED 不成立，缺失: ${missing.join(', ')}`,
    )
  }
}

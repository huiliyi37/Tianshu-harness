/**
 * Destructive command patterns — 共享正则,单一事实来源。
 *
 * 被两个消费方引用(判据同源,状态各自独立):
 *   1. src/tools/destructive-gate.ts — pre-execution 当轮拦截(tool-pipeline 切面)
 *   2. src/agent/hooks/git-clear-after-fail-hook.ts — postTool 事后教育性 advisory
 *
 * 放在 src/tools/ 而非 hook 文件内导出:tool-pipeline 不应依赖 hook 文件
 * (天枢复核 2026-07-04)。
 */

/**
 * git 全局参数（位于 `git` 与子命令之间）语法——单一事实来源，三处判据共用：
 *   ① 本文件 GIT_CLEAR_RE（destructive-gate / git-clear-after-fail-hook）
 *   ② src/agent/approval-risk.ts 的归一化检测视图
 *   ③ src/tools/sensitive-file-detector.ts 的 `git add` 提取
 * 三处各写一份时，任何一处漏形态都是绕过口——收编公开仓 PR #410 前的实测：
 * `git --git-dir .git stash` 在清场门漏判、`git -C/tmp reset --hard` 在审批门漏判。
 * 同族语义等价形态必须同判：
 *   -C <dir> ≡ -C<dir>、-c k=v ≡ -ck=v（值型短旗标，分隔与紧贴都合法）
 *   --git-dir=x ≡ --git-dir x（值型长旗标，= 与空格分隔都合法）
 *   --no-pager 等无值长旗标；-p / -P；引号包裹的值（`-C "my repo"`）
 * 已知不含：长旗标缩略形态（`--git-di x`，git 接受但极少见）——漏判风险记录在案。
 */
const QUOTED_VALUE = String.raw`"[^"]*"|'[^']*'`
const OPT_VALUE = String.raw`(?:${QUOTED_VALUE}|\S+)`
export const GIT_GLOBAL_OPTS_SRC =
  String.raw`(?:\s+(?:-[Cc](?:\s+${OPT_VALUE}|${OPT_VALUE})` +
  String.raw`|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)(?:=${OPT_VALUE}|\s+${OPT_VALUE})` +
  String.raw`|--[a-z][\w-]*(?:=${OPT_VALUE})?` +
  String.raw`|-[pP]))*`

/** 命令起点：行首、空白或 shell 连接符（`;` `&` `|` `(`）——覆盖 `cd x&&git …` 无空格写法。 */
const CMD_START = String.raw`(?:^|[\s;&|(])`

/**
 * git 清场命令正则——匹配不可逆的 git 清理操作。
 * 来源:AGENTS.md 高危命令纪律 + `<security>` 覆盖范围段
 *
 * 匹配的真实命令样本(禁止的行为):
 *   `git stash`(非 pop/list/show/apply/drop)
 *   `git reset --hard` / `git reset --mixed`
 *   `git checkout -- .`
 *   `git restore .`
 *   `git clean -fd`
 * 以上任意形态前置全局参数(`git -C <dir> reset --hard` / `git --no-pager stash`)同样命中。
 *
 * 排除(只读/恢复类):
 *   `git stash list` / `git stash pop` / `git stash show` / `git stash apply`
 *   `git diff` / `git status` / `git log`
 */
export const GIT_CLEAR_RE = new RegExp(
  CMD_START +
    String.raw`git` +
    GIT_GLOBAL_OPTS_SRC +
    String.raw`\s+(?:stash(?!\s+(?:pop|list|show|apply|drop|branch))|reset\s+(?:--hard|--mixed)|checkout\s+--|restore\s+\S|clean\s+-[a-z]*f)`,
)

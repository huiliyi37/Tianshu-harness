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
 * git 清场命令正则——匹配不可逆的 git 清理操作。
 * 来源:AGENTS.md 高危命令纪律 + `<security>` 覆盖范围段
 *
 * 匹配的真实命令样本(禁止的行为):
 *   `git stash`(非 pop/list/show/apply/drop)
 *   `git reset --hard` / `git reset --mixed`
 *   `git checkout -- .`
 *   `git restore .`
 *   `git clean -fd`
 *
 * 排除(只读/恢复类):
 *   `git stash list` / `git stash pop` / `git stash show` / `git stash apply`
 *   `git diff` / `git status` / `git log`
 */
/**
 * git 与子命令之间允许出现的全局参数（`-C <dir>` / `-c k=v` / `--no-pager` / `--git-dir=…`）。
 * 值型长旗标必须同时接受 `=` 与空格分隔形态（`--git-dir=/x` 与 `--git-dir /x`）——
 * 只接 `=` 时 `git --git-dir .git stash`、`git --work-tree . reset --hard` 会绕过本门
 * （approval-risk.ts 的 GIT_GLOBAL_OPTS_RE 已列空白分隔形态，两处需同口径）。
 * 通用长旗标（无值 / `--no-pager` 等）仍只接 `=` 形态，避免吞掉子命令首个参数。
 */
const GIT_GLOBAL_OPTS =
  String.raw`(?:\s+(?:-[Cc]\s+\S+` +
  String.raw`|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)(?:=\S+|\s+\S+)` +
  String.raw`|--[\w-]+(?:=\S+)?))*`
/** 命令起点：行首、空白或 shell 连接符（`;` `&` `|` `(`），覆盖 `cd x&&git …` 这类无空格写法。 */
const CMD_START = String.raw`(?:^|[\s;&|(])`

export const GIT_CLEAR_RE = new RegExp(
  CMD_START +
    String.raw`git` +
    GIT_GLOBAL_OPTS +
    String.raw`\s+(?:stash(?!\s+(?:pop|list|show|apply|drop|branch))|reset\s+(?:--hard|--mixed)|checkout\s+--|restore\s+\S|clean\s+-[a-z]*f)`,
)

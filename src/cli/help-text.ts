/**
 * CLI 帮助文本——单一事实源。
 *
 * 抽出原因（2026-09-16 P0-2 CLI 启动优化）：`--help` 必须在 launcher
 * （src/cli/entry.ts）里、在不加载 main.ts 整张依赖图的前提下输出；而直接跑
 * `dist/main.ts` / tsx 开发入口时也要输出同一份文本。两边各写一份必然漂移，
 * 所以常量收敛到这里（零依赖叶子，含在 launcher 的轻量静态图里）。
 *
 * 改动纪律：这里是 `rivet --help` 的唯一来源。新增 flag 时同步更新本文本与
 * main.ts 的参数解析（P0-2 契约测试会锁 launcher 的快速路径行为）。
 */
export const HELP_TEXT = `rivet — 天枢 Tianshu terminal coding agent

Usage:
  rivet [options]                    interactive TUI (requires TTY)
  rivet -p "<prompt>" [--json] [--stream-json]   headless one-shot
  rivet --goal "<task>" [--budget N] [--json] [--stream-json]   headless goal mode
  rivet serve [--port N] [--host ADDR] [--attach] [--json]   runtime API server
    --tls-cert <pem> --tls-key <pem>   required when serve binds outside loopback
  rivet sessions | rivet logs        list sessions / log locations and exit

Options:
  --model <name>           use a specific model (e.g. deepseek-v4-pro)
  --provider <name>        use a specific provider
  --profile <name>         boot with a named config profile (RIVET_HOME/profiles/<name>.json or built-in lean)
  -c, --continue           resume the most recent session for this cwd
  -r, --resume [id|prefix] resume a specific session (bare = open picker)
  --new                    force a brand-new session
  --list                   list sessions and exit
  -p, --print "<prompt>"   headless: answer one prompt, then exit
  --goal "<task>"          headless goal autonomy (--budget N caps turns)
  --json | --stream-json   headless output format
  --stream-events <path>   mirror the run as NDJSON SessionEvents to a file (TUI + -p/--goal)
  --skip-welcome           skip the welcome page
  --screen-reader          screen-reader mode
  --terminal-mode <mode>   auto | captured-pty (plain text) | native
  --dangerously-skip-permissions   skip permission prompts (high risk)
  -h, --help               show this help and exit
  -v, --version            print version and exit
`

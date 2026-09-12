#!/usr/bin/env bash
# dispose-community-pr.sh — 社区 PR 处置四步流程（sync-merge 形态）固化
#
# 社区活跃后，每个社区 PR 按同一四步处置（2026-08-03 PR #20 首例沉淀）：
#   ① 收录 CONTRIBUTORS.md（scripts/contributors.ts 自动收录：数据源=GitHub PR 列表含全部
#      状态，只增不删。旧的 update-contributors.sh 扫 merge commit，在本流程下提取不到条目）
#   ② 附注 + sync-merged 标记 + 关闭（公开仓不走 merge 按钮——dev 主仓是唯一事实源）
#   ③ credit commit：Co-authored-by trailer 署名落账（GitHub 贡献者图谱按 trailer 计入）
#   ④ --push 时推送公开仓（默认只做到本地，打印推送命令由人确认）
#
# 前置条件（本脚本不验证，维护者自查）：
#   该 PR 的内容已经 sync 流程合入 dev main。未合入就先处置＝把署名落到空气上。
#
# 用法:
#   bash scripts/dispose-community-pr.sh <PR#> [--sync-commit <hash>] [--note "自定义附注"] [--push] [--dry-run]
# 环境:
#   PUB_DIR  公开仓 checkout（默认 /Users/banxia/app/Tianshu，与 sync-to-public.sh 同）
#   GH_REPO  公开仓（默认 huiliyi37/Tianshu-Tui）
#   OWNER    仓库拥有者 login（默认 huiliyi37，署名过滤用）
#
# 幂等：已带 sync-merged 且已关闭的 PR 报告后退出；credit commit 按 PR 号查重不重复落账。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # ③ 会 cd 到公开仓，故此处先绝对值化
PR=""
SYNC_COMMIT=""
NOTE=""
DO_PUSH=0
DRY=0
PUB_DIR="${PUB_DIR:-/Users/banxia/app/Tianshu}"
GH_REPO="${GH_REPO:-huiliyi37/Tianshu-harness}"
OWNER="${OWNER:-huiliyi37}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync-commit) SYNC_COMMIT="$2"; shift 2 ;;
    --note) NOTE="$2"; shift 2 ;;
    --push) DO_PUSH=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) [[ -z "$PR" ]] && PR="$1" || { echo "✗ 多余参数: $1" >&2; exit 2; }; shift ;;
  esac
done
[[ -n "$PR" ]] || { echo "用法: bash scripts/dispose-community-pr.sh <PR#> [--sync-commit <hash>] [--push] [--dry-run]" >&2; exit 2; }

command -v gh >/dev/null || { echo "✗ 需要 gh CLI"; exit 1; }
command -v jq >/dev/null || { echo "✗ 需要 jq"; exit 1; }
[[ -d "$PUB_DIR/.git" ]] || { echo "✗ PUB_DIR 不是 git checkout: $PUB_DIR"; exit 1; }

echo "==> 读取 PR #${PR}（${GH_REPO}）"
info=$(gh pr view "$PR" --repo "$GH_REPO" --json number,title,state,author,commits,labels)
title=$(jq -r '.title' <<<"$info")
state=$(jq -r '.state' <<<"$info")
login=$(jq -r '.author.login' <<<"$info")
has_sync_merged=$(jq -r '[.labels[].name] | contains(["sync-merged"])' <<<"$info")

if [[ "$state" == "CLOSED" && "$has_sync_merged" == "true" ]]; then
  echo "✓ PR #${PR} 已带 sync-merged 标记且已关闭——已处置过，无需重复。退出。"
  exit 0
fi

# 真人署名：commits 作者里滤掉 bot 与仓库拥有者；取不到则用 PR author 的 noreply。
author_line=$(jq -r --arg owner "$OWNER" '
  [.commits[].authors[]
   | select((.name | test("(?i)cursor|copilot|github-actions|\\[bot\\]")) | not)
   | select(.login != $owner and .name != $owner)]
  | first // empty | "\(.name) <\(.email)>"' <<<"$info")
if [[ -z "$author_line" ]]; then
  author_line="${login} <${login}@users.noreply.github.com>"
fi
echo "    标题: ${title}"
echo "    作者: @${login}（署名落账: ${author_line}）"

sync_ref="${SYNC_COMMIT:+sync 提交 ${SYNC_COMMIT}}"
sync_ref="${SYNC_COMMIT:-本次 sync}"
if [[ -z "$NOTE" ]]; then
  NOTE="已通过 sync 流程合入 dev，感谢 @${login} 的贡献 🎉

本 PR 的改动（${title}）已经 sync 流程合入主仓（${sync_ref}），并已收录进 [CONTRIBUTORS.md](https://github.com/${GH_REPO}/blob/main/CONTRIBUTORS.md)。

按仓库的双仓流程，公开仓 PR 不经 merge 按钮合入（保持 dev 主仓唯一事实源），现以 sync-merged 标记关闭。欢迎继续贡献！"
fi

if [[ "$DRY" == "1" ]]; then
  echo ""
  echo "── DRY RUN ──────────────────────────"
  echo "① 收录 CONTRIBUTORS.md：npx --no-install tsx scripts/contributors.ts --write"
  echo "② 附注: ${NOTE}"
  echo "③ credit commit: Co-authored-by: ${author_line}"
  echo "④ push: $([[ "$DO_PUSH" == "1" ]] && echo '是' || echo '否（仅打印）')"
  exit 0
fi

# ── ① 收录 CONTRIBUTORS.md ──
# 2026-09 起由 scripts/contributors.ts 自动收录：数据源是 GitHub PR 列表（含 CLOSED——
# 本仓收编的 PR 不会被 merge），只增不删，既有条目的 login/描述/顺序不受影响。
echo "==> ① 更新 CONTRIBUTORS.md"
if npx --no-install tsx "$SCRIPT_DIR/contributors.ts" --write; then
  echo "    ✓ 已收录（新条目的「贡献」列是 PR 标题初稿，按需润色）"
else
  echo "    ⚠ 自动收录失败（gh 未认证 / 网络不可用）——请手工核对 $PUB_DIR/CONTRIBUTORS.md 是否收录 @${login}"
fi

# ── ② 附注 + 标记 + 关闭 ──
echo "==> ② 附注 + sync-merged 标记 + 关闭"
gh label list --repo "$GH_REPO" --limit 100 --json name --jq '.[].name' | grep -qx 'sync-merged' \
  || gh label create sync-merged --repo "$GH_REPO" --color 0e8a16 \
       --description "内容已通过 sync 流程合入 dev 主仓（PR 形态留痕，作者计入 CONTRIBUTORS）"
gh pr comment "$PR" --repo "$GH_REPO" --body "$NOTE"
gh pr edit "$PR" --repo "$GH_REPO" --add-label sync-merged
[[ "$state" == "CLOSED" ]] || gh pr close "$PR" --repo "$GH_REPO"

# ── ③ credit commit（Co-authored-by 落账） ──
echo "==> ③ credit commit"
cd "$PUB_DIR"
if git log --format='%B' -50 | grep -qF "PR #${PR} 计入贡献"; then
  echo "    已存在 PR #${PR} 的 credit commit，跳过"
else
  git commit --allow-empty -m "credit: PR #${PR} 计入贡献——${title}

内容已经 sync 流程合入（${sync_ref}），本提交为作者署名落账：
GitHub 贡献者图谱按 Co-authored-by trailer 计入。

Co-authored-by: ${author_line}"
  echo "    credit commit 已创建（Co-authored-by: ${author_line}）"
fi

# ── ④ 推送 ──
if [[ "$DO_PUSH" == "1" ]]; then
  echo "==> ④ 推送公开仓"
  git push
else
  echo "==> ④ 未加 --push——本地完成。推送请执行： cd $PUB_DIR && git push"
fi

echo "✓ PR #${PR}（@${login}）处置完成"

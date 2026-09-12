#!/usr/bin/env bash
# update-contributors.sh — 兼容入口。核心逻辑已迁到 scripts/contributors.ts。
#
# 为什么重写：旧实现扫 git log 里的 "Merge PR #N" 合并提交。但本仓为了让本体代码
# 不被外部贡献改崩，绝大多数外部 PR 不 merge——先在 dev 仓按现状重写（收编）、验证，
# 再经 sync 推到公开仓，PR 在 GitHub 上是 CLOSED 状态。于是旧实现一条都扫不到，
# 重跑只会写出一个空表头、把整张名单清空（2026-09 实际踩过）。
#
# 新实现以 GitHub PR 列表（全部状态）为权威数据源，并保证只增不删：既有条目、
# 人工撰写的「贡献」描述与相对顺序都不会被覆盖。详见 scripts/contributors.ts。
#
# 用法：
#   bash scripts/update-contributors.sh          # 合并写回（默认，等同 --write）
#   bash scripts/update-contributors.sh --check  # 只对账，报告差异（有差异退出码 1）
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
[[ "$(basename "$REPO_DIR")" == "scripts" ]] && REPO_DIR="$(cd "$REPO_DIR/.." && pwd)"

[[ $# -eq 0 ]] && set -- --write
exec npx --no-install tsx "$REPO_DIR/scripts/contributors.ts" "$@"

#!/usr/bin/env bash
# 天枢（Tianshu）CLI 一键安装 + 启动（macOS / Linux）
#
# 用法：
#   bash scripts/install-tui.sh              # 全局安装 tianshu-tui + 启动 rivet
#   bash scripts/install-tui.sh --no-launch  # 只安装不启动（打印下一步）
#
# 远程一键（公开仓库 main）：
#   bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.sh)
#
# 说明：
#   - 官方 npm 包 tianshu-tui，命令名 rivet；需要 Node.js >= 24（engines 钉死）。
#   - 默认走 npmmirror 镜像（国内网络加速）；设 NPM_CONFIG_REGISTRY 可覆盖。
#   - 幂等：重复执行覆盖升级到最新版。
set -euo pipefail

REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
# npm 经环境变量读 registry（大小写两份都设，与 install-tui.ps1 同口径）
export NPM_CONFIG_REGISTRY="$REGISTRY"
export npm_config_registry="$REGISTRY"

say() { printf '\033[1;36m== %s ==\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 1. Node.js >= 24
if ! command -v node >/dev/null 2>&1; then
  die "缺少 Node.js（>= 24）。请先安装：https://nodejs.org/（或 nvm install 24 && nvm alias default 24）"
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  die "Node.js 版本过低（当前 $(node -v)，需要 >= 24）。请升级后重跑：https://nodejs.org/"
fi

# 1.5 Android/Termux：裸 Termux（bionic）缺必需原生依赖（@ast-grep/napi / esbuild）
# 的 android 平台二进制，npm 会静默跳过——装完运行必坏。官方支持路径是
# proot-distro（glibc 发行版）。npm 包内的 postinstall 守卫也会拦，这里提前给结论。
if uname -o 2>/dev/null | grep -q '^Android$'; then
  die "检测到裸 Termux 环境：必需原生依赖没有 Android 平台二进制，无法安装。
官方支持路径（proot-distro，glibc）：
  pkg install proot-distro && proot-distro install ubuntu && proot-distro login ubuntu
  （容器内）apt update && apt install -y curl ripgrep
  安装 Node >= 24（nodesource 或 nvm），然后重跑本脚本或 npm i -g tianshu-tui"
fi

# 2. 全局安装（幂等：重复执行覆盖升级）
say "安装天枢 CLI tianshu-tui（registry=${REGISTRY}）"
if ! npm install -g tianshu-tui; then
  die "安装失败。网络问题可换官方源重跑：NPM_CONFIG_REGISTRY=https://registry.npmjs.org bash $0"
fi

# 3. 验证（个别环境装完当前 shell 拿不到 PATH，给出可操作指引而不是直接失败）
if command -v rivet >/dev/null 2>&1; then
  say "已安装：$(rivet --version 2>/dev/null || echo tianshu-tui)"
else
  say "安装完成，但当前 shell 找不到 rivet 命令——新开一个终端即可；仍不行把「npm prefix -g」输出的 bin 目录加入 PATH"
fi

# 4. 启动
if [ "${1:-}" = "--no-launch" ]; then
  cat <<'EOF'

安装完成。下一步：
  rivet                # 启动（任意目录，进入会话）
  rivet --version      # 查看版本

首次使用：启动后输入 /connect 走供应商连接向导配置 API Key，
或直接 export DEEPSEEK_API_KEY=sk-*** 后开始对话。
桌面端安装包（macOS 双架构 / Windows）：https://github.com/huiliyi37/Tianshu-Tui/releases
EOF
  exit 0
fi
if ! command -v rivet >/dev/null 2>&1; then
  die "当前 shell 拿不到 rivet（PATH 未刷新）——请新开一个终端运行：rivet"
fi
say "启动天枢 rivet"
exec rivet

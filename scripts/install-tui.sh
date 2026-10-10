#!/usr/bin/env bash
# 天枢（Tianshu）CLI 一键安装 + 启动（macOS / Linux）
#
# 用法：
#   bash scripts/install-tui.sh              # 全局安装 tianshu-harness + 启动 tianshu
#   bash scripts/install-tui.sh --no-launch  # 只安装不启动（打印下一步）
#
# 远程一键（公开仓库 main）：
#   bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-harness/main/scripts/install-tui.sh)
#
# 说明：
#   - 官方 npm 包 tianshu-harness，主命令 tianshu（rivet 为兼容别名）；需要 Node.js >= 24（engines 钉死）。
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
  安装 Node >= 24（nodesource 或 nvm），然后重跑本脚本或 npm i -g tianshu-harness"
fi

# 1.6 npm 全局目录可写性预检。
#     官方 Node 安装包把全局 prefix 放在 /usr/local（属主 root、权限 755），
#     普通用户 npm install -g 直接 EACCES。这里提前给出结论与修法——既不让用户
#     吃 npm 的原始堆栈，也不把权限失败误诊成网络问题。必须排在旧包迁移之前：
#     那一步的 `npm uninstall -g` 同样要写全局目录。
NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
if [ -n "$NPM_PREFIX" ]; then
  NPM_PROBE="$NPM_PREFIX/lib/node_modules"
  [ -d "$NPM_PROBE" ] || NPM_PROBE="$NPM_PREFIX"
  if [ ! -w "$NPM_PROBE" ]; then
    die "npm 全局目录不可写：$NPM_PROBE
官方 Node 安装包把全局目录放在 /usr/local（root 所有），普通用户写不进去——npm install -g 会报 EACCES。
任选一种修完重跑本脚本：

  ① 把全局目录交给当前用户（一次 sudo；之后安装与 /update 自动更新都不再需要 sudo）
       sudo chown -R \"\$(whoami)\" $NPM_PREFIX/lib/node_modules $NPM_PREFIX/bin

  ② 改用用户级 prefix（无需 sudo；注意把 ~/.npm-global/bin 加进 PATH）
       mkdir -p \"\$HOME/.npm-global\" && npm config set prefix \"\$HOME/.npm-global\"
       echo 'export PATH=\"\$HOME/.npm-global/bin:\$PATH\"' >> ~/.zshrc

  ③ 长期做法：用 nvm / fnm / volta 装 Node——prefix 天然落在用户目录。

排障细节见 docs/guides/troubleshooting.md 第 12 节。"
  fi
fi

# 2. 改名迁移：旧包 tianshu-tui 若仍全局安装，它的 rivet bin 链接会让
#    npm install -g tianshu-harness 直接 EEXIST——先卸旧包装新包。
if npm ls -g --depth=0 tianshu-tui >/dev/null 2>&1; then
  say "检测到旧包 tianshu-tui（已更名为 tianshu-harness）——先卸载再安装"
  npm uninstall -g tianshu-tui || die "卸载旧包 tianshu-tui 失败——请手动执行：npm uninstall -g tianshu-tui && npm install -g tianshu-harness"
fi

# 3. 全局安装（幂等：重复执行覆盖升级）
say "安装天枢 CLI tianshu-harness（registry=${REGISTRY}）"
NPM_INSTALL_LOG="$(umask 077; mktemp "${TMPDIR:-/tmp}/tianshu-install.XXXXXX")" || die "无法创建安装诊断日志，请检查临时目录是否可写后重跑。"
trap 'rm -f "$NPM_INSTALL_LOG"' EXIT
if npm install -g tianshu-harness 2>&1 | tee "$NPM_INSTALL_LOG"; then
  :
else
  NPM_INSTALL_STATUS=("${PIPESTATUS[@]}")
  if [ "${NPM_INSTALL_STATUS[1]}" -ne 0 ]; then
    die "无法完整显示或保存安装诊断日志，请检查临时目录与终端输出后重跑。"
  fi
  if grep -Eq '^npm (error|ERR!) code (EACCES|EPERM)[[:space:]]*$' "$NPM_INSTALL_LOG"; then
    die "安装失败：npm 报权限不足或路径不可写（EACCES/EPERM）。全局 prefix 可写时，已有包、缓存或 bin 目录仍可能拒绝访问。
可改用用户级 prefix（无需 sudo），再重跑：
  mkdir -p \"\$HOME/.npm-global\" && npm config set prefix \"\$HOME/.npm-global\"
  将 \"\$HOME/.npm-global/bin\" 加进 PATH。
或检查 npm 报错路径的属主，确认应属于当前用户后，用 sudo chown 修正该路径的所有权。"
  fi
  die "安装失败。网络问题可换官方源重跑：NPM_CONFIG_REGISTRY=https://registry.npmjs.org bash $0"
fi
rm -f "$NPM_INSTALL_LOG" || die "无法清理安装诊断日志，请检查临时目录权限。"
trap - EXIT

# 3. 验证（个别环境装完当前 shell 拿不到 PATH，给出可操作指引而不是直接失败）
if command -v tianshu >/dev/null 2>&1; then
  say "已安装：$(tianshu --version 2>/dev/null || echo tianshu-harness)"
else
  say "安装完成，但当前 shell 找不到 tianshu 命令——新开一个终端即可；仍不行把「npm prefix -g」输出的 bin 目录加入 PATH"
fi

# 4. 启动
if [ "${1:-}" = "--no-launch" ]; then
  cat <<'EOF'

安装完成。下一步：
  tianshu              # 启动（任意目录，进入会话；rivet 别名同效）
  tianshu --version    # 查看版本

首次使用：启动后输入 /connect 走供应商连接向导配置 API Key，
或直接 export DEEPSEEK_API_KEY=sk-*** 后开始对话。
桌面端安装包（macOS 双架构 / Windows）：https://github.com/huiliyi37/Tianshu-harness/releases
EOF
  exit 0
fi
if ! command -v tianshu >/dev/null 2>&1; then
  die "当前 shell 拿不到 tianshu（PATH 未刷新）——请新开一个终端运行：tianshu"
fi
say "启动天枢 tianshu"
exec tianshu

#!/usr/bin/env bash
# build-linux-container.sh — 本地 OrbStack/Docker 容器出 Linux AppImage（单架构）。
#
# 为什么本地容器而不是 CI：私有仓 GitHub Actions 分钟经常耗尽（v3.26 实证全员
# 3-4 秒无日志失败）；公有仓（harness）又没有闭源的 desktop/。容器 = 无账单、
# 双架构（arm64 原生 / amd64 走 OrbStack Rosetta）。
#
# 隔离策略：源码 tar 进 docker volume（排除 .git/target/node_modules/release/out），
# 容器内 npm ci 出的 linux node_modules 不污染宿主 mac 开发环境；产物 docker cp 回
# out/linux-<arch>/。完整性签名私钥经 -e 注入（不落盘、不进镜像层）。
#
# 用法:
#   export RIVET_RELEASE_KEY_PKCS8="$(cat ~/.tianshu/release.key)"
#   bash scripts/build-linux-container.sh arm64    # 原生（快）
#   bash scripts/build-linux-container.sh amd64    # Rosetta x86 模拟（慢）
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:?用法: build-linux-container.sh <amd64|arm64>}"
case "$ARCH" in
  amd64|arm64) ;;
  *) echo "✗ arch 只支持 amd64 / arm64，收到: $ARCH" >&2; exit 1 ;;
esac
PLATFORM="linux/$ARCH"
VOL="tianshu-build-$ARCH"
OUT="out/linux-$ARCH"
# 镜像源可覆盖：Docker Hub 间歇性阻断时用 IMG=docker.m.daocloud.io/library/ubuntu:22.04
# 等国内 mirror。注意 OrbStack 复用同 tag 本地镜像会无视 --platform——按 digest
# 拉取后本地 tag 成固定名（如 ubuntu-amd64:22.04）再传 IMG 更稳。
IMG="${IMG:-ubuntu:22.04}"

if [ -z "${RIVET_RELEASE_KEY_PKCS8:-}" ] && [ -f "$HOME/.tianshu/release.key" ]; then
  RIVET_RELEASE_KEY_PKCS8="$(cat "$HOME/.tianshu/release.key")"
fi
if [ -z "${RIVET_RELEASE_KEY_PKCS8:-}" ]; then
  echo "✗ 缺 RIVET_RELEASE_KEY_PKCS8（完整性签名必带，同 mac/windows 打包纪律）" >&2
  exit 1
fi
# updater 私钥：本地容器与宿主同一信任域（密钥本就在本机）。与
# build-macos-release.sh 同口径——把 PATH 解析成内容经 env 注入（tauri CLI
# 只读 TAURI_SIGNING_PRIVATE_KEY 本体，不读 _PATH；release 脚本的 PATH→内容
# 导出曾在这里踩空一次）。CI 场景（密钥进 GitHub Secrets）才是「本地补签」
# 流程存在的理由，别混用。
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -f "$HOME/.tauri/tianshu.key" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/tianshu.key")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
fi
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "✗ 缺 updater 签名私钥（TAURI_SIGNING_PRIVATE_KEY 或 ~/.tauri/tianshu.key）" >&2
  exit 1
fi

echo "=== 准备镜像 $IMG ($PLATFORM) ==="
IMAGE_ID=""
IMAGE_PLATFORM=""
inspect_build_image() {
  local info
  IMAGE_ID=""
  IMAGE_PLATFORM=""
  # 新 Docker 可直接选择多架构本地缓存；旧引擎回落到元数据校验，仍禁止架构不符。
  info="$(docker image inspect --platform "$PLATFORM" "$IMG" --format '{{.Id}} {{.Os}}/{{.Architecture}}' 2>/dev/null)" ||
    info="$(docker image inspect "$IMG" --format '{{.Id}} {{.Os}}/{{.Architecture}}' 2>/dev/null)" || return 1
  read -r IMAGE_ID IMAGE_PLATFORM <<< "$info"
  [[ "$IMAGE_ID" =~ ^sha256:[[:xdigit:]]{64}$ ]] && [[ "$IMAGE_PLATFORM" == "$PLATFORM" ]]
}
# 只有目标平台已缓存时才跳过网络；存在同名的另一架构镜像不能视为命中。
if inspect_build_image; then
  echo "  本地已有 ${IMG}（${IMAGE_PLATFORM}），跳过 pull"
else
  docker pull --platform "$PLATFORM" "$IMG"
  if ! inspect_build_image; then
    echo "✗ 镜像元数据无效或平台不符：需要 ${PLATFORM}，实际 ${IMAGE_PLATFORM:-未知}；停止构建" >&2
    exit 1
  fi
fi

docker volume rm -f "$VOL" >/dev/null 2>&1 || true
docker volume create "$VOL" >/dev/null
RUN_ARGS=(-d --pull=never --platform "$PLATFORM" -v "$VOL":/work \
  -e RIVET_RELEASE_KEY_PKCS8="$RIVET_RELEASE_KEY_PKCS8" \
  -e TAURI_SIGNING_PRIVATE_KEY \
  -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
# 容器内下载代理（可选）：nodejs.org/rustup 直连被掐时，
# CONTAINER_PROXY=http://host.docker.internal:7890 走宿主代理（OrbStack 内置该域名）。
if [ -n "${CONTAINER_PROXY:-}" ]; then
  DOWNLOAD_NO_PROXY="localhost,127.0.0.1,mirrors.aliyun.com,docker.m.daocloud.io"
  RUN_ARGS+=(-e HTTP_PROXY="$CONTAINER_PROXY" -e HTTPS_PROXY="$CONTAINER_PROXY"
    -e http_proxy="$CONTAINER_PROXY" -e https_proxy="$CONTAINER_PROXY"
    -e NO_PROXY="$DOWNLOAD_NO_PROXY" -e no_proxy="$DOWNLOAD_NO_PROXY")
fi
# 使用刚校验过的不可变 ID，避免 tag 在检查后被另一次构建切换架构。
CID="$(docker run "${RUN_ARGS[@]}" "$IMAGE_ID" sleep infinity)"
cleanup() { docker rm -f "$CID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "=== 拷贝源码 → 容器卷（排除 .git/target/node_modules/release/out）==="
# ⚠ AppleDouble 陷阱（2026-09-29 v3.27.0 linux 打包实证，已隔离复现）：
# 宿主上带扩展属性（ls 的 `@` 标记）的文件，经 `docker cp` **落盘到卷时**会多出一个
# `._<name>` 伴随文件。实测：`tar cf -` 的流里**没有** `._*` 条目（栈内只列正常文件），
# 但落盘后 `._custom-commands.toml` 就出现了；且它**沿用源文件 mtime**（看着像上轮
# 构建的旧残留，极易误判成"卷没清干净"）。容器里 tauri 读 permissions/*.toml 时会把它
# 当真正的 toml → `stream did not contain valid UTF-8`，构建直接失败。
# 判据：同目录不带 xattr 的 .toml 没有伴随文件——根因在 xattr，不在文件内容。
# 注意 COPYFILE_DISABLE 与 --exclude='._*' 对**本问题无效**（二者管 tar 打包侧，
# 而 `._*` 是落盘侧生成的）；保留它们只作同类问题的低成本防御。
# 真正解决的是拷贝之后那道 find -delete（实测一次构建会残留 2743 个）。
#
# ⚠ provenance xattr 陷阱（2026-10-14 v3.31.0 实证）：macOS Sequoia+ 的
# com.apple.provenance 是 SIP 受保护 xattr——用户态删不掉（xattr -d exit 0 但属性
# 立即回写），docker cp 解包端会对它 lsetxattr → Linux 卷不支持 →
# "Error response from daemon: lsetxattr ... com.apple.provenance: no such file or
# directory" 整次拷贝失败。防御：入向改用容器端 GNU tar 解包（tar 流本身不含
# macOS xattr，GNU tar 也不会尝试还原），彻底绕开 docker cp 的 xattr 语义。
COPYFILE_DISABLE=1 tar cf - --exclude=.git \
  --exclude='src-tauri/target' --exclude='desktop/src-tauri/target' \
  --exclude='*/node_modules' --exclude=release --exclude=out \
  --exclude='._*' . \
  | docker exec -i "$CID" tar -x -C /work --no-same-owner
# 清理已落盘的 AppleDouble 残留（tar 行为或 Docker 卷写入都可能带入）
docker exec "$CID" sh -c "find /work -name '._*' -delete 2>/dev/null || true"

echo "=== 容器内构建（${ARCH}，首次含 apt/npm/cargo 全量下载，30 分钟级）==="
docker exec "$CID" bash /work/scripts/linux-container-build.sh

echo "=== 取回产物 → $OUT/ ==="
mkdir -p "$OUT"
rm -f "$OUT"/*.AppImage "$OUT"/*.AppImage.sig 2>/dev/null || true
docker cp "$CID":/work/desktop/src-tauri/target/release/bundle/appimage/. "$OUT"/
ls -lh "$OUT"/*.AppImage
echo "✅ 完成：$OUT/*.AppImage（签名在宿主机用 tauri signer 补，同 CI 后处理流程）"

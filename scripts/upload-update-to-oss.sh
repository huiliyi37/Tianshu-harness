#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="$SCRIPT_DIR/releases/publish-oss.mjs"
GUARD="$SCRIPT_DIR/releases/guard-stable-publication.mjs"
OSSUTIL="${OSSUTIL_BIN:-ossutil}"
DRY_RUN="${DRY_RUN:-0}"
ASSETS_ONLY=0
ARGS=()
case "$DRY_RUN" in 0|1) ;; *) echo "DRY_RUN must be 0 or 1" >&2; exit 2 ;; esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      printf '%s\n' 'Usage: bash scripts/upload-update-to-oss.sh [--assets-only] [--version X.Y.Z] [--catalog FILE] [--manifest FILE] [--assets DIR] [--control FILE] [--dry-run|--publish]' 'Default: mirror the controlled stable release. DRY_RUN=1 is read-only; candidates require --assets-only and explicit candidate version/metadata.'
      exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --publish) DRY_RUN=0; shift ;;
    --assets-only) ASSETS_ONLY=1; ARGS+=("$1"); shift ;;
    --version|--catalog|--manifest|--assets|--control)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || { echo "Missing publisher option value" >&2; exit 2; }
      ARGS+=("$1" "$2"); shift 2 ;;
    *) echo "Unknown publisher option" >&2; exit 2 ;;
  esac
done

umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tianshu-oss-publish.XXXXXX")"
trap 'STATUS=$?; rm -rf -- "$WORK"; exit "$STATUS"' EXIT
if [ "${#ARGS[@]}" -gt 0 ]; then
  node "$HELPER" prepare "$WORK" "${ARGS[@]}"
else
  node "$HELPER" prepare "$WORK"
fi
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY RUN：GitHub 资产、签名、catalog 与目标对象已校验；未上传，未改变稳定入口或控制面。"
  exit 0
fi

while IFS= read -r KEY; do
  [ -n "$KEY" ] || continue
  node "$HELPER" upload "$WORK" "$KEY"
done < "$WORK/assets.tsv"
if [ "$ASSETS_ONLY" = 1 ]; then
  node "$HELPER" verify "$WORK"
  echo "候选资产上传完成：仅 immutable 版本包与原始签名；稳定入口、版本 metadata 和控制面未写入。"
  exit 0
fi

while IFS= read -r KEY; do
  [ -n "$KEY" ] || continue
  node "$HELPER" upload "$WORK" "$KEY"
done < "$WORK/metadata.tsv"

VERSION="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1])).version' "$WORK/plan.json")"
stable_guard() {
  node "$HELPER" guard "$WORK"
  node --input-type=module -e '
    const { readFileSync } = await import("node:fs");
    const { pathToFileURL } = await import("node:url");
    const { guardStablePublication } = await import(pathToFileURL(process.argv[1]).href);
    await guardStablePublication(process.argv[2], readFileSync(process.argv[3]));
  ' "$GUARD" "$VERSION" "$WORK/release-catalog.json" 2>/dev/null || { echo "Controlled stable version/catalog guard rejected publication" >&2; exit 1; }
}

CATALOG_STATUS="$(node "$HELPER" check "$WORK" tianshu/release-catalog.json)"
if [ "$CATALOG_STATUS" = upload ]; then
  stable_guard
  "$OSSUTIL" cp "$WORK/release-catalog.json" oss://tianshu-update/tianshu/release-catalog.json --cache-control no-cache --content-type application/json -f > /dev/null 2>&1 || { echo "OSS stable catalog upload incomplete; retry validates existing bytes" >&2; exit 1; }
  node "$HELPER" verify "$WORK" tianshu/release-catalog.json
fi
MANIFEST_STATUS="$(node "$HELPER" check "$WORK" tianshu/latest.json)"
if [ "$MANIFEST_STATUS" = upload ]; then
  stable_guard
  "$OSSUTIL" cp "$WORK/latest-oss.json" oss://tianshu-update/tianshu/latest.json --cache-control no-cache --content-type application/json -f > /dev/null 2>&1 || { echo "OSS stable manifest upload incomplete; retry validates existing bytes" >&2; exit 1; }
  node "$HELPER" verify "$WORK" tianshu/latest.json
fi
node "$HELPER" guard "$WORK"
node "$HELPER" verify "$WORK"
echo "OSS 镜像完成：版本资产与签名已匿名回读；catalog 精确字节 pin 保持，稳定 manifest 已改写，控制面未修改。"

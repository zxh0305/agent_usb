#!/bin/sh
# 随身 Agent 盘 · node 引导下载(macOS / Linux)
#
# 场景:插到一台**什么都没装**的电脑上 —— 盘内没有 runtime/(不入库),
# 系统里也没有 node。启动器本身跑在 node 上,先有鸡还是先有蛋,
# 所以这一步只能在 shell 里用 curl 完成:下载官方发行包,只取 bin/node
# 这一个文件放进盘内(和 build-local.sh 的做法一致,那边有详细注释)。
#
# 用法: sh tools/fetch-node.sh [os] [arch]
#   参数缺省 = 当前平台。成功时把 node 可执行文件的路径写到 stdout 最后一行。
#
# 下载源:默认 官方 nodejs.org → npmmirror 镜像 依次尝试;
# 可用 USB_AGENT_NODE_DIST 指定一个或多个(逗号分隔),如内网镜像。
# 版本默认取 tools/NODE_VER,可用 USB_AGENT_NODE_VER 覆盖。
set -e

OS=${1:-$(uname -s)}
ARCH=${2:-$(uname -m)}
case "$OS" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
esac
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
esac

HERE=$(cd "$(dirname "$0")" && pwd)
USB=$(cd "$HERE/.." && pwd)
PLAT="$OS-$ARCH"

NODE_VER=${USB_AGENT_NODE_VER:-$(cat "$HERE/NODE_VER" 2>/dev/null || echo 24.21.0)}
DEST="$USB/runtime/node/$PLAT/bin"
MARK="$USB/runtime/node/$PLAT/.node-version"

# 平台名 → 官方发行包的 dist 目录与归档后缀
case "$PLAT" in
  darwin-arm64) DIST=darwin-arm64; EXT=tar.gz ;;
  darwin-x64)   DIST=darwin-x64;   EXT=tar.gz ;;
  linux-x64)    DIST=linux-x64;    EXT=tar.xz ;;
  linux-arm64)  DIST=linux-arm64;  EXT=tar.xz ;;
  *) echo "✗ 没有该平台的 node 发行版:$PLAT" >&2; exit 1 ;;
esac
ARCHIVE="node-v$NODE_VER-$DIST.$EXT"

SITES=${USB_AGENT_NODE_DIST:-"https://nodejs.org/dist,https://npmmirror.com/mirrors/node"}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/usb-agent-node.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# ★ 本脚本的 stdout 会被调用方 $( ) 捕获,所以一切状态信息都走 stderr,
#   只有最后一行(node 的路径)走 stdout。
echo "  本机没有可用的 node,开始下载(版本 v$NODE_VER,约 30~50MB)…" >&2
ok=0
OLDIFS=$IFS
IFS=,
for SITE in $SITES; do
  URL=$(printf '%s' "$SITE" | sed 's:/*$::')/v$NODE_VER/$ARCHIVE
  echo "  源      $URL" >&2
  if curl -fL --progress-bar --max-time 900 -o "$WORK/$ARCHIVE" "$URL"; then ok=1; break; fi
  echo "  这个源失败,换下一个…" >&2
done
IFS=$OLDIFS
[ "$ok" = 1 ] || { echo "✗ 所有下载源都失败了(检查网络,或用 USB_AGENT_NODE_DIST 指定镜像)" >&2; exit 1; }

case "$EXT" in
  tar.gz) tar -xzf "$WORK/$ARCHIVE" -C "$WORK" ;;
  tar.xz) tar -xJf "$WORK/$ARCHIVE" -C "$WORK" ;;
esac
SRC=$(find "$WORK" -path '*/bin/node' -type f | head -1)
[ -n "$SRC" ] || { echo "✗ 归档里找不到 node 可执行文件" >&2; exit 1; }

mkdir -p "$DEST"
cp "$SRC" "$DEST/node"
printf '%s\n' "$NODE_VER" > "$MARK"
# macOS 在 exFAT 上会生成 ._ 边车文件,清掉(与 build-local.sh 收尾一致)
find "$USB/runtime" -name '._*' -delete 2>/dev/null || true
echo "  ✓ 已装到 $DEST/node" >&2
echo "$DEST/node"

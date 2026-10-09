#!/bin/sh
# 随身 Agent 盘 · 本地构建脚本
#
# ★ 必须在本地磁盘上执行,不能在 U 盘上直接跑。
#   原因:exFAT 不支持软链接与硬链接,npm 无法在盘上安装。
#   本脚本在本地构建好,再把"只有普通文件"的产物拷进 U 盘。
#
# 用法:
#   sh tools/build-local.sh                        默认构建 darwin-arm64 + win32-x64 + linux-x64
#   sh tools/build-local.sh darwin-arm64           只构建指定平台
#   sh tools/build-local.sh darwin-arm64 win32-x64 linux-x64 darwin-x64 linux-arm64
#
# 可覆盖变量:
#   NODE_VER=24.21.0   要打包的 Node 版本
#   CC_VER=2.1.295     要打包的 Claude Code 版本(与平台包版本必须一致)
#   WORK=/tmp/usb-agent-build   本地工作目录
#   USB=/Volumes/agent_usb      目标盘(默认自动识别为脚本所在盘的根)
set -e

USB=$(cd "$(dirname "$0")/.." && pwd)
NODE_VER=${NODE_VER:-24.21.0}
CC_VER=${CC_VER:-2.1.295}
WORK=${WORK:-/tmp/usb-agent-build}
PLATS=${*:-darwin-arm64 win32-x64 linux-x64}

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '   \033[31m✗\033[0m %s\n' "$*" >&2; }

# 平台名 → Node 官方发行包的 <dist> 与归档后缀
node_dist() {
  case "$1" in
    darwin-arm64) echo "darwin-arm64 tar.gz" ;;
    darwin-x64)   echo "darwin-x64 tar.gz" ;;
    linux-x64)    echo "linux-x64 tar.xz" ;;
    linux-arm64)  echo "linux-arm64 tar.xz" ;;
    win32-x64)    echo "win-x64 zip" ;;
    win32-arm64)  echo "win-arm64 zip" ;;
    *) bad "未知平台: $1(可用: darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64 win32-arm64)"; return 1 ;;
  esac
}
# 平台名 → 平台包内的二进制文件名
bin_name() {
  case "$1" in win32-*) echo "claude.exe" ;; *) echo "claude" ;; esac
}
node_bin_name() {
  case "$1" in win32-*) echo "node.exe" ;; *) echo "node" ;; esac
}

rm -rf "$WORK"; mkdir -p "$WORK"

# ─────────────── 1. 打包各平台 Node 运行时 ───────────────
for P in $PLATS; do
  say "Node 运行时 · $P"
  set -- $(node_dist "$P"); DIST=$1; EXT=$2

  if [ "$EXT" = "zip" ]; then
    ARCHIVE="node-v$NODE_VER-$DIST.zip"
  elif [ "$EXT" = "tar.xz" ]; then
    ARCHIVE="node-v$NODE_VER-$DIST.tar.xz"
  else
    ARCHIVE="node-v$NODE_VER-$DIST.tar.gz"
  fi

  # 已经构建过同版本就跳过下载(重跑很快)
  DEST="$USB/runtime/node/$P/bin"
  MARK="$USB/runtime/node/$P/.node-version"
  if [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$NODE_VER" ] && [ -f "$DEST/$(node_bin_name "$P")" ]; then
    ok "$P 已是 $NODE_VER,跳过"
    continue
  fi

  URL="https://nodejs.org/dist/v$NODE_VER/$ARCHIVE"
  echo "   下载 $URL"
  curl -fsSL --max-time 600 -o "$WORK/$ARCHIVE" "$URL" || { bad "下载失败"; exit 1; }

  mkdir -p "$DEST"
  case "$EXT" in
    zip)
      unzip -q -o "$WORK/$ARCHIVE" "$(node_bin_name "$P")" -d "$WORK/x" 2>/dev/null || \
        { mkdir -p "$WORK/x"; unzip -q -o "$WORK/$ARCHIVE" -d "$WORK/x"; }
      SRC=$(find "$WORK/x" -name "$(node_bin_name "$P")" -type f | head -1)
      ;;
    *)
      tar -xf "$WORK/$ARCHIVE" -C "$WORK/x" 2>/dev/null || { mkdir -p "$WORK/x"; tar -xf "$WORK/$ARCHIVE" -C "$WORK/x"; }
      SRC=$(find "$WORK/x" -path '*/bin/*' -name "$(node_bin_name "$P")" -type f | head -1)
      ;;
  esac
  [ -n "$SRC" ] && [ -f "$SRC" ] || { bad "在归档里找不到 node 二进制"; exit 1; }

  # ★ 只拷这一个文件:完整 Node 树有 4797 个文件,在 exFAT 上要写 20 分钟以上;
  #   而 Claude Code 是原生二进制、不需要 Node,Node 只是给启动器脚本用的。
  cp "$SRC" "$DEST/$(node_bin_name "$P")"
  printf '%s\n' "$NODE_VER" > "$MARK"
  rm -rf "$WORK/x"
  ok "$P → runtime/node/$P/bin/$(node_bin_name "$P")  ($(du -h "$DEST/$(node_bin_name "$P")" | cut -f1))"
done

# ─────────────── 2. 构建 Claude Code ───────────────
say "Claude Code · 主包 $CC_VER"
mkdir -p "$WORK/cc"
cd "$WORK/cc"
npm init -y >/dev/null 2>&1
# --ignore-scripts:跳过 postinstall(它会把平台二进制复制成 239MB 的重复文件)
npm install --no-audit --no-fund --ignore-scripts "@anthropic-ai/claude-code@$CC_VER" >/dev/null 2>&1
[ -d node_modules/@anthropic-ai/claude-code ] || { bad "主包安装失败"; exit 1; }
ok "主包已安装"

# 主包自带一份平台二进制(bin/),我们改用按平台分目录的方式,删掉这份重复的
rm -rf node_modules/@anthropic-ai/claude-code/bin

for P in $PLATS; do
  say "Claude Code · 平台包 $P"
  PKG="@anthropic-ai/claude-code-$P"
  npm pack "$PKG@$CC_VER" --silent >/dev/null 2>&1 || { bad "$PKG 拉取失败(该平台可能无独立包)"; continue; }
  TGZ=$(ls -t ./*.tgz 2>/dev/null | head -1)
  [ -n "$TGZ" ] || { bad "$PKG 打包失败"; continue; }
  mkdir -p "node_modules/$PKG"
  tar -xzf "$TGZ" -C "node_modules/$PKG" --strip-components=1
  rm -f "$TGZ"
  ok "$PKG → node_modules/$PKG/$(bin_name "$P")"
done

# npm 会建 node_modules/.bin/<命令> 软链接。exFAT 上它会变成 Apple 的 XSym 假软链
# (macOS 上看着像软链,拿到 Windows/Linux 就是一个内容为路径文本的普通文件),必须删掉。
# 我们直接调用平台包里的二进制,本来就不需要 .bin。
rm -rf node_modules/.bin

# ─────────────── 2b. 第三方 agent:aichat(单文件,约 9MB)───────────────
AICHAT_VER=${AICHAT_VER:-0.30.0}
aichat_asset() {
  case "$1" in
    darwin-arm64) echo "aarch64-apple-darwin tar.gz" ;;
    darwin-x64)   echo "x86_64-apple-darwin tar.gz" ;;
    win32-x64)    echo "x86_64-pc-windows-msvc zip" ;;
    linux-x64)    echo "x86_64-unknown-linux-musl tar.gz" ;;
    linux-arm64)  echo "aarch64-unknown-linux-musl tar.gz" ;;
    *) return 1 ;;
  esac
}
for P in $PLATS; do
  say "aichat · $P"
  SPEC=$(aichat_asset "$P") || { bad "aichat 没有 $P 的发行版,跳过"; continue; }
  set -- $SPEC; DIST=$1; EXT=$2
  MARK="$USB/app/aichat/$P/.version"
  DEST="$USB/app/aichat/$P"
  if [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$AICHAT_VER" ] && [ -x "$DEST/aichat" ]; then
    ok "$P 已是 $AICHAT_VER,跳过"; continue
  fi
  if [ "$EXT" = "zip" ]; then ARCH="aichat-v$AICHAT_VER-$DIST.zip"; else ARCH="aichat-v$AICHAT_VER-$DIST.tar.gz"; fi
  URL="https://github.com/sigoden/aichat/releases/download/v$AICHAT_VER/$ARCH"
  echo "   下载 $URL"
  curl -fsSL --max-time 600 -o "$WORK/$ARCH" "$URL" || { bad "下载失败(网络?)"; continue; }
  rm -rf "$WORK/ai"; mkdir -p "$WORK/ai" "$DEST"
  if [ "$EXT" = "zip" ]; then unzip -q -o "$WORK/$ARCH" -d "$WORK/ai"; else tar -xzf "$WORK/$ARCH" -C "$WORK/ai"; fi
  SRC=$(find "$WORK/ai" -type f -name 'aichat*' ! -name '*.tar.gz' ! -name '*.zip' | head -1)
  [ -n "$SRC" ] || { bad "归档里没找到 aichat"; continue; }
  NAME=aichat; [ "$P" = "win32-x64" ] && NAME=aichat.exe
  cp "$SRC" "$DEST/$NAME"
  printf '%s\n' "$AICHAT_VER" > "$MARK"
  ok "$P → app/aichat/$P/$NAME ($(du -h "$DEST/$NAME" | cut -f1))"
done
rm -rf "$WORK/ai"

# ─────────────── 3. 拷入 U 盘 ───────────────
say "拷入 U 盘"
APP="$USB/app/claude"
rm -rf "$APP"
mkdir -p "$APP"
# 注意:目录不存在时 cp -R src dst 才会把 src 放进 dst;这里已保证目标不存在
cp -R "$WORK/cc/node_modules" "$APP/node_modules"
printf '%s\n' "$CC_VER" > "$APP/VERSION"
ok "$APP/node_modules"

# ─────────────── 4. 收尾:清 AppleDouble、查软链 ───────────────
say "收尾"
find "$USB/app" "$USB/runtime" -name '._*' -delete 2>/dev/null || true
command -v dot_clean >/dev/null 2>&1 && dot_clean -m "$USB/app" "$USB/runtime" 2>/dev/null || true
LK=$(find "$USB/app" "$USB/runtime" -type l 2>/dev/null | wc -l | tr -d ' ')
[ "$LK" = "0" ] && ok "无软链接(exFAT 要求)" || bad "发现 $LK 个软链接,跨平台会失效!"

say "完成"
echo "   平台:      $PLATS"
echo "   Node:      $NODE_VER"
echo "   Claude Code: $CC_VER"
echo "   盘上占用:  $(du -sh "$USB/app" "$USB/runtime" | tr '\n' ' ')"
echo
echo "   验证一下:  sh tools/claude.sh --check"

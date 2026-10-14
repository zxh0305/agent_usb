#!/bin/sh
# 随身 Agent 盘 · 启动入口(macOS / Linux)
#
# 用法:
#   sh tools/claude.sh                      启动(用上次的供应商)
#   sh tools/claude.sh --provider deepseek  指定供应商
#   sh tools/claude.sh --list               列出供应商
#   sh tools/claude.sh --check              只测连通性
#   sh tools/claude.sh -- -p "问题"          -- 之后的参数原样透传给 claude
#
# node 从哪来(依次):
#   1. 盘内 runtime/node/<平台>/bin/node(便携,首选)
#   2. 宿主机自己装的 node(要求 ≥18,启动器用到 fetch)
#   3. 都没有 → 当场自动下载一份进盘里(见 tools/fetch-node.sh)
# 所以在一台**完全没配置**的电脑上,克隆下来第一次启动也能跑起来:
# 先自动装 node,面板里选 Claude Code 再自动装它。
#
# 注意:exFAT 上没有可执行位,所以要用 `sh tools/claude.sh` 而不是 ./tools/claude.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
USB=$(cd "$HERE/.." && pwd)

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "✗ 不支持的系统:$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "✗ 不支持的架构:$(uname -m)" >&2; exit 1 ;;
esac

node_major() { "$1" --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }

NODE="$USB/runtime/node/$OS-$ARCH/bin/node"
if [ ! -f "$NODE" ]; then
  SYS=$(command -v node 2>/dev/null || true)
  MAJOR=0
  [ -n "$SYS" ] && MAJOR=$(node_major "$SYS" || echo 0)
  # 宿主 node 太老(启动器用到 fetch 等 18+ 的能力)宁可下载新的,也别跑一半报奇怪的错
  if [ -n "$SYS" ] && [ "$MAJOR" -ge 18 ] 2>/dev/null; then
    NODE="$SYS"
  else
    if [ -n "$SYS" ]; then
      echo "  宿主机的 node 版本太旧(v${MAJOR},需要 ≥18),改为下载盘内运行时…"
    fi
    NODE=$(sh "$HERE/fetch-node.sh" "$OS" "$ARCH" | tail -1) || NODE=""
    if [ -z "$NODE" ] || [ ! -f "$NODE" ]; then
      echo "✗ 自动下载 node 失败。可以:" >&2
      echo "    · 装一个 node(≥18)后重跑" >&2
      echo "    · 或先在有网的电脑上跑 tools/build-local.sh 构建后拷入盘内" >&2
      exit 1
    fi
  fi
fi

exec "$NODE" "$HERE/launch.mjs" "$@"

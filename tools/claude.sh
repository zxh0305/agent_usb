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
# 注意:exFAT 上没有可执行位,所以要用 `sh tools/claude.sh` 而不是 ./tools/claude.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

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

NODE="$HERE/../runtime/node/$OS-$ARCH/bin/node"
if [ ! -f "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE" ] || [ ! -f "$NODE" ]; then
  echo "✗ 找不到可用的 node 运行时。请先运行 tools/build-local.sh 构建后拷入盘内。" >&2
  exit 1
fi

exec "$NODE" "$HERE/launch.mjs" "$@"

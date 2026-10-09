#!/bin/sh
# 随身 Agent 盘 · 体检入口(macOS / Linux)
# 用法: sh tools/doctor.sh [--clean] [--probe]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "不支持的系统" >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; esac
NODE="$HERE/../runtime/node/$OS-$ARCH/bin/node"
[ -f "$NODE" ] || NODE=$(command -v node)
exec "$NODE" "$HERE/doctor.mjs" "$@"

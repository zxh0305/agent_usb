#!/bin/sh
# 随身 Agent 盘 · 便携环境变量(供人工使用)
#
# 用途:想手动进一个"所有配置都落在 U 盘上"的 shell 时:
#     sh tools/env.sh          # 或者  . tools/env.sh && sh
#
# 注意:正常运行 Claude Code 不需要这个 —— tools/launch.mjs 会在进程内自己设置全部变量,
# 且天然跨平台。本文件只是给"想手敲命令"的场景用的便利入口。
#
# exFAT 上没有可执行位,用 `sh tools/env.sh` 调用。

USB=$(cd "$(dirname "$0")/.." && pwd)
H="$USB/data/home"

mkdir -p "$H" "$USB/tmp"

# 伪 HOME:遮住 ~/.claude.json 等硬编码家目录的路径
export HOME="$H"
export CLAUDE_CONFIG_DIR="$H/.claude"

# 关自动更新与非必要外联(便携盘必须)
export DISABLE_AUTOUPDATER=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export DISABLE_BUG_COMMAND=1
export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1

# 第三方网关:剥掉实验性 beta 头
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export API_TIMEOUT_MS=600000

# 临时目录与 npm 缓存都落盘
export TMPDIR="$USB/tmp"
export NPM_CONFIG_CACHE="$USB/data/cache/npm"

# PATH:盘上的 node 优先
case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; esac
NODE_BIN="$USB/runtime/node/$OS-$ARCH/bin"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

echo "  便携环境已就绪(HOME → U 盘)"
echo "    HOME              = $HOME"
echo "    CLAUDE_CONFIG_DIR = $CLAUDE_CONFIG_DIR"
echo "    PATH(node)        = $NODE_BIN"

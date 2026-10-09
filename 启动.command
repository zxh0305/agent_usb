#!/bin/sh
# 双击我 —— macOS
# 打开随身 Agent 盘的面板;退出后自动关闭本终端窗口。
#
# 想保留窗口(方便看输出):
#   在「终端 → 设置 → 描述文件 → Shell → 当 shell 退出时」里改成"保持窗口",
#   或者用 `USB_AGENT_KEEP_OPEN=1 sh 启动.command` 启动。
cd "$(dirname "$0")" || exit 1
clear
sh tools/claude.sh

# 兜底:万一面板进程被强杀,终端可能还停在 raw 模式
stty sane 2>/dev/null || true

if [ "${USB_AGENT_KEEP_OPEN:-0}" != "1" ] && command -v osascript >/dev/null 2>&1; then
  # 关闭本窗口。注意 osascript 控制"终端"属于 macOS 的自动化权限,
  # 第一次可能会弹一次授权框;拒绝的话就退化成下面的"按回车关闭"。
  WIN=$(osascript -e 'tell application "Terminal" to id of front window' 2>/dev/null)
  if [ -n "$WIN" ]; then
    ( sleep 1; osascript -e "tell application \"Terminal\" to close (every window whose id is $WIN)" >/dev/null 2>&1 ) &
    exit 0
  fi
fi

printf '\n按回车键关闭窗口…'
read -r _ || true

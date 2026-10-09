#!/bin/sh
# 双击我 —— macOS
# 打开随身 Agent 盘的面板;退出后尝试自动关闭本终端窗口。
#
# 想保留窗口(方便看输出):
#   · 用 USB_AGENT_KEEP_OPEN=1 sh 启动.command 启动;或
#   · 把「终端 → 设置 → 描述文件 → Shell → 当 shell 退出时」改成"保持窗口"
cd "$(dirname "$0")" || exit 1
clear
sh tools/claude.sh

# 兜底:万一面板进程被强杀,终端可能还停在 raw 模式
stty sane 2>/dev/null || true

# ★ 顺序很重要:先把提示打出来,再去尝试自动关闭。
#   之前是先尝试关闭、然后直接 exit —— 一旦关闭失败(通常是因为没授予 macOS
#   的"自动化"权限),窗口就停在一个"没人读键盘"的死终端上,连可以按的回车
#   提示都没有,只能干看着。提示先打印,最差情况也只是退化成按回车。
printf '\n已退出。\n'
printf '  · 想让窗口自动关闭:授予「终端」的自动化权限,或把「终端 → 设置 → 描述文件 → Shell → 当 shell 退出时」设为“关闭窗口”。\n'
printf '  · 现在按回车即可关闭本窗口。\n'

if [ "${USB_AGENT_KEEP_OPEN:-0}" != "1" ] && command -v osascript >/dev/null 2>&1; then
  # 整段放到后台:查询窗口 id 时 macOS 可能弹"自动化"授权框,
  # 放在前台会把脚本卡在那里。后台执行则无论如何都会走到下面的 read。
  (
    WIN=$(osascript -e 'tell application "Terminal" to id of front window' 2>/dev/null)
    if [ -n "$WIN" ]; then
      sleep 1
      osascript -e "tell application \"Terminal\" to close (every window whose id is $WIN)" >/dev/null 2>&1
    fi
  ) &
fi

read -r _ || true

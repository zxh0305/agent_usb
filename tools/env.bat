@echo off
rem 随身 Agent 盘 · 便携环境变量(供人工使用)
rem 用途:在 cmd 里执行 `tools\env.bat` 后,当前窗口的所有配置都落在 U 盘上。
rem 注意:正常运行 Claude Code 不需要这个 —— tools\launch.mjs 会自己设置全部变量。

set "USB=%~dp0.."
set "H=%USB%\data\home"
if not exist "%H%" mkdir "%H%"
if not exist "%USB%\tmp" mkdir "%USB%\tmp"

rem 伪 HOME:Windows 下必须同时覆盖这两个,否则配置会跑到宿主机
set "HOME=%H%"
set "USERPROFILE=%H%"
set "APPDATA=%H%\AppData\Roaming"
set "LOCALAPPDATA=%H%\AppData\Local"

set "CLAUDE_CONFIG_DIR=%H%\.claude"

set "DISABLE_AUTOUPDATER=1"
set "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
set "DISABLE_TELEMETRY=1"
set "DISABLE_ERROR_REPORTING=1"
set "DISABLE_BUG_COMMAND=1"
set "CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1"
set "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1"
set "API_TIMEOUT_MS=600000"

set "TEMP=%USB%\tmp"
set "TMP=%USB%\tmp"
set "NPM_CONFIG_CACHE=%USB%\data\cache\npm"

set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
set "PATH=%USB%\runtime\node\win32-%ARCH%\bin;%PATH%"

echo   便携环境已就绪(HOME -^> U 盘)
echo     HOME              = %HOME%
echo     CLAUDE_CONFIG_DIR = %CLAUDE_CONFIG_DIR%

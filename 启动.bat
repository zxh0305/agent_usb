@echo off
rem 双击我 —— Windows
rem 打开随身 Agent 盘的面板;脚本结束后控制台窗口会自动关闭。
rem 想保留窗口:在脚本末尾加一行 pause,或用 cmd 手动运行 tools\claude.bat
cd /d "%~dp0"
cls
call tools\claude.bat %*
rem 不用 pause —— 双击启动时窗口随脚本结束自动关闭
exit /b %errorlevel%

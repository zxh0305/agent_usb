@echo off
rem 随身 Agent 盘 · 启动入口(Windows)
rem
rem 用法:
rem   claude.bat                      启动(用上次的供应商)
rem   claude.bat --provider deepseek  指定供应商
rem   claude.bat --list               列出供应商
rem   claude.bat --check              只测连通性
setlocal EnableDelayedExpansion
set "HERE=%~dp0"

set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"

set "NODE=%HERE%..\runtime\node\win32-%ARCH%\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

where "%NODE%" >nul 2>nul
if errorlevel 1 (
  if /i not "%NODE%"=="node" (
    echo [x] 找不到 node 运行时。请先构建后拷入 runtime\node\win32-%ARCH%\
    exit /b 1
  )
)

"%NODE%" "%HERE%launch.mjs" %*
exit /b %errorlevel%

@echo off
rem 随身 Agent 盘 · 启动入口(Windows)
rem
rem 用法:
rem   claude.bat                      启动(用上次的供应商)
rem   claude.bat --provider deepseek  指定供应商
rem   claude.bat --list               列出供应商
rem   claude.bat --check              只测连通性
rem
rem node 从哪来(依次):
rem   1. 盘内 runtime\node\win32-<架构>\bin\node.exe(便携,首选)
rem   2. 宿主机自己装的 node(要求 >=18,启动器用到 fetch)
rem   3. 都没有 -> 当场下载一份进盘里(用 Windows 10 1803+ 自带的 curl.exe 和 tar.exe)
rem 所以在一台完全没配置的电脑上,克隆下来第一次启动也能跑起来:
rem 先自动装 node,面板里选 Claude Code 再自动装它。
setlocal EnableDelayedExpansion
set "HERE=%~dp0"

set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"

set "NODE=%HERE%..\runtime\node\win32-%ARCH%\bin\node.exe"
if exist "%NODE%" goto :run

rem ── 盘内没有:看宿主机有没有够新的 node ──
set "NMAJOR=0"
set "NVTOK="
for /f "tokens=1 delims=." %%v in ('node --version 2^>nul') do set "NVTOK=%%v"
if defined NVTOK set /a NMAJOR=%NVTOK:v=% >nul 2>nul
if %NMAJOR% GEQ 18 (
  set "NODE=node"
  goto :run
)

rem ── 宿主也没有(或太老):当场下载盘内运行时 ──
set "NODE_VER=24.21.0"
if exist "%HERE%NODE_VER" set /p NODE_VER=<"%HERE%NODE_VER"
set "DIST=win-%ARCH%"
set "ARCHIVE=node-v%NODE_VER%-%DIST%.zip"
set "TMPN=%TEMP%\usb-agent-node"
if not exist "%TMPN%" mkdir "%TMPN%"

echo   本机没有可用的 node,开始下载到盘内,版本 v%NODE_VER% ...
set "OK="
for %%S in ("https://nodejs.org/dist" "https://npmmirror.com/mirrors/node") do (
  if not defined OK (
    echo   源      %%~S/v%NODE_VER%/%ARCHIVE%
    curl.exe -fL --progress-bar -o "%TMPN%\%ARCHIVE%" "%%~S/v%NODE_VER%/%ARCHIVE%" && set "OK=1"
  )
)
if not defined OK (
  echo [x] 下载失败。请装一个 node,版本 18 或更高,然后重跑;
  echo     或先在有网的电脑上跑 tools\build-local.sh 构建后拷入盘内
  exit /b 1
)

tar -xf "%TMPN%\%ARCHIVE%" -C "%TMPN%" "node-v%NODE_VER%-%DIST%/node.exe"
if errorlevel 1 (
  echo [x] 解压失败:%TMPN%\%ARCHIVE%
  exit /b 1
)
if not exist "%HERE%..\runtime\node\win32-%ARCH%\bin" mkdir "%HERE%..\runtime\node\win32-%ARCH%\bin"
move /y "%TMPN%\node-v%NODE_VER%-%DIST%\node.exe" "%HERE%..\runtime\node\win32-%ARCH%\bin\node.exe" >nul
del /q "%TMPN%\%ARCHIVE%" >nul 2>nul
set "NODE=%HERE%..\runtime\node\win32-%ARCH%\bin\node.exe"
echo   已装到 runtime\node\win32-%ARCH%\bin\node.exe

:run
"%NODE%" "%HERE%launch.mjs" %*
exit /b %errorlevel%

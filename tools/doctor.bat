@echo off
rem 随身 Agent 盘 · 体检入口(Windows)
rem 用法: doctor.bat [--clean] [--probe]
setlocal
set "HERE=%~dp0"
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
set "NODE=%HERE%..\runtime\node\win32-%ARCH%\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%HERE%doctor.mjs" %*
exit /b %errorlevel%

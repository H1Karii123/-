@echo off
chcp 936 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没找到 node.exe，请先装 Node 22 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
echo 正在把这个插件接入 DSH...
node install.mjs %*
echo.
pause
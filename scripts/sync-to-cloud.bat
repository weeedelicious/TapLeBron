@echo off
chcp 65001 >nul
echo ================================================
echo   sate TV 工程同步到百度网盘
echo ================================================
echo.

:: 配置区域 — 修改这里
set PROJECTS_DIR=d:\AI\liblibtv\projects
set RCLONE_REMOTE=baidu:sate-tv-projects
set RCLONE_EXE=%~dp0rclone.exe

:: 检查 rclone
if not exist "%RCLONE_EXE%" (
  echo [错误] 未找到 rclone.exe，请下载并放到 scripts\ 目录
  echo 下载地址: https://rclone.org/downloads/
  pause
  exit /b 1
)

echo [开始] 同步工程到云端: %RCLONE_REMOTE%
echo.

"%RCLONE_EXE%" sync "%PROJECTS_DIR%" "%RCLONE_REMOTE%" ^
  --exclude "*.tmp" ^
  --exclude "_tmp/**" ^
  --transfers 8 ^
  --checkers 16 ^
  --progress ^
  --stats 5s

if %errorlevel% equ 0 (
  echo.
  echo [完成] 所有工程已同步到云端！
) else (
  echo.
  echo [警告] 同步时遇到错误，请检查网络或配置
)

echo.
pause

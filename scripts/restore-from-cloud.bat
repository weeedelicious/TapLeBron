@echo off
chcp 65001 >nul
echo ================================================
echo   sate TV 从百度网盘恢复工程
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

echo [警告] 此操作会将云端工程同步到本地：
echo   云端: %RCLONE_REMOTE%
echo   本地: %PROJECTS_DIR%
echo.
set /p confirm=确认继续？(y/N):
if /i not "%confirm%"=="y" (
  echo 已取消。
  pause
  exit /b 0
)

:: 确保本地目录存在
if not exist "%PROJECTS_DIR%" mkdir "%PROJECTS_DIR%"

echo.
echo [开始] 从云端恢复工程...
echo.

"%RCLONE_EXE%" sync "%RCLONE_REMOTE%" "%PROJECTS_DIR%" ^
  --exclude "*.tmp" ^
  --transfers 8 ^
  --checkers 16 ^
  --progress ^
  --stats 5s

if %errorlevel% equ 0 (
  echo.
  echo [完成] 工程已从云端恢复到本地！
  echo 请重启 sate TV 服务器使更改生效。
) else (
  echo.
  echo [警告] 恢复时遇到错误，请检查网络或配置
)

echo.
pause

@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  WorkBuddy 工作台 · Windows 启动器
REM  双击 = 优先注册任务计划守护（常驻：窗口关不掉/崩溃自启/开机自启）
REM  守护不可用时回退到最小化窗口方式（旧路径，关窗口服务停）。
REM  幂等，可重复双击。依赖 Win10+ 自带：curl.exe / netstat / PowerShell
REM ============================================================

REM —— 定位项目根（脚本在 scripts\ 下，项目根是其上级）——
cd /d "%~dp0.."
set "ROOT=%CD%"
set "URL=http://127.0.0.1:7788"
set "HEALTHZ=%URL%/healthz"

echo ==== WorkBuddy 工作台启动中... ====

REM 1. Node 检查（缺失不退出：守护脚本会自动下载便携版 Node，免管理员免安装器）
where node >nul 2>nul
if errorlevel 1 (
  echo [..] 未检测到 Node.js，将通过守护脚本自动下载便携版（约 25MB，1~3 分钟）...
) else (
  for /f "delims=" %%v in ('node -v') do echo [OK] Node %%v
)

REM 2. 已活则直接开浏览器（幂等）
curl -s -m 1 "%HEALTHZ%" 2>nul | findstr /c:"status" | findstr /c:"ok" >nul
if not errorlevel 1 (
  echo [OK] 服务已在运行，直接打开工作台
  start "" "%URL%"
  exit /b 0
)

REM 3. 优先：任务计划守护启动（常驻，推荐）
echo ==== 尝试守护启动（任务计划程序，常驻后台）... ====
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\workbuddy-daemon.ps1" start
if not errorlevel 1 exit /b 0

REM 4. 回退：最小化窗口方式（关窗口/重启电脑服务停）
echo.
echo [!] 守护启动不可用，回退到普通窗口方式（关闭「WorkBuddy 后端」窗口服务即停止）。

REM 便携版 Node（守护脚本装的）补进本窗口 PATH，回退路径的 npm 才能找到 node
if exist "%USERPROFILE%\.workbuddy-node\node.exe" set "PATH=%USERPROFILE%\.workbuddy-node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 未检测到 Node.js 且守护启动失败。
  echo     请到 https://nodejs.org 下载 LTS 版安装后，重新双击本脚本。
  pause
  exit /b 1
)

if not exist "%ROOT%\server\node_modules" (
  echo ==== 首次使用，安装依赖（约 1~2 分钟）... ====
  pushd "%ROOT%\server"
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    popd
    echo [X] npm install 失败，请检查网络后重试。
    pause
    exit /b 1
  )
  popd
  echo [OK] 依赖安装完成
)

echo ==== 启动后端服务（最小化窗口）... ====
start "WorkBuddy 后端" /MIN /D "%ROOT%\server" cmd /k "npm run dev"

echo ==== 等待服务就绪... ====
set /a n=0
:wait
curl -s -m 1 "%HEALTHZ%" 2>nul | findstr /c:"status" | findstr /c:"ok" >nul
if not errorlevel 1 goto ready
set /a n+=1
if %n% geq 30 goto fail
timeout /t 1 /nobreak >nul
goto wait

:ready
echo [OK] 工作台已就绪，正在打开浏览器
start "" "%URL%"
exit /b 0

:fail
echo [X] 服务 30 秒内未就绪
echo     请查看「WorkBuddy 后端」窗口的输出排查，或查看 logs\server.log
pause
exit /b 1

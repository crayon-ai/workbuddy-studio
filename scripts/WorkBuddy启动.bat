@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  WorkBuddy 工作台 · Windows 精简启动器
REM  双击 = 起后端（已活则复用）+ 开浏览器。幂等，可重复双击。
REM  依赖 Windows 10+ 自带工具：curl.exe / netstat / start / findstr
REM ============================================================

REM —— 定位项目根（脚本在 scripts\ 下，项目根是其上级）——
cd /d "%~dp0.."
set "ROOT=%CD%"
set "URL=http://127.0.0.1:7788"
set "HEALTHZ=%URL%/healthz"

echo ==== WorkBuddy 工作台启动中... ====

REM 1. Node 检查
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 未检测到 Node.js
  echo     请到 https://nodejs.org 下载 LTS 版并安装，装完重新双击本脚本。
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node %%v

REM 2. 已活则直接开浏览器（幂等）
curl -s -m 1 "%HEALTHZ%" 2>nul | findstr /c:"status" | findstr /c:"ok" >nul
if not errorlevel 1 (
  echo [OK] 服务已在运行，直接打开工作台
  start "" "%URL%"
  exit /b 0
)

REM 3. 端口被非 WorkBuddy 进程占用？
netstat -ano | findstr ":7788" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [X] 端口 7788 被其他程序占用
  echo     请关闭占用该端口的程序后重试。
  pause
  exit /b 1
)

REM 4. 依赖自举（首次双击时 node_modules 不存在）
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

REM 5. 后台起服务（独立最小化窗口，主窗口可关，服务常驻）
echo ==== 启动后端服务... ====
start "WorkBuddy 后端" /MIN /D "%ROOT%\server" cmd /k "npm run dev"

REM 6. 轮询健康检查，最多 30 秒
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
echo     请查看「WorkBuddy 后端」窗口的输出排查。
pause
exit /b 1

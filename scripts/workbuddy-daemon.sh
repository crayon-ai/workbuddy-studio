#!/usr/bin/env bash
# WorkBuddy 常驻后台守护（macOS）：把后端注册为 launchd LaunchAgent。
# 与启动它的会话（agent / 终端 / Claude Code）完全解耦——会话退出、终端关闭都不掉；
# 进程崩溃自动拉起；开机自动启动。launchd 原生能力，无需装 pm2 等任何依赖。
#
# 用法：
#   scripts/workbuddy-daemon.sh start     # 注册并启动（默认端口 7788，可用 PORT=7790 覆盖）
#   scripts/workbuddy-daemon.sh status    # 查看运行状态
#   scripts/workbuddy-daemon.sh stop      # 停止（本次；plist 保留，下次登录仍会自启）
#   scripts/workbuddy-daemon.sh uninstall # 彻底停止并删除 LaunchAgent（不再自启）
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$PROJECT_ROOT/server"
LABEL="com.workbuddy.studio"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-7788}"
URL="http://127.0.0.1:$PORT"
HEALTHZ="$URL/healthz"
LOG_DIR="$PROJECT_ROOT/logs"
LAUNCHD_LOG="$LOG_DIR/launchd.log"
UID_N="$(id -u)"

healthy() { curl -s -m 2 "$HEALTHZ" 2>/dev/null | grep -q '"status":"ok"'; }
loaded()  { launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; }

case "${1:-help}" in
start)
  command -v node >/dev/null 2>&1 || { echo "✗ 未检测到 Node.js，请先安装 Node 20+"; exit 1; }
  [ -d "$SERVER_DIR/node_modules" ] || { echo "==> 安装依赖…"; (cd "$SERVER_DIR" && npm install --no-fund --no-audit) || exit 1; }

  if healthy; then echo "✓ 工作台已在运行：$URL"; exit 0; fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✗ 端口 $PORT 被其他程序占用（lsof -i :$PORT 查看），换端口：PORT=7790 $0 start"
    exit 1
  fi

  # launchd 不走登录 shell 的 PATH，必须把解析好的绝对路径写进 plist
  NODE_BIN="$(command -v node)"
  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

  # 守护模式必须单进程直跑（tsx src/index.ts），不能走 npm run dev：
  # dev 是 tsx watch，子进程崩溃时 watch 层不退出、也不重启子进程，
  # launchd 只盯顶层进程，会被 watch 挡住失去崩溃拉起能力（实测踩坑）。
  TSX_BIN="$SERVER_DIR/node_modules/.bin/tsx"
  [ -x "$TSX_BIN" ] || { echo "✗ 缺少 $TSX_BIN，先 cd server && npm install"; exit 1; }

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$SERVER_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TSX_BIN</string>
    <string>src/index.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LAUNCHD_LOG</string>
  <key>StandardErrorPath</key><string>$LAUNCHD_LOG</string>
</dict>
</plist>
EOF

  # 幂等：旧注册先卸再挂（bootstrap 重复注册会报错）
  loaded && launchctl bootout "gui/$UID_N/$LABEL" >/dev/null 2>&1
  launchctl bootstrap "gui/$UID_N" "$PLIST" 2>/dev/null || launchctl load "$PLIST" >/dev/null 2>&1

  echo -n "==> 等待服务就绪"
  for _ in $(seq 1 30); do
    if healthy; then
      echo ""
      echo "✓ 常驻服务已就绪：$URL"
      echo "  守护方式：launchd（会话退出不掉、崩溃自动重启、开机自启）"
      echo "  停止：$0 stop    彻底移除：$0 uninstall"
      echo "  日志：${LOG_DIR}/server.log（应用）/ ${LAUNCHD_LOG}（npm/tsx 层）"
      [ "${WORKBUDDY_NO_OPEN:-0}" = "1" ] || open "$URL"
      exit 0
    fi
    echo -n "."; sleep 1
  done
  echo ""
  echo "✗ 30 秒未就绪，排查：tail -50 $LAUNCHD_LOG $LOG_DIR/server.log"
  exit 1
  ;;

status)
  if healthy; then echo "✓ 运行中：$URL"; else echo "✗ 未运行（$URL 无响应）"; fi
  if loaded; then
    echo "launchd：已注册（KeepAlive 崩溃自动重启）"
    launchctl print "gui/$UID_N/$LABEL" 2>/dev/null | grep -E '^\s+(state|pid)' | head -3
  else
    echo "launchd：未注册（当前实例非守护运行，agent 会话退出会掉）"
  fi
  ;;

stop)
  if loaded; then
    launchctl bootout "gui/$UID_N/$LABEL" && echo "✓ 已停止（plist 保留，下次登录/开机仍会自启）"
  else
    echo "launchd 未注册，无需停止"
  fi
  ;;

uninstall)
  loaded && launchctl bootout "gui/$UID_N/$LABEL" >/dev/null 2>&1
  rm -f "$PLIST"
  echo "✓ 已彻底移除 LaunchAgent（不再自启）"
  ;;

*)
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  ;;
esac

#!/usr/bin/env bash
# WorkBuddy 工作台 · 启动内核（被 .command 和 .app 共用）
# 逻辑：起后端（已活则复用）+ 开浏览器。幂等，可重复调用。
set -u

# —— 定位项目根（位置无关：交付解压到任意目录都能跑）——
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
URL="http://127.0.0.1:7788"
HEALTHZ="$URL/healthz"
LOG_DIR="$PROJECT_ROOT/logs"
LOG_FILE="$LOG_DIR/server.log"
BOOT_LOG="$LOG_DIR/boot.log"

# —— Node 自动安装（用户级，免 sudo）——
NODE_VERSION="v22.14.0"                       # LTS，升级改这一行
NODE_HOME="$HOME/.workbuddy-node"             # 免安装 Node 的落地目录（独占，避免与其他软件冲突）
MIRRORS=(
  "https://registry.npmmirror.com/-/binary/node"
  "https://nodejs.org/dist"
)

# —— 工具函数：原生弹窗报错（绝不静默失败；30 秒无操作自动关，避免挂死）——
alert() { # $1=标题 $2=正文
  osascript -e "display dialog \"$2\" with title \"$1\" buttons {\"好\"} default button \"好\" with icon caution giving up after 30" >/dev/null 2>&1 || true
}

# —— 工具函数：开浏览器（开发/测试时可 WORKBUDDY_NO_OPEN=1 跳过）——
maybe_open() {
  [ "${WORKBUDDY_NO_OPEN:-0}" = "1" ] || open "$URL"
}

# —— 工具函数：健康检查（通=0）。校验响应体，避免把"任何 200 的进程"误判成 WorkBuddy ——
healthy() {
  curl -s -m 1 "$HEALTHZ" 2>/dev/null | grep -q '"status":"ok"'
}

echo "==> WorkBuddy 工作台启动中…"

# —— 工具函数：自动安装免 sudo 的 Node（tar.xz 解压到 ~/.workbuddy/node）——
# 优先用系统 Node；没有则用已装好的用户级 Node；都没有则下载安装（国内镜像优先）。
ensure_node() {
  if command -v node >/dev/null 2>&1; then
    echo "✓ Node $(node -v)（系统）"
    return 0
  fi
  if [ -x "$NODE_HOME/bin/node" ]; then
    export PATH="$NODE_HOME/bin:$PATH"
    echo "✓ Node $($NODE_HOME/bin/node -v)（WorkBuddy 内置）"
    return 0
  fi

  # 需要下载安装（首次约 1~3 分钟）
  local arch pkg extract_dir tmp tarball
  case "$(uname -m)" in
    arm64)  arch="darwin-arm64" ;;
    x86_64) arch="darwin-x64" ;;
    *) arch="" ;;
  esac
  if [ -z "$arch" ]; then
    alert "WorkBuddy 无法启动" "未识别的电脑架构（$(uname -m)），无法自动安装 Node.js。\\n\\n请到 https://nodejs.org 手动下载安装。"
    return 1
  fi
  pkg="node-$NODE_VERSION-$arch"
  tmp="$(mktemp -d)"
  tarball="$tmp/$pkg.tar.xz"

  echo "==> 首次使用：自动下载 Node.js $NODE_VERSION（约 25MB，1~3 分钟）…"
  for mirror in "${MIRRORS[@]}"; do
    echo "    尝试下载源：$mirror"
    if curl -fL --retry 2 --connect-timeout 15 -o "$tarball" "$mirror/$NODE_VERSION/$pkg.tar.xz"; then
      break
    fi
    tarball=""   # 本源失败，试下一个
  done
  if [ -z "$tarball" ] || [ ! -s "$tarball" ]; then
    rm -rf "$tmp"
    alert "Node.js 下载失败" "自动下载 Node.js 失败，请检查网络后重试；\\n\\n或到 https://nodejs.org 手动下载安装后再双击。"
    return 1
  fi

  echo "==> 解压安装到 ~/.workbuddy-node …"
  if ! tar -xJf "$tarball" -C "$tmp"; then
    rm -rf "$tmp"
    alert "Node.js 安装失败" "解压下载的 Node.js 失败。\\n\\n可到 https://nodejs.org 手动下载安装后再双击。"
    return 1
  fi
  extract_dir="$tmp/node-$NODE_VERSION-$arch"
  rm -rf "$NODE_HOME"
  mkdir -p "$(dirname "$NODE_HOME")"
  mv "$extract_dir" "$NODE_HOME"
  rm -rf "$tmp"
  export PATH="$NODE_HOME/bin:$PATH"
  echo "✓ Node $($NODE_HOME/bin/node -v)（WorkBuddy 内置，已就绪）"
}

# 1. Node 检查 + 自动安装
mkdir -p "$LOG_DIR"
if ! ensure_node; then
  exit 1
fi

# 2. 拿启动锁（原子）：并发双击只让一个进程真正起服务，其余等待复用。
#    mkdir 是原子操作；锁内写持有者 PID，进程死掉时自愈清锁，避免死锁残留。
mkdir -p "$LOG_DIR"
LOCK_DIR="$LOG_DIR/start.lock"
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$LOCK_DIR" 2>/dev/null   # 持有者已死，清锁重试
    continue
  fi
  # 有别的进程正在起服务：等它起完直接复用
  echo "==> 已有启动进行中，等待服务就绪…"
  if healthy; then
    echo "✓ 服务已就绪，复用现有实例"
    maybe_open
    exit 0
  fi
  sleep 1
done
trap 'rm -rf "$LOCK_DIR"' EXIT        # 无论如何退出都释放锁
echo $$ > "$LOCK_DIR/pid"

# 3. 已活则直接开浏览器（幂等）
if healthy; then
  echo "✓ 服务已在运行，直接打开工作台"
  maybe_open
  exit 0
fi

# 4. 端口被非 WorkBuddy 进程占用？
if lsof -nP -iTCP:7788 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✗ 端口 7788 被其他程序占用"
  alert "WorkBuddy 无法启动" "端口 7788 被其他程序占用了。\\n\\n请关掉占用该端口的程序后重试，或重启电脑后再双击。"
  exit 1
fi

# 5. 依赖自举（交付场景首次双击时 node_modules 不存在）
if [ ! -d "$PROJECT_ROOT/server/node_modules" ]; then
  echo "==> 首次使用，安装依赖（约 1~2 分钟）…"
  ( cd "$PROJECT_ROOT/server" && npm install --no-fund --no-audit ) || {
    alert "WorkBuddy 依赖安装失败" "npm install 失败，请检查网络后重试。\\n\\n详细错误见上方终端输出。"
    exit 1
  }
  echo "✓ 依赖安装完成"
fi

# 6. 后台起服务（nohup 常驻，本窗口关闭不影响）
#    服务进程内部已 tee 到 logs/server.log（src/logger.ts），脚本这里只兜底丢弃输出，避免双写同一文件
echo "==> 启动后端服务…"
( cd "$PROJECT_ROOT/server" && nohup npm run dev >/dev/null 2>&1 & )

# 7. 轮询健康检查，最多 30 秒
echo -n "==> 等待服务就绪"
for i in $(seq 1 30); do
  if healthy; then
    echo ""
    echo "✓ 工作台已就绪，正在打开浏览器"
    maybe_open
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo ""
echo "✗ 服务 30 秒内未就绪"
alert "WorkBuddy 启动超时" "服务 30 秒内没有就绪。\\n\\n请把日志发给支持人员排查：\\n$LOG_FILE\\n\\n（在 Finder 中对 WorkBuddy 文件夹右键 → 新建位于文件夹位置的终端窗口，输入 open logs 查看日志）"
exit 1

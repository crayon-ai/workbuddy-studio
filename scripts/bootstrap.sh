#!/usr/bin/env bash
# WorkBuddy 一键启动：检测 Node → 装后端依赖 → 配 API key → 起服务 → 开浏览器。
# 面向 agent 启动（agent 读 AGENT.md 后跑此脚本），也可手动跑。
set -e

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"
echo "==> WorkBuddy 启动"
echo "项目根：$PROJECT_ROOT"

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node.js。请先装 Node 20+（https://nodejs.org），或让 agent 读 AGENT.md 自动装。"
  exit 1
fi
echo "✓ Node $(node -v)"

# 2. 装后端依赖
echo "==> 装后端依赖"
( cd server && npm install )

# 3. API key（环境变量优先；否则留空，前端首次访问时配置）
ENV_FILE="server/.env"
if [ ! -f "$ENV_FILE" ] || ! grep -q "^ANTHROPIC_API_KEY=sk-" "$ENV_FILE"; then
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "✓ 从环境变量写入 server/.env"
  else
    echo "⚠ 未配置 ANTHROPIC_API_KEY。请在浏览器首次访问时配置，或手动写入 server/.env，或让 agent 读 AGENT.md 代你配置。"
  fi
fi

# 4. 开浏览器 + 起后端（前台）
echo "==> 启动后端 http://127.0.0.1:7788"
( command -v open >/dev/null 2>&1 && open http://127.0.0.1:7788 ) \
  || ( command -v xdg-open >/dev/null 2>&1 && xdg-open http://127.0.0.1:7788 ) \
  || true
cd server && npm run dev

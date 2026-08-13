#!/usr/bin/env bash
# 仅启动后端（假设依赖已装）。首次使用请跑 bootstrap.sh，或让 agent 读 AGENT.md。
set -e
cd "$(dirname "$0")/.."
cd server
[ -d node_modules ] || npm install
npm run dev

#!/usr/bin/env bash
# WorkBuddy 工作台 · 桌面启动器（终端版，可看进度）
# 双击 = 起后端 + 开浏览器。核心逻辑在 workbuddy-launch.sh（与 .app 共用）。
cd "$(dirname "$0")"
exec ./workbuddy-launch.sh

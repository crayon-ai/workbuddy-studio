#!/usr/bin/env bash
# 在桌面创建指向 WorkBuddy.app 的 Finder 替身。
# 内核脚本：可被 安装到桌面.command 双击调用，也可直接在终端跑。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
APP="$PROJECT_ROOT/WorkBuddy.app"

alert() { # $1=标题 $2=正文
  osascript -e "display dialog \"$2\" with title \"$1\" buttons {\"好\"} default button \"好\" with icon note" >/dev/null 2>&1 || true
}

# 若 .app 不存在，先生成
if [ ! -d "$APP" ]; then
  echo "==> 未发现 WorkBuddy.app，先生成…"
  "$SCRIPT_DIR/make-app.sh" || {
    alert "安装失败" "生成 WorkBuddy.app 失败。\\n\\n可退回使用 scripts/ 里的「WorkBuddy启动器.command」（终端版）手动启动。"
    exit 1
  }
fi

# AppleScript 创建替身（POSIX file 转义路径，中文路径安全）
osascript <<APPLE
tell application "Finder"
  set targetFile to POSIX file "$APP" as alias
  set desktopFolder to desktop as alias
  -- 已有同名替身先删（进废纸篓），保证重复安装幂等
  set existingPath to (POSIX path of desktopFolder) & "WorkBuddy 工作台"
  try
    delete (POSIX file existingPath as alias)
  end try
  make new alias at desktopFolder to targetFile
  set name of result to "WorkBuddy 工作台"
end tell
APPLE

alert "安装完成" "桌面已创建「WorkBuddy 工作台」图标。\\n\\n双击它即可启动工作台。\\n\\n首次双击若提示\"无法验证开发者\"：请在桌面图标上右键 → 打开 → 再点\"打开\"。"
echo "✓ 桌面替身已创建：WorkBuddy 工作台"

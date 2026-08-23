#!/usr/bin/env bash
# 生成 WorkBuddy.app（macOS 主入口：图标 + 无终端闪烁）。
# 产物：项目根目录下的 WorkBuddy.app（不进 git，打包时自动生成）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
APP="${1:-$PROJECT_ROOT/WorkBuddy.app}"   # 可选输出路径（打包时生成到包里）
ICNS="$PROJECT_ROOT/assets/WorkBuddy.icns"

# —— 前置检查 ——
command -v osacompile >/dev/null 2>&1 || { echo "✗ 缺少 osacompile（macOS 自带，异常）"; exit 1; }
[ -f "$ICNS" ] || { echo "✗ 缺少图标 assets/WorkBuddy.icns，请先生成"; exit 1; }

# —— 1. AppleScript 源码（双击后台调启动内核，不弹终端、不阻塞）——
#    输出落到 logs/boot.log（首次下载 Node/npm install 的进度可查），而非丢弃。
APPLESCRIPT=$(cat <<'EOF'
on run
	set mePath to POSIX path of (path to me)
	set rootPath to do shell script "dirname " & quoted form of mePath
	do shell script "mkdir -p " & quoted form of (rootPath & "/logs") & " && nohup " & quoted form of (rootPath & "/scripts/workbuddy-launch.sh") & " >>" & quoted form of (rootPath & "/logs/boot.log") & " 2>&1 &"
end run
EOF
)

# —— 2. 编译成 .app ——
rm -rf "$APP"
osacompile -o "$APP" -e "$APPLESCRIPT"

# —— 3. 替换默认 applet 图标为我们的 logo ——
#    新系统（Big Sur+）优先用 Assets.car 里的命名图标，故删掉它并移除 CFBundleIconName，
#    让系统回退到 CFBundleIconFile 指向的 applet.icns（我们替换过的）。
cp "$ICNS" "$APP/Contents/Resources/applet.icns"
rm -f "$APP/Contents/Resources/Assets.car"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true

# —— 4. 改显示名（Info.plist 的 CFBundleName）——
/usr/libexec/PlistBuddy -c "Set :CFBundleName WorkBuddy" "$APP/Contents/Info.plist" 2>/dev/null || true

# —— 5. 清理编译残留的隔离属性，避免"无法验证开发者" ——
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "✓ 已生成 $APP"

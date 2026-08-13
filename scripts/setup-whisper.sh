#!/usr/bin/env bash
# 视频拆解工具链：装 ffmpeg + whisper.cpp，并起 whisper server（端口 2022）。
# 仅在需要「视频拆解」时运行；图文拆解 + 标题生成不需要。
set -e

echo "==> 安装 ffmpeg"
if ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install ffmpeg
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y ffmpeg
  else
    echo "✗ 未识别的包管理器，请手动安装 ffmpeg（https://ffmpeg.org）"
    exit 1
  fi
fi
echo "✓ ffmpeg $(ffmpeg -version | head -1)"

echo "==> 安装 whisper.cpp"
WHISPER_DIR=${WHISPER_DIR:-$HOME/whisper.cpp}
if [ ! -d "$WHISPER_DIR" ]; then
  git clone https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
fi
cd "$WHISPER_DIR"
make
if [ ! -f models/ggml-base.bin ]; then
  echo "==> 下载中文 base 模型"
  bash models/download-ggml-model.sh base
fi

echo "==> 启动 whisper server（端口 2022，后台运行）"
./build/bin/whisper-server --port 2022 --model models/ggml-base.bin &
echo "✓ 视频工具就绪。重启 WorkBuddy 后端后，/api/config 的 videoReady 应为 true。"

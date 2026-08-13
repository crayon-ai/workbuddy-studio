# 视频转逐字稿 — 命令参考

这些命令在**用户真实环境**执行（ffmpeg 与本地 Whisper 都在用户机器上），用 `user_exec` 运行，需用户批准。

## 1. 提取音频为 16kHz 单声道 WAV

```bash
ffmpeg -i "输入视频.mp4" -ar 16000 -ac 1 -c:a pcm_s16le "/tmp/audio_16k.wav" -y
```

## 2. 调用本地 Whisper 服务转写（默认端口 2022，中文）

本地 Whisper 多为 **whisper.cpp server（OpenAI 兼容）**，正确端点是 `/v1/audio/transcriptions`：

```bash
curl -s -X POST http://127.0.0.1:2022/v1/audio/transcriptions \
  -F "file=@/tmp/audio_16k.wav" \
  -F "language=zh" \
  -F "response_format=verbose_json"
```

- 拿 `verbose_json` 才有带时间戳的 `segments`，按其切分并保留 `[mm:ss]` 标记。
- 若返回 `File Not Found`，多半是端点写错（不是 `/inference`）；先用 `curl http://127.0.0.1:2022/` 或探测 `/v1/audio/transcriptions` 确认。
- 输出可能是**繁体**，需转简体后再写入逐字稿。
- 如端口不同，向用户确认实际端口。

## 3. 清理临时文件

```bash
rm -f /tmp/audio_16k.wav
```

## 逐字稿文件格式

```markdown
> 来源：[[原视频文件名.mp4]]
> 时长：约 X 分 Y 秒
> 转写：本地 Whisper (language=zh)

[00:00] 第一句……
[00:12] 第二句……
```

按内容分章节（用 `## 一、xxx` 小标题），每段保留起始时间戳。

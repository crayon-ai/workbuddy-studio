---
name: workbuddy
description: 本地运行的自媒体工作台（网页应用，数据存用户浏览器，不上云）：灵感/选题/素材/爆款拆解/标题生成/待办/日历/复盘。Use when 用户要启动/跑起来/打开/使用 自媒体工作台、自媒体创作工作台、内容生产工作台，或刚装好这个 skill 想把它用起来。本 skill 自动检测 Node.js、安装后端依赖、启动本地服务（127.0.0.1:7788）并打开浏览器；API key 由用户在网页「设置」里填写。
---

# 自媒体工作台 · 一键启动

一个本地运行的自媒体创作全流程工作台。数据存在用户自己的浏览器里（localStorage），不上云、不外传。启动后浏览器打开 http://127.0.0.1:7788 即可使用。

## 安装（把这个 skill 装进 Claude Code）

把整个 skill 文件夹放到 Claude Code 的 skills 目录（文件夹名随意，skill 靠 `name: workbuddy` 字段识别）：

- **个人级**（所有项目都能用）：`~/.claude/skills/workbuddy/`
- **或项目级**：某个项目的 `.claude/skills/workbuddy/`

放好后，跟 Claude Code 说一句「**启动自媒体工作台**」即可。

## 启动步骤

### 0. 先定位并 cd 进本 skill 的项目文件夹（关键，必须先做）

本 skill 把整个项目打包成一个 skill，下面的 `cd server`、`scripts/...` 全部**相对于「包含此 SKILL.md 的文件夹」**。用户通常是在别的项目里全局调起本 skill，此时你的 cwd 不在这里，**必须先找到本 skill 文件夹并 cd 进去**，否则 `cd server` 会报「no such file」。

用项目里唯一的 `自媒体工作台.html` 作锚来定位：
- 命令：`find ~/.claude/skills -name "自媒体工作台.html" -exec dirname {} \; | head -1`
- 拿到绝对路径后 `cd` 进去，并**记下这个路径**。
- 若上面找不到（用户装成了项目级 skill）：去对应项目目录下用同样的 `find` 找。
- 提醒：若你的运行环境每次 Bash 调用不保留 cwd，下面所有 `cd server` 都要换成 `cd "<上面找到的路径>/server"`。

### 1. 检测 Node.js 20+
- 命令：`node -v`
- 缺失（Mac）：优先 `brew install node`；若没装 Homebrew，引导用户去 https://nodejs.org 下载 .pkg 安装包双击安装（对小白最简单），装完重开终端再继续。

### 2. 装后端依赖
- 命令：`cd server && npm install`
- 首次约 1~2 分钟，等它跑完。

### 3. 启动后端（后台运行，不要阻塞当前会话）
- 命令：`cd server && npm run dev`（放到后台运行）
- 判定启动成功：后端日志出现 `WorkBuddy 后端已启动：http://127.0.0.1:7788`；或轮询 `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7788`，返回 `200` 即成功（首次 tsx 编译需几秒，最多等约 30 秒）。
- 若 7788 被占用：用环境变量 `PORT=7789` 重启，并告诉用户改开 http://127.0.0.1:7789。

### 4. 打开浏览器
- Mac：`open http://127.0.0.1:7788`

### 5. 配置 API key（关键，必须引导用户完成）
浏览器打开工作台后：
- 引导用户点工作台的「设置」入口（齿轮 / 侧边栏）。
- 让用户**自己**粘贴 API key 并保存。
- 支持两种 key：
  - **智谱（推荐）**：国内免翻墙、人民币付费，open.bigmodel.cn 注册获取。
  - **Anthropic 官方**：`sk-ant-...`，需翻墙 + 外币卡。

> ⚠️ **本 skill 绝不碰 `server/.env`，也不替用户写 key。** key 一律由用户在网页「设置」里自己填写、自己保存。

## 验收（确认跑通了）
- 浏览器打开 http://127.0.0.1:7788 能看到工作台，控制台无报错。
- 「设置」里 API key 显示已配置。
- 标题生成：输入主题，3~8 秒出 5 个标题。
- 图文拆解：粘一个小红书图文链接，1~3 分钟出拆解卡片。

## 可选：视频拆解（图文拆解 + 标题生成不需要，可跳过）
仅当用户要拆解**视频**笔记时才需要：
- ffmpeg：`brew install ffmpeg`
- whisper.cpp server（端口 2022）：`scripts/setup-whisper.sh`（自动 clone + make + 下载模型 + 起 server）

只做图文拆解和标题生成，直接跳过本节。

## 故障排查
| 现象 | 处理 |
|---|---|
| 端口 7788 占用 | 设 `PORT=7789` 重启，浏览器改开 http://127.0.0.1:7789 |
| 标题/拆解 skill 没被调用 | 确认 `.claude/skills/baokuan-chaijie/SKILL.md`、`xhs-title-psych/SKILL.md` 存在；后端 cwd 是这个 skill 文件夹的根目录 |
| API key 报 401 / 报错 | 引导用户在「设置」里重新填 key（智谱填 token，Anthropic 填 sk-ant-） |
| 标题/拆解很慢 | 正常，AI 调用需 3 秒~3 分钟，前端有进度展示，耐心等 |

## 关键路径与机制（出问题时看）
- 后端入口：`server/src/index.ts`（Fastify，只听 127.0.0.1:7788）。
- skill 加载：后端用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，`settingSources:["project"]` + `cwd=项目根` → 自动加载 `.claude/skills/` 下的子 skill（`baokuan-chaijie`、`xhs-title-psych`）。
- 数据：业务数据全在前端 localStorage（选题/待办/日历/复盘/拆解历史），后端无状态，重启不丢前端数据。

## 合规
仅用于个人学习与内容研究，尊重原作者版权，不用于二次分发。

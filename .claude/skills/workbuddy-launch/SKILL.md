---
name: workbuddy-launch
description: 启动 WorkBuddy 自媒体工作台（本地端口 7788）。Use when 用户要启动/跑起来/安装/打开/开始使用 WorkBuddy、自媒体工作台、自媒体创作工作台、内容生产工作台，或刚拿到这个项目文件夹想把它运行起来。本 skill 自动检测 Node.js、安装后端依赖、启动 Fastify 服务并打开浏览器。API key 由用户在工作台网页「设置」里填写，本 skill 不碰 .env。
---

# WorkBuddy 工作台 · 一键启动

把 WorkBuddy 自媒体工作台在用户电脑上跑起来，浏览器打开 http://127.0.0.1:7788 即可使用。

## 目标

启动本地后端（Fastify，端口 7788，只监听 127.0.0.1），并自动打开浏览器。两个核心 AI 功能：
- **标题生成**：输入主题 → 调 `xhs-title-psych` skill → 5 个小红书爆款标题。
- **爆款拆解**：粘贴小红书链接 → 调 `baokuan-chaijie` skill → 9 维度拆解。

## 启动步骤

### 1. 检测 Node.js 20+
- 命令：`node -v`
- 缺失（Mac）：优先 `brew install node`；若没装 Homebrew，引导用户去 https://nodejs.org 下载 .pkg 安装包双击安装（对小白最简单），装完重开终端再继续。

### 2. 装后端依赖
- 命令：`cd server && npm install`
- 首次约 1~2 分钟，等它跑完。

### 3. 启动后端（后台运行，不要阻塞当前会话）
- 命令：`cd server && npm run dev`（放到后台）
- 等待日志出现 `Server listening at http://127.0.0.1:7788`，即启动成功。
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
| 标题/拆解 skill 没被调用 | 确认 `.claude/skills/baokuan-chaijie/SKILL.md`、`xhs-title-psych/SKILL.md` 存在；后端 cwd 是项目根 |
| API key 报 401 / 报错 | 引导用户在「设置」里重新填 key（智谱填 token，Anthropic 填 sk-ant-） |
| 标题/拆解很慢 | 正常，AI 调用需 3 秒~3 分钟，前端有进度展示，耐心等 |

## 关键路径与机制（出问题时看）
- 后端入口：`server/src/index.ts`（Fastify，只听 127.0.0.1:7788）。
- skill 加载：后端用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，`settingSources:["project"]` + `cwd=项目根` → 自动加载 `.claude/skills/` 下的 skill。
- 数据：业务数据全在前端 localStorage（选题/待办/日历/复盘/拆解历史），后端无状态，重启不丢前端数据。

## 合规
仅用于个人学习与内容研究，尊重原作者版权，不用于二次分发。

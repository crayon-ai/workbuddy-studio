---
name: workbuddy-launch
description: 启动 WorkBuddy 自媒体工作台（本地端口 7788，常驻后台守护）。Use when 用户要启动/跑起来/安装/打开/开始使用 WorkBuddy、自媒体工作台、自媒体创作工作台、内容生产工作台，或刚拿到这个项目文件夹想把它运行起来。本 skill 在 macOS 上用 launchd 守护启动（会话退出不掉、崩溃自动拉起、开机自启），自动检测 Node.js、安装后端依赖、启动 Fastify 服务并打开浏览器。API key 由用户在工作台网页「设置」里填写，本 skill 不碰 .env。
---

# WorkBuddy 工作台 · 一键启动（常驻守护）

把 WorkBuddy 自媒体工作台在用户电脑上跑起来，浏览器打开 http://127.0.0.1:7788 即可使用。

## 目标

启动本地后端（Fastify，端口 7788，只监听 127.0.0.1）并自动打开浏览器。核心要求：**服务必须常驻**——agent 会话退出、终端关闭、进程崩溃都不能让工作台掉线。

## 启动步骤（macOS，默认路径）

### 1. 检测 Node.js 20+
- 命令：`node -v`
- 缺失（Mac）：优先 `brew install node`；若没装 Homebrew，引导用户去 https://nodejs.org 下载 .pkg 安装包双击安装（对小白最简单），装完重开终端再继续。

### 2. 一条命令守护启动
- 命令：`scripts/workbuddy-daemon.sh start`
- 脚本自动完成：装依赖（若缺）→ 注册 launchd LaunchAgent → 起服务 → 等就绪（最多 30 秒）→ 开浏览器。
- 成功标志：输出 `✓ 常驻服务已就绪：http://127.0.0.1:7788`。
- 若 7788 被占用：`PORT=7789 scripts/workbuddy-daemon.sh start`，并告诉用户改开 http://127.0.0.1:7789。
- 验证守护身份：`scripts/workbuddy-daemon.sh status` 应显示 `launchd：已注册`。

> ⚠️ **不要用 `npm run dev` 起常驻服务**——它是你会话的子进程，会话结束服务就死；且 tsx watch 会挡住崩溃自愈。开发调试才用它。

### 3. 非 macOS（Windows / Linux）
- 跑 `scripts/bootstrap.sh`（装依赖 + 起服务 + 开浏览器），并明确告知用户：此方式服务与当前会话绑定，关闭后需重新启动。

### 4. 配置 API key（关键，必须引导用户完成）
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
| 端口 7788 占用 | `PORT=7789 scripts/workbuddy-daemon.sh start`，浏览器改开 http://127.0.0.1:7789 |
| 守护启动 30 秒未就绪 | `tail -50 logs/launchd.log logs/server.log`；残留进程 `pkill -9 -f "server/node_modules/.bin/tsx"` 清掉再 start |
| 服务一会就自动关了 | 不是守护方式启动。`scripts/workbuddy-daemon.sh status` 查守护身份，`start` 重新注册 |
| 标题/拆解 skill 没被调用 | 确认 `.claude/skills/baokuan-chaijie/SKILL.md`、`xhs-title-psych/SKILL.md` 存在；后端 cwd 是项目根 |
| API key 报 401 / 报错 | 引导用户在「设置」里重新填 key（智谱填 token，Anthropic 填 sk-ant-） |
| 标题/拆解很慢 | 正常，AI 调用需 3 秒~3 分钟，前端有进度展示，耐心等 |

## 关键路径与机制（出问题时看）
- 后端入口：`server/src/index.ts`（Fastify，只听 127.0.0.1:7788）。
- 守护脚本：`scripts/workbuddy-daemon.sh`（launchd 注册；start/status/stop/uninstall）。服务进程父级为 launchd（PPID=1），与 agent 会话零关联。
- skill 加载：后端用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，`settingSources:["project"]` + `cwd=项目根` → 自动加载 `.claude/skills/` 下的 skill。
- 日志：`logs/server.log`（应用日志，任何启动方式都落盘）、`logs/launchd.log`（守护模式 npm/tsx 层）。
- 数据：业务数据全在前端 localStorage（选题/待办/日历/复盘/拆解历史），后端无状态，重启不丢前端数据。

## 合规
仅用于个人学习与内容研究，尊重原作者版权，不用于二次分发。

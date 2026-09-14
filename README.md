# WorkBuddy · 自媒体创作工作台

面向个人自媒体博主的内容生产全流程工作台：灵感采集 → 选题管理 → 素材积累 → **爆款拆解** → **标题生成** → 每日待办 → 发布排期 → 发布后复盘。

标题生成和爆款拆解通过本地后端**真正调用 AI skill** 执行（Claude Agent SDK），其余流程在前端 localStorage 里跑。

---

## 快速开始

### 方式 A：用 agent 启动（推荐，小白友好）

1. 装一个能执行 shell 的 agent（Claude Code / Cursor 等）。
2. 把本项目文件夹交给它，说「帮我跑起来」。
3. agent 会读 [`AGENT.md`](./AGENT.md)，自动装 Node、依赖，跑 `scripts/workbuddy-daemon.sh start` **守护启动**（macOS：launchd 守护——agent 会话退出不掉、进程崩溃自动拉起、开机自启），并打开浏览器。
4. 浏览器打开 http://127.0.0.1:7788 即可。

> 小白只需「装个 agent + 把文件夹给它」，环境补齐全由 agent 完成。守护启动后工作台常驻后台，随时访问。

### 常驻服务管理（守护启动后）

```bash
# macOS
scripts/workbuddy-daemon.sh start     # 守护启动（幂等，已运行则直接复用）
scripts/workbuddy-daemon.sh status    # 查看运行/守护状态
scripts/workbuddy-daemon.sh stop      # 本次停止（开机仍会自启）
scripts/workbuddy-daemon.sh uninstall # 彻底移除守护（不再自启）

# Windows（或直接双击 scripts\WorkBuddy启动.bat，效果相同）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\workbuddy-daemon.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\workbuddy-daemon.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\workbuddy-daemon.ps1 stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\workbuddy-daemon.ps1 uninstall
```

守护方式：macOS 用 launchd、Windows 用任务计划程序（用户级，免管理员权限）——窗口关闭、agent 会话退出、进程崩溃都不掉，开机自动启动。

**没有 Node.js 也不用先装**：两个平台的守护脚本检测到缺失时都会自动下载用户级便携版 Node（macOS → `~/.workbuddy-node`，Windows → `~\.workbuddy-node`，国内镜像优先，免管理员/免安装向导），装完继续自动启动。

### 手机访问（同一 WiFi 扫码即用）

服务启动后自动监听局域网，电脑端工作台侧边栏点 **「手机访问」**，手机扫二维码即可打开（已自动授权，可「添加到主屏幕」当 App 用）。

- 安全：随机 token 门禁（`data/lan-token.txt`，长期有效），同 WiFi 他人无法直接访问。
- 本机使用不受任何影响；想彻底关掉局域网模式：启动前设 `WB_HOST=127.0.0.1`。
- **手机与电脑数据自动同步**：数据统一存在这台电脑的 `data/sync.json`（不上云），手机端改动秒级互通；电脑换 WiFi 后 IP 可能变化，重新扫码即可。

服务日志：`logs/server.log`（应用，任何平台任何启动方式都落盘）/ `logs/launchd.log`（macOS 守护层）。

### 方式 B：手动启动

前置：Node.js 20+、Anthropic API key。

```bash
# 一键（装依赖 + 配 key + 起服务 + 开浏览器）
./scripts/bootstrap.sh

# 或分步
cd server && npm install
echo "ANTHROPIC_API_KEY=sk-你的key" > server/.env
cd .. && ./scripts/start.sh
```

浏览器打开 http://127.0.0.1:7788。首次访问若 API key 没配，按页面提示配置。

---

## 功能就绪情况

| 功能 | 是否需要额外工具 |
|---|---|
| 选题 / 待办 / 日历 / 复盘 | 开箱即用（前端 localStorage） |
| **标题生成** | 开箱即用（Node + API key） |
| **图文拆解** | 开箱即用（curl 系统自带） |
| **视频拆解** | 需额外装 ffmpeg + whisper.cpp：`./scripts/setup-whisper.sh` |

---

## 你需要准备

- **API key**（智谱或 Anthropic，在网页「设置」里填写；见上方说明）
- **Node.js 20+**（没有也行：守护脚本会自动下载便携版，无需手动安装）
- 视频拆解额外需要 ffmpeg + whisper.cpp（脚本会装）

---

## 项目结构

```
自媒体工作台.html      前端
server/               Node + Fastify + Agent SDK 后端
.claude/skills/       自带 skill（爆款拆解 / 标题生成）
scripts/              workbuddy-daemon（守护）/ bootstrap / start / setup-whisper
AGENT.md              给执行 agent 的启动规约（核心）
CLAUDE.md             Claude Code 自动读
docs/superpowers/     设计 spec + 实现计划
```

## 工作机制（简述）

- 浏览器 → `localhost:7788` → Fastify 后端 → `@anthropic-ai/claude-agent-sdk` 的 `query()` 调用项目自带 skill。
- skill 文本里引用的 `analyze_image`/`parse_link` 等工具，agent 用原生能力（vision / Bash+curl）智能替代，**无需配置任何 MCP server**。
- 业务数据的**唯一真源是后端的 `data/sync.json`**（手机/电脑自动同步，详见「手机访问」节）；浏览器 localStorage 只作缓存与离线兜底，清缓存/换浏览器不丢数据。后端不可达时前端自动降级为纯本地模式，恢复后自动补推。

## 数据同步（设计备忘）

- 前端所有写入（`lsS`/`lsD`/账号清单等）统一挂脏标记，防抖 800ms POST `/api/sync`；启动时拉取水合，回到页面（visibilitychange）时拉取刷新，关页面前 sendBeacon 尽力推送。
- 合并粒度：账号×栏目级「后到推送覆盖」；账号清单按 id 并集；删除账号走墓碑（防迟到的旧数据复活）。冲突时间戳由服务端盖章，不受设备时钟影响。
- `data/sync.json` 原子落盘（tmp+rename）并保留 `.bak`/`.bak2` 双滚动备份，主文件损坏自动回退。

## 开发

```bash
cd server
npm test          # 后端单测
npm run dev       # tsx watch 热重载
```

设计与实现文档见 `docs/superpowers/`。

## 合规

仅用于个人学习与内容研究，尊重原作者版权，不用于二次分发。

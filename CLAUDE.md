# WorkBuddy 工作台

自媒体内容生产全流程工作台（灵感 / 选题 / 素材 / 爆款拆解 / 标题生成 / 待办 / 日历 / 复盘）。前端单文件 HTML + 本地 Node 后端（用 Claude Agent SDK 真正调用 skill）。

## 启动

**面向 agent 启动**：把本项目交给一个能执行 shell 的 agent（如 Claude Code），让它读 [AGENT.md](./AGENT.md) 自动补齐依赖并启动。

**手动启动**：`scripts/bootstrap.sh`（或见 README）。

## 项目结构要点

- `自媒体工作台.html` — 前端（localStorage 持久化业务数据）
- `server/` — Node + Fastify + Agent SDK 后端（`src/`：路由、skill-runner、task-store、config）
- `.claude/skills/` — 项目自带 skill（`baokuan-chaijie` 爆款拆解、`xhs-title-psych` 标题）
- `scripts/` — 启动与工具脚本（bootstrap / start / setup-whisper）
- `docs/superpowers/specs/` — 设计 spec
- `docs/superpowers/plans/` — 实现计划

## 开发

- 后端测试：`cd server && npm test`
- 后端开发：`cd server && npm run dev`（tsx watch）
- 设计与计划文档见 `docs/superpowers/`。

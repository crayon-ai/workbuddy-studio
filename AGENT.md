# WorkBuddy 工作台 · 启动指南（给执行 agent）

> 你（执行 agent）拿到这个项目后，读本文件，自动把 WorkBuddy 跑起来，让用户在浏览器用自媒体工作台（标题生成 + 爆款拆解）。

## 目标

启动本地后端（Fastify，端口 7788），浏览器打开 http://127.0.0.1:7788 即可使用。两个核心 AI 功能：
- **标题生成**：输入主题 → 调 `xhs-title-psych` skill → 5 个小红书爆款标题。
- **爆款拆解**：粘贴小红书链接 → 调 `baokuan-chaijie` skill → 9 维度拆解。

另外支持**手机在同一 WiFi 下扫码访问**（见下方「手机访问」），启动后无需额外操作。

## 前置条件（缺什么补什么，自动装）

按顺序检测，缺失就装：

1. **Node.js 20+**
   - 检测：`node -v`
   - 缺：Mac 用 `brew install node`；Windows 用 winget 或官网安装包；Linux 用 nvm/package manager。

2. **后端 npm 依赖**
   - 命令：`cd server && npm install`
   - 依赖含 `qrcode`（手机访问二维码生成用），必须装齐。

3. **Anthropic API key**
   - 检测：`server/.env` 是否含 `ANTHROPIC_API_KEY=sk-...`
   - 缺：**向用户索取** key，写入 `server/.env`（内容仅一行 `ANTHROPIC_API_KEY=sk-ant-...`，权限 0600）。也可让用户设环境变量 `ANTHROPIC_API_KEY`。

4. **ffmpeg（仅视频拆解需要）**
   - 检测：`ffmpeg -version`
   - 缺：`brew install ffmpeg`（Mac）/ `sudo apt-get install -y ffmpeg`（Linux）。
   - 用户只做图文拆解 + 标题生成可跳过。

5. **whisper.cpp server（仅视频拆解需要，端口 2022）**
   - 检测：`curl -s http://localhost:2022` 是否响应
   - 缺：跑 `scripts/setup-whisper.sh`（自动 clone + make + 下载模型 + 起 server）。
   - 同上，图文拆解可跳过。

## 启动

**第 0 步：先检测操作系统，选对脚本**（macOS 和 Windows 命令不同）：
- `uname -s` 输出 `Darwin` → macOS；`echo $env:OS` 输出 `Windows_NT`（或 `cmd /c ver`）→ Windows。
- 判断后按下面对应平台执行，不要跨平台套用。

- **macOS**：`scripts/workbuddy-daemon.sh start`
  - 把服务注册为 launchd LaunchAgent：**与你的会话彻底解耦**——你会话退出、终端关闭服务都不掉；进程崩溃自动拉起；开机自启。
  - 脚本自动完成：检测/下载 Node（若缺自动装便携版）→ 装依赖（若缺）→ 注册 → 起服务 → 等就绪 → 开浏览器。
  - 端口被占用时用 `PORT=7789 scripts/workbuddy-daemon.sh start` 换端口。
  - 其他命令：`status` 查状态 / `stop` 本次停止（开机仍自启）/ `uninstall` 彻底移除。
- **Windows**：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\workbuddy-daemon.ps1 start`
  - 原理同上，用 Windows 任务计划程序（Task Scheduler）实现常驻：用户级任务（不需要管理员权限）、崩溃自动重启、登录自启。
  - 脚本自动完成：检测/下载 Node（若缺自动装便携版 `~\.workbuddy-node`）→ 装依赖 → 注册 → 起服务 → 等就绪 → 开浏览器。
  - 其他命令：`status` / `stop` / `uninstall`（同样用 `powershell -File` 调用）；换端口加参数 `-Port 7790`。
  - 用户双击 `scripts\WorkBuddy启动.bat` 效果相同（优先守护，失败回退最小化窗口方式）。
  - 注意：用 `npm.cmd`（不是 `npm`，PowerShell 里裸 npm 是 .ps1 会受限）；PowerShell 5.1 里 `curl` 是 `Invoke-WebRequest` 的别名，代码里已显式用 `curl.exe`。
- Linux / 临时调试：`scripts/bootstrap.sh`（装依赖 + 起服务 + 开浏览器；服务生命周期与会话绑定）
- 手动开发调试：`cd server && npm run dev`，再打开 http://127.0.0.1:7788
- **任何平台都不要**用 `npm run dev` 起常驻服务——那是开发热重载模式，且作为你会话的子进程，会话结束服务就死；tsx watch 还会挡住守护层的崩溃自愈。

## 手机访问（局域网，启动后自动可用）

- 服务默认监听 `0.0.0.0:7788`（可用环境变量 `WB_HOST=127.0.0.1` 关掉局域网模式）。
- **门禁机制**：本机访问免鉴权；其他设备必须带 token——`data/lan-token.txt`（首启自动生成，长期有效）。首次通过 `/?t=<token>` 进入会种 HttpOnly cookie（一年），之后直接访问即可。无凭证的局域网请求一律 401（API 返回 `WB_LAN_TOKEN_REQUIRED`，页面返回引导页）。
- **用户入口**：电脑端工作台侧边栏「设置 → 手机访问」弹窗，展示二维码 + 链接 + 步骤指引，`GET /api/lan-info` 提供。
- 手机端可「添加到主屏幕」当 App 用（PWA：`/manifest.webmanifest` + `assets/icon-*`）。
- **数据同步**：业务数据唯一真源是后端 `data/sync.json`（`GET/POST /api/sync`，见 `server/src/sync-store.ts`），手机端与电脑端自动同步；浏览器 localStorage 只是缓存/离线兜底。后端不可达时前端自动降级纯本地模式（左下角离线横幅），恢复后自动补推。
- 电脑换 WiFi/重启后局域网 IP 可能变化，重新扫码即可。
- Windows 首次启动若弹防火墙放行询问，选「允许」。

## 验收（确认跑通了）

- 浏览器打开 http://127.0.0.1:7788 见工作台，控制台无报错。
- 「设置」/ 侧边栏状态显示 API key 已配置（或前端弹框能配）。
- 标题生成：输入主题，3~8 秒出 5 个标题。
- 图文拆解：粘一个小红书图文链接，1~3 分钟出拆解卡片。
- 视频拆解：装了 ffmpeg+whisper 后，粘视频链接能出含逐字稿的拆解。
- 手机访问：电脑端点「手机访问」能出二维码；手机（同 WiFi）扫码能打开工作台；直接输 IP 不带 token 显示引导页。
- 笔记优化：收录小红书笔记链接（或示例笔记）→ 勾选 → 优化初稿，走 writing-dna-skill（蒸馏缓存于 data/accounts/<acc>/polish/DNA/，勾选集合不变则复用）。注意：小红书反爬可能拦截裸链接下载（agent 只允许无凭证 curl，禁止登录/浏览器自动化）；被拦时用「收录一篇示例笔记」降级（mock 落盘，格式与真实笔记一致）。

## 关键路径与机制（出问题时看）

- **后端入口**：`server/src/index.ts`（Fastify，监听 0.0.0.0:7788；本机免 token，局域网走 `data/lan-token.txt` 门禁，见 `server/src/lan.ts` 与 `app.ts` 的 lanAuthHook）。
- **静态资源只开放 `assets/`**：不要恢复整项目根 wildcard 静态服务——那会把 `server/.env`（API key）暴露给局域网。
- **skill 加载**：后端用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，`settingSources:["project"]` + `cwd=项目根` → 自动加载 `.claude/skills/` 下的 skill。两个 skill：`baokuan-chaijie`（爆款拆解）、`xhs-title-psych`（标题）。
- **skill 里的 `analyze_image` / `parse_link` 等工具不用配**：agent 会用原生能力智能替代——图片走模型 vision（用 Read 读图）、链接解析走 Bash+curl。
- **skill 产物**：拆解结果写到临时目录的 `AI拆解/AI爆款拆解-*.md`，后端读取解析后返回前端。
- **数据**：业务数据唯一真源在服务端 `data/sync.json`（原子落盘 + `.bak`/`.bak2` 滚动备份；前端启动水合、写后防抖推送、回到页面拉取刷新）；localStorage 仅作缓存与离线兜底。改动前端任何数据写入时**必须**走 `lsS`/`lsD`/`saveAccounts` 等既有入口（已挂同步钩子），不要绕过它们直接写 localStorage。

## 故障排查

| 现象 | 处理 |
|---|---|
| 端口 7788 占用 | macOS：`PORT=7789 scripts/workbuddy-daemon.sh start`；Windows：`... workbuddy-daemon.ps1 start -Port 7789` |
| 服务一会就自动关了 | 说明不是守护方式启动。macOS 跑 `workbuddy-daemon.sh start`，Windows 跑 `workbuddy-daemon.ps1 start`；`status` 可查当前是否守护运行 |
| 守护启动 30 秒未就绪 | macOS：`tail -50 logs/launchd.log logs/server.log`，残留进程 `pkill -9 -f "server/node_modules/.bin/tsx"`；Windows：看 `logs\server.log` 和 `Get-ScheduledTaskInfo -TaskName WorkBuddyStudio` |
| Windows 任务计划注册失败 | 确认用 `powershell -NoProfile -ExecutionPolicy Bypass -File` 方式调用；公司电脑可能组策略限制，此时回退 `WorkBuddy启动.bat` 的窗口方式并告知用户关机后需重启服务 |
| skill 没被调用 | 确认 `.claude/skills/baokuan-chaijie/SKILL.md` 与 `xhs-title-psych/SKILL.md` 存在；后端 `cwd` 是项目根 |
| 图文拆解图片文字没提取 | agent 应自动用 vision；若没提取，在后端 `routes/teardown.ts` 的 prompt 里加一句"用 Read 工具读取图片" |
| 视频拆解卡住 | 确认 ffmpeg + whisper server(:2022) 已起；没装就提示用户图文拆解可用、视频需装工具 |
| API key 401 | 重新配 `server/.env`，或前端设置入口重配（注意与手机访问 401 区分：后者提示「WB_LAN_TOKEN_REQUIRED」，重新扫码即可） |
| 手机扫码打不开 | 确认手机与电脑同一 WiFi；`curl http://127.0.0.1:7788/api/lan-info` 看返回的地址；电脑防火墙放行 Node（macOS 系统设置→网络→防火墙；Windows 首启弹窗选允许）；路由器开了「AP 隔离」时同 WiFi 设备互不可见，需关闭 |
| Windows 无 curl | 用 Win10+（自带 curl.exe）或装 git bash |

## 合规

仅用于个人学习与内容研究，尊重原作者版权，不用于二次分发。

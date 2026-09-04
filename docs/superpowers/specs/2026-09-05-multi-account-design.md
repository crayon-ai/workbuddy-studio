# 多账号隔离设计（3.0）

日期：2026-09-05
状态：待确认（v2.0 基线之上，tag `v2.0` / commit `a149bf8`）
基线：2.0 交付版

## 背景与目标

工作台目前是「单博主单账号」形态：所有栏目数据（选题池、素材库、灵感、拆解记录、待办、日历、复盘、目标、人设）混存在一份 localStorage 里。多账号博主无法区分数据归属。

目标：引入**账号（creator account）维度**——

1. 所有栏目的业务数据按账号完全隔离；
2. 侧边栏可一键切换账号，切换后整站数据随之刷新；
3. 存量数据无损迁移为一个「默认账号」；
4. 备份导出/导入支持按账号。

## 现状盘点（改造涉及面）

### 前端（自媒体工作台.html，单文件原生 JS）

业务数据全在 localStorage，加载/保存均为同步调用，改动集中且机械：

| key | 内容 | 隔离归属 |
|---|---|---|
| `workbuddy_v3` | 选题池 topics + 复盘笔记 notes + 日历 calTasks + doneToday | 按账号 |
| `wb_insp` / `wb_insp_topic` | 今日灵感 / 关键词编辑 | 按账号 |
| `wb_mats` | 素材库 | 按账号 |
| `wb_hits` | 爆款拆解记录 | 按账号 |
| `wb_goals` | 运营目标 | 按账号 |
| `wb_user` / `wb_avatar` / `wb_first_use` | 昵称 / 头像 / 首用日期（人设） | 按账号 |
| `wb_profile_url` | 博主主页链接（个性化灵感用） | 按账号 |
| `wb_running_task` / `wb_running_insp_task` | 进行中任务（临时态） | 按账号 |
| `wb_theme` / `wb_topic_view` / `wb_todo_view` | 界面偏好 | 全局 |
| （新增）`wb_accounts` | 账号清单 + 当前激活账号 | 全局 |

人设类 key 按账号走是本方案的要点：多账号博主每个号有不同昵称/头像/主页链接，切换账号 = 切换整个人设与数据空间。

### 后端（server/，Fastify TS）

- 任务表：内存 Map（`task-store.ts`），taskId 全局唯一、与账号无关，**不需要改**；
- skill 产物：文件落盘 `data/<模块>/<taskId>/`，四个模块：`inspirations` / `teardowns` / `deep-reviews` / `personalized`；
- 后端目前无账号概念；taskId 是 uuid，多账号产物混存不会冲突，但无法按账号治理（导出/清理）。

## 方案总览

**两层改造：**

- **P0（核心，纯前端）**：localStorage 按账号命名空间隔离 + 侧边栏账号切换器 + 存量迁移 + 备份 v2。
- **P1（增强，后端）**：API 透传 `accountId`，skill 产物目录改为 `data/accounts/<accountId>/<模块>/<taskId>/`，旧目录惰性迁移。

选纯前端命名空间而不是「数据全部后端化」的理由：现有 load/save 全是同步 localStorage，改造成本极低；本地单机工具（127.0.0.1）没有多端同步诉求；与备份方案「纯前端 JSON」一脉相承。后端化存储留作 3.x 演进项。

## P0：前端账号体系

### 1. 数据层：账号命名空间

账号内 key 统一为 `wb:<accountId>:<suffix>`，suffix 在原 key 基础上去掉 `wb_` 前缀：

```
wb:<id>:main            ← workbuddy_v3
wb:<id>:insp            ← wb_insp
wb:<id>:insp_topic      ← wb_insp_topic
wb:<id>:mats            ← wb_mats
wb:<id>:hits            ← wb_hits
wb:<id>:goals           ← wb_goals
wb:<id>:profile_url     ← wb_profile_url
wb:<id>:avatar          ← wb_avatar
wb:<id>:user            ← wb_user
wb:<id>:first_use       ← wb_first_use
wb:<id>:running_task    ← wb_running_task
wb:<id>:running_insp_task ← wb_running_insp_task
```

新增全局 key `wb_accounts`：

```json
{
  "currentId": "a1f3c2…",
  "accounts": [
    { "id": "a1f3c2…", "name": "小红书·美食号", "platform": "xhs",
      "emoji": "🍜", "createdAt": 1757040000000 }
  ]
}
```

字段说明：`name` 必填、重名校验；`platform` 可选（xhs/douyin/bili/shipinhao/weixin/web，仅用于展示角标）；`emoji` 作为账号图标（与现有头像体系并存：账号卡片用 emoji，进入账号后的人设头像仍是 `wb:<id>:avatar`）。

代码上引入一个小命名空间层，替换现有 15 处 load/save 的裸 key：

```js
let CUR_ACC = null; // 当前账号 id，启动时由 initAccounts() 设置
const ak = k => 'wb:' + CUR_ACC + ':' + k;
// loadInsp/saveInsp/loadMats/loadHits/loadState/saveGoals/… 全部改走 ak(k)
```

`STORAGE_KEY` / `GOALS_KEY` 常量删除，改为函数调用。

### 2. 迁移（一次性，带回滚保险）

启动时 `initAccounts()`：

1. `wb_accounts` 已存在 → 正常加载，设 `CUR_ACC = currentId`（校验 id 仍存在，否则回落第一个账号）；
2. 不存在且存在旧 key（`workbuddy_v3` 等）→ 执行迁移：
   - 先把全部旧 key 原样拷入 `wb:migration_backup_v2`（一个临时快照 key，防迁移半途失败丢数据）；
   - 创建默认账号 `{ id: 'default', name: wb_user 昵称 || '默认账号' }`；
   - 逐个旧 key → `wb:default:<suffix>`；
   - 写 `wb_accounts`（currentId=default）；
   - 删除旧 key（值已拷走，避免备份重复导出）；确认各新 key 读取正常后删除快照 key；
3. 全新用户（无任何旧 key）→ 创建默认账号，直接进入。

### 3. 账号切换器（UI）

> 交互原型：`../账号切换效果demo.html`（仓库外层目录，可浏览器直接打开体验切换效果，视觉 1:1 复用正式版主题）。

改造侧边栏现有「当前创作库」卡片（`sb-lib`，现显示固定文案）为**账号切换器**：

- 常态：emoji 图标 + 账号名 + 平台角标 + 「⌄」；
- 点击弹出**账号管理弹窗**（复用现有 modal 体系）：
  - 账号卡片列表：emoji、名称、平台、各栏目数据量摘要（选题 N · 素材 N · 灵感 N · 已发布 N），当前账号高亮；
  - 「+ 新建账号」：名称必填、平台/emoji 可选；
  - 每项操作：**切换**（点卡片即切）、**编辑**（改名/平台/emoji）、**删除**（见下）；
  - 底部小字：数据仅存本机浏览器，可用「数据导出与导入」备份。

**切换流程 `switchAccount(id)`**：

1. 停掉当前账号进行中任务的轮询 `clearInterval`（任务在后端继续跑，不杀）；
2. `CUR_ACC = id`，写回 `wb_accounts.currentId`；
3. 重新执行全部内存态加载：`loadState() / loadInsp() / loadMats() / loadHits() / loadGoals() / loadProfileUrl() / loadRunningTask()…`（即现有启动序列的数据部分抽成 `reloadAll()`）；
4. 全量重渲染 + `updateStats()` 刷 badge（现有启动行 `renderInsp(); renderMat(); …` 抽成 `renderAll()` 复用）；
5. 恢复新账号的 running task 轮询（沿用现有断线恢复逻辑）；
6. 保持当前视图不动（不跳回 insp）。

**删除账号**：`confirm` 两段确认（第二段要求输入账号名，防止误删）；删除该账号全部 `wb:<id>:*` key 并从清单移除；最后一个账号不可删除（只能编辑）；删除的是当前账号时自动切到剩余第一个。

### 4. 备份导出/导入 v2

格式升版，兼容 v1：

```json
{
  "app": "workbuddy", "version": 2, "exportedAt": "…",
  "global": { "wb_theme": "…" },
  "accounts": [
    { "id": "…", "name": "…", "platform": "…", "emoji": "…", "createdAt": …,
      "data": { "insp": "<原始字符串>", "mats": "<原始字符串>", … } }
  ]
}
```

- 导出：默认导出**全部账号**（文件名 `workbuddy-backup-YYYYMMDD.json` 不变；多账号时加账号数后缀可选）；
- 导入 v2：覆盖式恢复账号清单 + 各账号数据（沿用现有「整体覆盖」策略，confirm 文案注明含 N 个账号）；
- 导入 v1（旧备份）：提示「检测到 2.0 单账号备份，将导入为当前账号的数据」→ 写入当前 `CUR_ACC` 命名空间；
- `version > 2` 拒绝（沿用现有逻辑）。

### 5. 边界与细节

- **进行中任务**：`running_task` 按账号隔离，切走再切回能看到各自任务的进度恢复；
- **创作天数**（`first_use` 按账号）：新账号从 0 天起算，符合「新号新运营」语义；
- **URL 参数**（`?view=table`）与 hash 路由不受影响；
- **localStorage 容量**（约 5MB，多账号共享）：账号管理弹窗底部展示估算用量（`JSON.stringify` 长度求和），超 80% 提示导出清理；save 的静默 try-catch 保留；
- **AI 配置**（服务端 .env）与外观主题保持全局，不属于账号数据。

## P1：后端产物按账号隔离

功能上 P0 已完整（taskId 是 uuid，不冲突）；P1 解决的是文件治理——产物目录与账号对齐，将来可按账号导出/清理产物。

1. **API 透传**：`POST /api/teardown`、`/api/inspiration/refresh`、`/api/inspiration/personalized`、`/api/deep-review` 的 body 增加可选 `accountId`（缺省 `"default"`，向后兼容）；前端调用处带上 `CUR_ACC`；
2. **目录调整**：`data/accounts/<accountId>/<模块>/<taskId>/`（`teardown.ts` / `inspiration.ts` / `personalized.ts` / `deep-review.ts` 各自的 dir 函数一处改动）；
3. **folder / reparse 接口**（`/api/teardown/:id/folder` 等）：加 `?account=` query；未带时先查旧路径 `data/<模块>/<id>/` 再查新路径——旧记录（2.0 时代 HITS）继续可打开；
4. **惰性迁移**：服务启动时若存在旧的 `data/<模块>/` 且 `data/accounts/` 不存在，则 move 到 `data/accounts/default/`（一次性，写日志）；
5. **任务表**：`Task` 增加 `accountId` 字段（仅记录，轮询接口不变）；
6. **测试**：四个路由的单测补 `accountId` 用例（目录断言 + 缺省回退）。

## 实施拆分与工作量

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0-1 | 数据层命名空间 + 迁移 + `reloadAll/renderAll` 重构 | 0.5 天 |
| P0-2 | 账号切换器 + 管理弹窗（增删改查切换） | 0.5 天 |
| P0-3 | 备份 v2（导出全账号 / 导入 v1+v2） | 0.5 天 |
| P1 | 后端 accountId 透传 + 目录隔离 + 惰性迁移 + 单测 | 0.5 天 |
| 验收 | 手测清单（见下）+ 单测全绿 | 0.5 天 |

**验收清单（手测）**：

- [ ] 2.0 数据升级后自动出现在「默认账号」，各栏目数量不变；
- [ ] 新建账号 B：各栏目为空，新建选题/素材/灵感后切回 A 不受影响；
- [ ] 账号 A 发起拆解 → 切到 B → 切回 A，进度与结果恢复且归属 A（HITS 不串号）；
- [ ] A/B 各自的昵称、头像、主页链接、创作天数独立；
- [ ] 导出含全部账号；导入 v1 旧备份落到当前账号；导入 v2 完整还原；
- [ ] 删除账号需两段确认，最后一个账号不可删；
- [ ] P1 后：`data/accounts/<id>/teardowns/…` 目录正确；旧 2.0 拆解记录仍能「打开文件夹」。

## 风险与演进

- **单文件体积**：账号管理为独立模块（约 +300 行），暂不拆分文件（保持单文件交付形态）；
- **容量天花板**：多重度使用可能触顶 localStorage，弹窗已做用量提示；彻底解法是 3.x 的「数据后端化」（`data/accounts/<id>/store.json` + REST CRUD），本方案的命名空间与账号模型可直接平移；
- **并发**：同一浏览器多标签页同时开工作台，切账号互不通知（现有单账号版本同样存在），不在本期处理。

# 深度复盘（对标笔记对比分析）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 复盘弹窗内可粘贴 1-5 条同赛道对标笔记链接，后端双阶段编排（秒抓元数据 → 逐篇下载正文封面 → 纯分析 skill）产出对比分析报告。

**Architecture:** 新增 `deep-review.ts` 路由（对照 `personalized.ts` 编排模式）：① `fetchNoteMeta` 并行抓全部笔记元数据 + 确定性数据信号落 `meta.json` → ② 每篇独立调 `baokuan-chaijie` 能力一（只下载、跳过评论）→ ③ 新 `deep-review` skill 读磁盘产物出报告。前端复盘弹窗加深度复盘区域，走 task 轮询。

**Tech Stack:** Fastify + vitest（后端已有）；Agent SDK skill-runner（已有）；前端单文件 HTML 无构建。

**Spec:** `docs/superpowers/specs/2026-08-24-deep-review-design.md`

**工作目录约定：** 所有相对路径以 `release/WorkBuddy/` 为根（后端测试在 `release/WorkBuddy/server/` 下跑）。git 仓库根在 `release/WorkBuddy/` 的上一级（`WorkBuddy工作台V3/`），提交时 `cd` 到仓库根。

---

### Task 1: `parseDeepReview` 报告解析（TDD）

**Files:**
- Modify: `release/WorkBuddy/server/src/parse.ts`（文件末尾追加）
- Test: `release/WorkBuddy/server/src/parse.test.ts`（追加 describe 块）

- [ ] **Step 1: 写失败测试**

在 `parse.test.ts` 末尾追加：

```typescript
import { parseDeepReview } from "./parse.js";

describe("parseDeepReview（深度复盘报告解析）", () => {
  const REPORT = [
    "# AI深度复盘-我的笔记",
    "",
    "## 数据对比总览",
    "| 笔记 | 赞 | 藏 | 评 | 发布 |",
    "| --- | --- | --- | --- | --- |",
    "| 我的 | 200 | 800 | 30 | 08-20 |",
    "| 对标A | 20000 | 15000 | 800 | 08-18 |",
    "",
    "## 差距归因",
    "标题钩子差距……",
    "",
    "## 可执行建议",
    "1. 建议一",
    "2. 建议二",
    "",
    "## 可复用经验候选",
    "- 数字+场景标题最有效",
    "- 正文前 3 行给结论",
  ].join("\n");

  it("识别 AI深度复盘 报告并提取五部分 section", () => {
    const r = parseDeepReview({ "AI深度复盘-我的笔记.md": REPORT });
    expect(r).not.toBeNull();
    expect(r!.reportFile).toBe("AI深度复盘-我的笔记.md");
    expect(Object.keys(r!.sections).length).toBe(4);
    expect(r!.sections["差距归因"]).toContain("标题钩子");
  });

  it("无报告文件返回 null", () => {
    expect(parseDeepReview({ "meta.json相关说明.md": "x" })).toBeNull();
  });

  it("sections 按行首 ## 切分，行内容进对应 section", () => {
    const r = parseDeepReview({ "AI深度复盘-x.md": REPORT })!;
    expect(r!.sections["可复用经验候选"]).toContain("- 数字+场景标题最有效");
  });
});
```

注意：现有 `parse.test.ts` 若已 import parse.ts 的具名函数，把 `parseDeepReview` 并进顶部既有 import，别重复 import 语句。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd release/WorkBuddy/server && npx vitest run src/parse.test.ts
```
预期：FAIL，`parseDeepReview` 不存在。

- [ ] **Step 3: 最小实现**

`parse.ts` 末尾追加：

```typescript
export interface DeepReview {
  sections: Record<string, string>;
  raw: string;
  reportFile?: string;
}

/**
 * 从 skill 产物识别深度复盘报告（文件名以 AI深度复盘 开头）。
 * 无报告返回 null；有报告则按 ## 二级标题切 sections。
 */
export function parseDeepReview(artifacts: Record<string, string>): DeepReview | null {
  const entry = Object.entries(artifacts).find(([k]) => k.startsWith("AI深度复盘"));
  if (!entry) return null;
  const [filename, md] = entry;
  const sections: Record<string, string> = {};
  for (const sec of md.split(/^##\s+/m).slice(1)) {
    const line = sec.split("\n")[0].trim();
    if (line) sections[line] = sec.slice(sec.indexOf("\n")).trim();
  }
  return { sections, raw: md, reportFile: filename };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd release/WorkBuddy/server && npx vitest run src/parse.test.ts
```
预期：PASS（新 3 例 + 原有全过）。

- [ ] **Step 5: 提交**

```bash
cd /Users/suntao/work/小工具/WorkBuddy工作台V3
git add release/WorkBuddy/server/src/parse.ts release/WorkBuddy/server/src/parse.test.ts
git commit -m "feat: parseDeepReview 解析深度复盘报告（按 ## 切 sections，无报告判 null）"
```

---

### Task 2: deep-review skill（纯分析）

**Files:**
- Create: `release/WorkBuddy/.claude/skills/deep-review/SKILL.md`

skill 是 prompt 资产（无单测），验收 = 内容完整 + 结构契约清晰。产物解析已被 Task 1 覆盖。

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: deep-review
description: 深度复盘（对标对比分析）。输入：自己的笔记 + 若干同赛道对标笔记的元数据（meta.json）与已下载的原文素材（notes/ 目录）。输出：AI深度复盘-<自己笔记标题>.md，含数据对比总览、对标逐篇诊断、差距归因、可执行建议、可复用经验候选五部分。纯分析 skill：素材由调用方备好，本 skill 只读盘分析，不联网抓取。当调用方在 prompt 里给出 workDir 与素材位置时使用。
---

# 深度复盘 Skill（对标对比分析）

你是内容策略分析师。**素材已由调用方备好**（meta.json + notes/ 目录），你只做一件事：
对比分析「我的笔记」与「对标笔记」的内容差异，对数据差距做归因，产出可执行建议。

## 输入（调用方提供）

1. `workDir/meta.json` —— 全部笔记的元数据与确定性数据信号（赞藏评、发布时间差、
   标签重合度、粉丝数、收藏/点赞比等）
2. `workDir/notes/<角色>-<标题>/` —— 每篇的下载素材（正文.md、图片等）；
   `downloaded: false` 的篇目没有目录，只参与元数据对比
3. prompt 里会给出 workDir 绝对路径

## 执行步骤（固定，不得跳步）

1. Read `workDir/meta.json`，理解每篇的角色（mine=自己 / benchmark=对标）、数据信号
2. 对每个 `notes/` 子目录：Read 正文.md；对图片文件用 Read 工具逐张读取（vision 提取图内文字）
3. 按下方模板写报告，Write 落盘 `workDir/AI深度复盘-<自己笔记标题>.md`（标题取 meta.json 里 mine 的 title）

## 分析方法论

**单篇内容诊断四维**（mine 和每篇 benchmark 都过同一套，对称分析）：
1. **标题钩子**：类型（数字清单/反常识/身份代入/损失规避/利益承诺）+ 强度评估
2. **封面**：文字密度、视觉冲突、信息传达效率（无图笔记注明「无封面」）
3. **正文结构**：开头 3 行是否抓人、信息密度、可操作性、排版节奏
4. **内容完整度**：信息缺口、读者能「带走什么资产」

**归因核心**：数据差距 → 内容归因。找出表现最好与最差的对标，逐维度对比我的笔记，
按影响度排序（标题钩子 > 封面 > 正文结构）。每条归因必须同时指出：
「对标哪篇的什么具体内容做法」vs「我这篇对应位置的差距」。
禁止「内容质量有待提升」这类无证据空话。

**公平性**：对标若粉丝体量远大于自己（meta.json 有 fans 字段时），归因时说明
绝对数据不可直接比，侧重相对比率（收藏/点赞比）与内容本身。

## 报告模板（必须严格遵循，五部分顺序不得变）

# AI深度复盘-<自己笔记标题>

## 数据对比总览

（markdown 表格：笔记 | 角色 | 赞 | 藏 | 评 | 发布日期 | 与我发布时间差 | 标签重合度 | 粉丝数。
 数据全部来自 meta.json，禁止改动或估算。表格后 1-2 句解读最关键的数据信号。）

## 对标逐篇诊断

（每篇对标一小节 ### 对标N：<标题>，按四维逐项诊断。
 数据好的篇要指出内容上的具体功臣；数据差的篇要指出具体短板。）

## 差距归因

（按影响度排序的归因链，每条绑定双方具体内容证据。）

## 可执行建议

（3-5 条，编号列表，每条注明依据：来自哪篇对标的什么证据。可直接照做。）

## 可复用经验候选

（1-3 条 `- ` 列表短句，每条一句可直接复用的经验。）

## 硬约束

- 只分析下载到的真实素材；`downloaded: false` 的篇目只基于 meta.json 数据参与对比，
  并在该篇诊断处注明「（正文未获取，仅基于数据）」
- 绝不编造：不虚构未下载的正文内容、不模拟数据、不用占位示例
- 完成的唯一标准：`workDir/AI深度复盘-<自己笔记标题>.md` 文件真实存在。
  在回复里输出分析不算完成
```

- [ ] **Step 2: 验证 frontmatter 合法**

```bash
cd release/WorkBuddy && head -4 .claude/skills/deep-review/SKILL.md
```
预期：`---` / `name: deep-review` / `description: ...` / `---`。

- [ ] **Step 3: 提交**

```bash
cd /Users/suntao/work/小工具/WorkBuddy工作台V3
git add "release/WorkBuddy/.claude/skills/deep-review/SKILL.md"
git commit -m "feat: deep-review skill（对标对比分析，四维诊断+归因模板钉死五部分结构）"
```

---

### Task 3: deep-review 路由（TDD，核心编排）

**Files:**
- Create: `release/WorkBuddy/server/src/routes/deep-review.ts`
- Create: `release/WorkBuddy/server/src/routes/deep-review.test.ts`
- Modify: `release/WorkBuddy/server/src/routes/note.ts`（导出 `fetchNoteMeta`，加粉丝数提取）
- Modify: `release/WorkBuddy/server/src/app.ts`（注册路由）

依赖说明：
- `fetchNoteMeta(url)` 在 Task 3 从 note.ts 导出（现为模块私有）。顺带增强：
  笔记页 SSR 的 `note.user` 里有 `fans` 字段时提取（无则 undefined，测试的 FAKE_STATE 已含）。
- `runSkill` / `collectMarkdown` / `createTask` / `updateTask` / `getApiKey` / `parseDeepReview`
  均为已有（Task 1 产出 parseDeepReview）。

- [ ] **Step 1: 先导出 fetchNoteMeta 并提取粉丝数**

`note.ts` 改两处：

```typescript
// NoteMeta 接口加一个字段（放在 tags 前后均可）：
  /** 作者粉丝数（SSR user.fans，可能没有） */
  fans?: string;
```

```typescript
// fetchNoteMeta 的返回对象里加（noteId: n.noteId, 一行前后）：
    fans: n.user?.fans != null ? String(n.user.fans) : undefined,
```

并在 `fetchNoteMeta` 函数上方加注释改为导出（函数签名从
`async function fetchNoteMeta` 改为 `export async function fetchNoteMeta`）。

同步给 `note.test.ts` 的 FAKE_STATE 的 user 加 `"fans": "1200"`，追加断言
`expect(body.data.meta.fans).toBe("1200");` 到第一个测试里（顺手验证）。

跑：`cd release/WorkBuddy/server && npx vitest run src/routes/note.test.ts`
预期：PASS。

- [ ] **Step 2: 写失败的路由测试**

`deep-review.test.ts` 全文：

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

// mock runSkill：按 prompt 内容分流（下载 prompt / 分析 prompt），collectMarkdown 用真实实现
vi.mock("../skill-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skill-runner.js")>();
  return {
    collectMarkdown: actual.collectMarkdown,
    runSkill: vi.fn(async (_skill: string, prompt: string, workDir: string) => {
      if (prompt.includes("下载原文")) {
        // 下载阶段：模拟落盘一篇正文（mine 那篇）
        const { mkdirSync, writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const dir = join(workDir, "notes", "mine-我的笔记");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "正文.md"), "# 我的笔记\n\n正文内容");
        return { ok: true, text: "downloaded", artifacts: {} };
      }
      // 分析阶段：落盘报告
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const md = [
        "# AI深度复盘-我的笔记",
        "",
        "## 数据对比总览",
        "| 笔记 | 赞 |",
        "| --- | --- |",
        "| 我的 | 200 |",
        "| 对标A | 20000 |",
        "",
        "## 差距归因",
        "标题钩子差距",
        "",
        "## 可执行建议",
        "1. 建议",
        "",
        "## 可复用经验候选",
        "- 经验",
      ].join("\n");
      writeFileSync(join(workDir, "AI深度复盘-我的笔记.md"), md);
      return { ok: true, text: "done", artifacts: { "AI深度复盘-我的笔记.md": md } };
    }),
  };
});

// mock global.fetch：元数据阶段返回 SSR HTML
const mkState = (title: string, likes: string) => ({
  note: {
    noteDetailMap: {
      x: {
        note: {
          title,
          noteId: "x",
          user: { nickname: "作者", fans: "1000" },
          interactInfo: { likedCount: likes, collectedCount: "50", commentCount: "10" },
          time: 1784876760000,
          tagList: [{ name: "收纳" }],
        },
      },
    },
  },
});
vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({
    text: async () =>
      `<html><script>window.__INITIAL_STATE__=${JSON.stringify(mkState("t", "1"))}</script></html>`,
  } as any))
);

const { buildApp } = await import("../app.js");
const { rmSync, readFileSync, existsSync } = await import("node:fs");
const envPath = "./.env.deepreview.test";

async function waitDone(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: "GET", url: `/api/task/${taskId}` });
    const body = JSON.parse(r.body);
    if (body.data?.status === "done" || body.data?.status === "failed") return body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("任务未在超时内完成");
}

describe("POST /api/deep-review", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    rmSync(envPath, { force: true });
    process.env.ANTHROPIC_API_KEY = "sk-test";
    vi.mocked((await import("../skill-runner.js")).runSkill).mockClear();
  });

  it("无效参数：noteUrl 空 / benchmarkUrls 空 / 超 5 条 / 非 http 链接均拒绝", async () => {
    const app = await buildApp({ envPath });
    const cases = [
      { payload: { benchmarkUrls: ["https://a.com/1"] } },                       // 缺 noteUrl
      { payload: { noteUrl: "https://a.com/1", benchmarkUrls: [] } },            // 空对标
      {
        payload: { noteUrl: "https://a.com/1", benchmarkUrls: ["bad"] },         // 非法 URL
      },
      {
        payload: {                                                            // 超 5 条
          noteUrl: "https://a.com/1",
          benchmarkUrls: Array.from({ length: 6 }, (_, i) => `https://a.com/${i}`),
        },
      },
    ];
    for (const c of cases) {
      const r = await app.inject({ method: "POST", url: "/api/deep-review", payload: c.payload });
      expect(JSON.parse(r.body).success).toBe(false);
    }
    await app.close();
  });

  it("未配置 API key 拒绝", async () => {
    const app = await buildApp({ envPath });
    delete process.env.ANTHROPIC_API_KEY;
    const r = await app.inject({
      method: "POST",
      url: "/api/deep-review",
      payload: { noteUrl: "https://a.com/1", benchmarkUrls: ["https://a.com/2"] },
    });
    expect(JSON.parse(r.body).success).toBe(false);
    expect(JSON.parse(r.body).error).toContain("API key");
    await app.close();
  });

  it("全链路：done + meta.json 落盘 + 报告解析", async () => {
    const app = await buildApp({ envPath, projectRoot: "./tmp-deepreview-root" });
    const r = await app.inject({
      method: "POST",
      url: "/api/deep-review",
      payload: {
        noteUrl: "https://www.xiaohongshu.com/explore/mine",
        benchmarkUrls: ["https://www.xiaohongshu.com/explore/bench1"],
      },
    });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(true);
    const done = await waitDone(app, body.data.taskId);
    expect(done.data.status).toBe("done");
    expect(done.data.result.reportFile).toContain("AI深度复盘");
    // meta.json 已落盘且含两篇 + 数据信号
    const meta = JSON.parse(readFileSync(`tmp-deepreview-root/data/deep-reviews/${body.data.taskId}/meta.json`, "utf8"));
    expect(meta.notes.length).toBe(2);
    expect(meta.notes.find((n: any) => n.role === "mine").title).toBe("t");
    expect(meta.signal).toBeDefined();
    rmSync("tmp-deepreview-root", { recursive: true, force: true });
    await app.close();
  });

  it("元数据全失败 → task failed", async () => {
    const app = await buildApp({ envPath, projectRoot: "./tmp-deepreview-root2" });
    (global.fetch as any).mockImplementation(async () => ({
      text: async () => "<html>no state</html>",
    }));
    const r = await app.inject({
      method: "POST",
      url: "/api/deep-review",
      payload: {
        noteUrl: "https://www.xiaohongshu.com/explore/m1",
        benchmarkUrls: ["https://www.xiaohongshu.com/explore/b1"],
      },
    });
    const body = JSON.parse(r.body);
    const done = await waitDone(app, body.data.taskId);
    expect(done.data.status).toBe("failed");
    rmSync("tmp-deepreview-root2", { recursive: true, force: true });
    await app.close();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd release/WorkBuddy/server && npx vitest run src/routes/deep-review.test.ts
```
预期：FAIL（404，路由不存在）。

- [ ] **Step 4: 实现路由**

`deep-review.ts` 全文：

```typescript
import type { FastifyPluginCallback } from "fastify";
import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill, collectMarkdown } from "../skill-runner.js";
import { parseDeepReview } from "../parse.js";
import { fetchNoteMeta, type NoteMeta } from "./note.js";
import { getApiKey } from "../config.js";

export interface DeepReviewRoutesOpts {
  envPath: string;
  projectRoot: string;
}

/** 深度复盘产物目录：项目内 data/deep-reviews/<taskId>/ */
function deepReviewDir(projectRoot: string, taskId: string): string {
  return path.join(projectRoot, "data", "deep-reviews", taskId);
}

/** 数字字符串（"1.2万"）→ number；解析失败返回 0。 */
function toNum(v: string | undefined): number {
  if (!v) return 0;
  const m = v.match(/^([\d.]+)(万)?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] ? n * 10000 : n;
}

/** 任务级日志（随启动脚本进 logs/server.log）。 */
function log(taskId: string, msg: string, t0?: number): void {
  const hhmmss = new Date().toTimeString().slice(0, 8);
  const rel = t0 ? `+${((Date.now() - t0) / 1000).toFixed(1)}s` : "";
  console.log(`[${hhmmss}]${rel ? ` (${rel})` : ""} [deep-review:${taskId}] ${msg}`);
}

interface NoteEntry {
  role: "mine" | "benchmark";
  url: string;
  meta: NoteMeta;
  /** 相对自己笔记的发布时间差（天，正=晚于我） */
  daysDelta?: number;
  /** 与自己笔记的共同标签数 */
  tagOverlap?: number;
  /** 下载阶段是否成功（决定分析阶段能否读正文） */
  downloaded: boolean;
  /** 下载失败原因（报告数据说明用） */
  downloadError?: string;
}

/** 跨平台打开文件夹（同 teardown.ts）。 */
function openFolder(dir: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${dir}"`
      : process.platform === "win32"
        ? `explorer "${dir}"`
        : `xdg-open "${dir}"`;
  exec(cmd, (err) => {
    if (err) console.error("open folder failed:", err);
  });
}

export const deepReviewRoutes: FastifyPluginCallback<DeepReviewRoutesOpts> = (
  app,
  opts,
  done
) => {
  app.post("/api/deep-review", async (req) => {
    const { noteUrl, benchmarkUrls } = (req.body ?? {}) as {
      noteUrl?: string;
      benchmarkUrls?: string[];
    };
    const isUrl = (u: unknown): u is string =>
      typeof u === "string" && /^https?:\/\//.test(u.trim());
    if (!isUrl(noteUrl)) {
      return { success: false, data: null, error: "noteUrl 无效" };
    }
    const benches = (benchmarkUrls ?? []).map((u) => String(u).trim()).filter(Boolean);
    if (!benches.length) {
      return { success: false, data: null, error: "至少提供 1 条对标链接" };
    }
    if (benches.length > 5) {
      return { success: false, data: null, error: "对标笔记最多 5 条" };
    }
    if (!benches.every(isUrl)) {
      return { success: false, data: null, error: "对标链接含非法 URL" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }
    const taskId = createTask();
    log(taskId, `提交：mine=${noteUrl} benchmarks=${benches.length}`);
    runDeepReview(taskId, noteUrl.trim(), benches, apiKey, opts.projectRoot).catch(
      (e) => {
        log(taskId, `编排异常：${String(e?.message ?? e)}`);
        updateTask(taskId, {
          status: "failed",
          error: String(e?.message ?? e),
          updatedAt: Date.now(),
        });
      }
    );
    return { success: true, data: { taskId } };
  });

  app.get("/api/deep-review/:id/folder", async (req) => {
    const id = (req.params as { id: string }).id;
    const dir = deepReviewDir(opts.projectRoot, id);
    if (!existsSync(dir)) {
      return { success: false, data: null, error: "目录不存在（任务可能未完成）" };
    }
    try {
      openFolder(dir);
      return { success: true, data: { ok: true } };
    } catch (e: any) {
      return { success: false, data: null, error: e?.message ?? String(e) };
    }
  });

  app.post("/api/deep-review/:id/reparse", async (req) => {
    const id = (req.params as { id: string }).id;
    const dir = deepReviewDir(opts.projectRoot, id);
    if (!existsSync(dir)) {
      return { success: false, data: null, error: "目录不存在" };
    }
    const artifacts = collectMarkdown(dir);
    return { success: true, data: { result: parseDeepReview(artifacts) } };
  });

  done();
};

/**
 * 三段编排：① fetchNoteMeta 并行抓元数据 + 数据信号落 meta.json
 * → ② 逐篇下载正文封面（baokuan-chaijie 能力一，跳过评论，失败隔离）
 * → ③ deep-review skill 读盘分析出报告。
 */
async function runDeepReview(
  taskId: string,
  noteUrl: string,
  benchmarkUrls: string[],
  apiKey: string,
  projectRoot: string
): Promise<void> {
  const t0 = Date.now();
  const workDir = deepReviewDir(projectRoot, taskId);
  mkdirSync(workDir, { recursive: true });
  const onProgress = makeProgress(taskId);
  updateTask(taskId, {
    status: "running",
    step: "正在抓取笔记元数据…",
    logs: [],
    updatedAt: t0,
  });

  // ① 元数据：mine + benchmarks 并行，任一失败剔除（mine 失败则整体失败）
  const targets: { role: "mine" | "benchmark"; url: string }[] = [
    { role: "mine", url: noteUrl },
    ...benchmarkUrls.map((url) => ({ role: "benchmark" as const, url })),
  ];
  const metas = await Promise.allSettled(
    targets.map((t) => fetchNoteMeta(t.url))
  );
  const entries: NoteEntry[] = [];
  const dropped: { role: string; url: string; reason: string }[] = [];
  metas.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.title) {
      entries.push({ role: targets[i].role, url: targets[i].url, meta: r.value, downloaded: false });
    } else {
      dropped.push({
        role: targets[i].role,
        url: targets[i].url,
        reason: r.status === "rejected" ? String(r.reason?.message ?? r.reason) : "未提取到标题",
      });
    }
  });
  const mine = entries.find((e) => e.role === "mine");
  if (!mine) {
    log(taskId, `自己笔记元数据失败：${dropped.find((d) => d.role === "mine")?.reason}`, t0);
    updateTask(taskId, {
      status: "failed",
      error: "自己笔记元数据抓取失败（链接失效？），请检查后重试",
      updatedAt: Date.now(),
    });
    return;
  }
  if (!entries.some((e) => e.role === "benchmark")) {
    log(taskId, `全部对标元数据失败（${dropped.length} 条）`, t0);
    updateTask(taskId, {
      status: "failed",
      error: "全部对标链接元数据抓取失败，请检查后重试",
      updatedAt: Date.now(),
    });
    return;
  }
  log(taskId, `元数据完成：mine ✓ + benchmark ${entries.length - 1}/${benchmarkUrls.length}`, t0);

  // 确定性数据信号：时间差、标签重合、比值
  for (const e of entries) {
    if (e.meta.date && mine.meta.date) {
      e.daysDelta =
        (Date.parse(e.meta.date) - Date.parse(mine.meta.date)) / 86400000;
    }
    const mineTags = new Set(mine.meta.tags ?? []);
    e.tagOverlap = (e.meta.tags ?? []).filter((t) => mineTags.has(t)).length;
  }
  const signal = entries.map((e) => {
    const likes = toNum(e.meta.likes);
    const favs = toNum(e.meta.favs);
    const comments = toNum(e.meta.comments);
    return {
      role: e.role,
      title: e.meta.title,
      favLikeRatio: likes > 0 ? Math.round((favs / likes) * 100) : undefined,
      commentLikeRatio: likes > 0 ? Math.round((comments / likes) * 100) : undefined,
    };
  });
  const metaDoc = {
    taskId,
    createdAt: new Date().toISOString(),
    mine: { title: mine.meta.title, url: noteUrl },
    notes: entries,
    signal,
    dropped,
  };
  writeFileSync(path.join(workDir, "meta.json"), JSON.stringify(metaDoc, null, 2));

  // ② 逐篇下载（失败隔离，进度逐篇上报）
  let done = 0;
  updateTask(taskId, {
    step: `开始下载正文（0/${entries.length}）…`,
    updatedAt: Date.now(),
  });
  for (const e of entries) {
    const slug = sanitize(e.meta.title ?? "untitled");
    const noteDir = path.join(workDir, "notes", `${e.role === "mine" ? "mine" : "benchmark"}-${slug}`);
    const prompt = [
      "请使用 baokuan-chaijie skill 的「能力一（下载原文）」下载以下笔记，只下载不拆解：",
      "",
      "重要（执行方式，先读）：",
      "- 不要调用 Skill 工具来加载本 skill——你没有该工具权限。",
      "- 只执行能力一：把原文（正文 + 图片）下载到指定目录。",
      "- 明确跳过评论区：不要抓取评论（分析不需要，且无登录态常抓不到）。",
      "- 不需要执行能力二（拆解）。",
      `- 完成的唯一标准：目标目录下出现 正文.md（或等价的正文文件）。`,
      "",
      `笔记链接：${e.url}`,
      `下载目录：${noteDir}`,
      `目录主题名可省略，直接把「爆款原文」内容放进上述目录（或其下一级）。`,
    ].join("\n");
    const r = await runSkill("baokuan-chaijie", prompt, workDir, { apiKey, projectRoot }, onProgress);
    // 判定该篇是否落盘（agent 可能写到 notes/<role>-<slug>/爆款原文/<标题>/）
    e.downloaded = collectMarkdown(noteDir) !== undefined && Object.keys(collectNoteFiles(noteDir)).length > 0;
    if (!e.downloaded) {
      e.downloadError = r.ok ? "下载未产出文件" : (r.error ?? "下载失败");
      log(taskId, `下载失败（${e.role} ${slug}）：${e.downloadError}`, t0);
    }
    done++;
    updateTask(taskId, {
      step: `下载正文（${done}/${entries.length}）…`,
      updatedAt: Date.now(),
    });
  }

  // ③ 分析（一次 agent 调用）
  updateTask(taskId, { step: "对比分析中…", updatedAt: Date.now() });
  const analysisPrompt = buildAnalysisPrompt(workDir, metaDoc);
  const ar = await runSkill("deep-review", analysisPrompt, workDir, { apiKey, projectRoot }, onProgress);
  log(taskId, `分析 skill 结束，ok=${ar.ok}`, t0);

  const finish = (result: ReturnType<typeof parseDeepReview>, recovered: boolean) => {
    updateTask(taskId, {
      status: "done",
      result,
      step: recovered ? "完成（从磁盘恢复）" : "完成",
      updatedAt: Date.now(),
    });
  };

  if (!ar.ok || !parseDeepReview(ar.artifacts)) {
    // CLI 崩溃 / 零产物 → 磁盘恢复兜底（同现有模式）
    const fromDisk = parseDeepReview(collectMarkdown(workDir));
    if (fromDisk) {
      log(taskId, `磁盘恢复成功`, t0);
      finish(fromDisk, true);
      return;
    }
    if (fabricated(ar.artifacts)) {
      updateTask(taskId, {
        status: "failed",
        error: "分析产物为编造示例，请重试",
        updatedAt: Date.now(),
      });
      return;
    }
    updateTask(taskId, {
      status: "failed",
      error: ar.ok ? "分析未产出报告，请重试" : (ar.error ?? "分析失败"),
      updatedAt: Date.now(),
    });
    return;
  }
  finish(parseDeepReview(ar.artifacts)!, false);
}

/** 目录下存在任一文件（不限 .md）即视为下载成功。 */
function collectNoteFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isFile()) out[name] = "";
      else if (statSync(p).isDirectory()) {
        // 爆款原文/<标题>/ 层级：检查叶子目录
        for (const n2 of readdirSync(p)) {
          const p2 = path.join(p, n2);
          if (statSync(p2).isFile()) out[`${name}/${n2}`] = "";
        }
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return out;
}

/** 文件名安全化（标题常含 / ：等非法字符）。 */
function sanitize(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 50).trim() || "untitled";
}

/** 同 teardown.ts 的防编造检测。 */
function fabricated(artifacts: Record<string, string>): boolean {
  const flags = [
    /数据来源\*{0,2}\s*[：:]\s*\*{0,2}模拟数据/,
    /无法直接抓取原内容/,
    /这是一个示例内容/,
  ];
  return Object.values(artifacts).some((text) => flags.some((re) => re.test(text)));
}

/** 同 personalized.ts 的进度回调。 */
function makeProgress(taskId: string) {
  return (p: { step?: string; detail?: string }) => {
    const cur = getTask(taskId);
    const logs = cur?.logs ? [...cur.logs] : [];
    const patch: { updatedAt: number; logs: string[]; step?: string; detail?: string } = {
      updatedAt: Date.now(),
      logs,
    };
    if (p.step) {
      patch.step = p.step;
      patch.logs = [...logs, p.step].slice(-30);
    }
    if (p.detail) patch.detail = p.detail;
    updateTask(taskId, patch);
  };
}

/** 分析 prompt：素材位置 + meta.json 摘要 + 钉死执行路径。 */
function buildAnalysisPrompt(
  workDir: string,
  metaDoc: { notes: NoteEntry[] }
): string {
  const lines = metaDoc.notes.map((e) =>
    `- ${e.role === "mine" ? "我的笔记" : "对标笔记"}《${e.meta.title}》`
    + ` · 赞${e.meta.likes ?? "?"}/藏${e.meta.favs ?? "?"}/评${e.meta.comments ?? "?"}`
    + ` · 发布${e.meta.date ?? "未知"}${e.daysDelta != null ? `（与我差 ${e.daysDelta.toFixed(0)} 天）` : ""}`
    + ` · 标签重合 ${e.tagOverlap ?? 0} 个`
    + ` · 正文${e.downloaded ? "已下载" : "未获取（仅基于数据分析）"}`
  );
  return [
    "请使用 deep-review skill 完成以下任务。",
    "",
    "重要（执行方式，先读）：",
    "- 第一步必须先用 Read 工具读取 .claude/skills/deep-review/SKILL.md 全文，严格按其模板执行，不得自创结构。",
    "- 不要调用 Skill 工具来加载本 skill——你没有该工具权限。",
    "- 素材已在磁盘：meta.json 与 notes/ 目录都在 workDir 下，先读 meta.json。",
    `- 完成的唯一标准：${workDir}/AI深度复盘-<我的笔记标题>.md 文件真实存在。`,
    "",
    `workDir：${workDir}`,
    "",
    "笔记清单（详见 meta.json）：",
    ...lines,
    "",
    "硬约束：",
    "- 绝不编造/模拟/示例数据；正文未获取的篇目只基于数据分析并注明。",
    `- 最终必须产出 ${workDir}/AI深度复盘-<我的笔记标题>.md（标题用 meta.json 里 mine 的 title）。`,
  ].join("\n");
}
```

需要的 `readdirSync` / `statSync` import 在顶部 `node:fs` 一并引入：

```typescript
import { exec } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
```

**实现注意：**
- `collectNoteFiles` 里那行 `e.downloaded = collectMarkdown(noteDir) !== undefined && ...` 写错了——`collectMarkdown` 永远返回对象。直接用：
  ```typescript
  e.downloaded = Object.keys(collectNoteFiles(noteDir)).length > 0;
  ```
  （上面 Step 4 代码块里按此修正后再写入文件。）
- `runSkill` 的 workDir 参数传 `workDir`（分析阶段）与 `workDir`（下载阶段同目录）——
  下载的 Bash 由 agent 在 projectRoot 下执行，prompt 里已给绝对 `noteDir`。

- [ ] **Step 5: 注册路由**

`app.ts` 加两行（对照 personalized）：

```typescript
import { deepReviewRoutes } from "./routes/deep-review.js";
// register 块里 taskRoutes 之前：
  await app.register(deepReviewRoutes, routeOpts);
```

- [ ] **Step 6: 跑全部测试**

```bash
cd release/WorkBuddy/server && npm test
```
预期：全 PASS（含新增 deep-review 4 例）。

- [ ] **Step 7: 提交**

```bash
cd /Users/suntao/work/小工具/WorkBuddy工作台V3
git add release/WorkBuddy/server/src/routes/deep-review.ts release/WorkBuddy/server/src/routes/deep-review.test.ts release/WorkBuddy/server/src/routes/note.ts release/WorkBuddy/server/src/routes/note.test.ts release/WorkBuddy/server/src/app.ts
git commit -m "feat: /api/deep-review 三段编排（元数据+数据信号→逐篇下载→skill 分析出报告）"
```

---

### Task 4: gitignore 产物目录

**Files:**
- Modify: `release/WorkBuddy/.gitignore`

- [ ] **Step 1: 追加一行**

在 `data/personalized/` 条目后加：

```
# 深度复盘产物（用户数据）
data/deep-reviews/
```

- [ ] **Step 2: 提交**

```bash
cd /Users/suntao/work/小工具/WorkBuddy工作台V3
git add release/WorkBuddy/.gitignore
git commit -m "chore: gitignore 排除 data/deep-reviews（深度复盘运行时产物）"
```

---

### Task 5: 前端——深度复盘区域（复盘弹窗）

**Files:**
- Modify: `release/WorkBuddy/自媒体工作台.html`

前端无构建无单测（与项目一致），验收 = 手动流程可走通 + 语法无错（浏览器 console 无报错）。

**插入点 A：弹窗 HTML。** `#rvInsight` 那行（约 859 行）之后、`tf-field 整体评分` 之前，插入：

```html
            <div class="rv-deep" id="rvDeep"></div>
```

**插入点 B：CSS。** 在 `/* 笔记复盘 */` 注释块（约 472 行）的规则区追加：

```css
.rv-deep{margin-top:14px;border:1px dashed var(--lav);border-radius:var(--radius);padding:12px 14px}
.rv-deep-hd{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--ink)}
.rv-deep-sub{font-size:11.5px;color:var(--ink-3);margin-top:4px;line-height:1.6}
.rv-deep-inputs{display:flex;gap:8px;margin-top:10px}
.rv-deep-inputs input{flex:1;height:38px;border:1px solid var(--line);border-radius:var(--radius-s);padding:0 12px;font-size:13px;font-family:inherit;background:var(--paper-2);outline:none}
.rv-bench-item{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--cream-2);border-radius:var(--radius-s);margin-top:8px;font-size:12.5px}
.rv-bench-meta{color:var(--ink-3);font-size:11px;white-space:nowrap}
.rv-deep-run{margin-top:10px;display:flex;gap:8px;align-items:center}
```

（若项目已有 `.rv-data`/`.rv-insight` 同风格类可对齐微调。）

**插入点 C：JS。** 在 `submitReview()` 函数（约 2388 行）之后插入整段逻辑：

```javascript
/* ===== 深度复盘（对标对比）===== */
let _rvBenches=[]; // {url,meta} 已拉取的对标卡片
async function addBench(){
  const input=$('#rvBenchInput');const url=(input&&input.value||'').trim();
  if(!url){toast('先粘贴一条对标笔记链接');return;}
  if(_rvBenches.length>=5){toast('对标笔记最多 5 条');return;}
  if(_rvBenches.some(b=>b.url===url)){toast('这条已加过');return;}
  if(input)input.value='';
  try{
    const r=await fetch('/api/note',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    const j=await r.json();
    if(!j.success){toast('拉取失败：'+(j.error||''));return;}
    _rvBenches=[..._rvBenches,{url,meta:j.data.meta}];
    renderBench();
  }catch(e){toast('网络错误：'+e.message);}
}
function delBench(i){_rvBenches=_rvBenches.filter((_,x)=>x!==i);renderBench();}
function renderBench(){
  const mine=NOTES[_revIdx],mm=mine&&mine.meta||{};
  const delta=m2=>{ if(!m2.date||!mm.date)return '';
    const d=Math.round((Date.parse(m2.date)-Date.parse(mm.date))/86400000);
    return d===0?'同日发布':(d>0?`晚 ${d} 天`:`早 ${-d} 天`); };
  const box=$('#rvBenchList');
  if(box)box.innerHTML=_rvBenches.map((b,i)=>`<div class="rv-bench-item"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(b.meta.title||'')}">${esc(b.meta.title||'(未命名)')}</span><span class="rv-bench-meta">👍${esc(b.meta.likes||'?')} ⭐${esc(b.meta.favs||'?')} · ${delta(b.meta)||'日期未知'}</span><button class="mini ghost" onclick="delBench(${i})">×</button></div>`).join('');
  renderDeepState();
}
let _rvDeepTask=null; // {taskId,step,detail} 进行中任务
async function startDeep(){
  const n=NOTES[_revIdx];
  if(!n||!n.url){toast('这篇笔记没有链接');return;}
  if(!_rvBenches.length){toast('先加至少 1 条对标笔记');return;}
  if(_rvDeepTask){toast('深度复盘进行中…');return;}
  try{
    const r=await fetch('/api/deep-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({noteUrl:n.url,benchmarkUrls:_rvBenches.map(b=>b.url)})});
    const j=await r.json();
    if(!j.success){toast(j.error||'提交失败');return;}
    _rvDeepTask={taskId:j.data.taskId,step:'已提交…',detail:''};
    renderDeepState();
    pollDeep(j.data.taskId);
  }catch(e){toast('网络错误：'+e.message);}
}
async function pollDeep(taskId){
  let n2=0;const t=setInterval(async()=>{
    n2++;if(n2>300){clearInterval(t);_rvDeepTask=null;renderDeepState();toast('深度复盘超时，稍后重试');return;}
    try{
      const r=await fetch('/api/task/'+taskId);const j=await r.json();
      if(!j.success){clearInterval(t);_rvDeepTask=null;renderDeepState();toast('任务已失效（后端可能重启）');return;}
      if(_rvDeepTask){_rvDeepTask.step=j.data.step||_rvDeepTask.step;_rvDeepTask.detail=j.data.detail||'';}
      if(j.data.status==='running'){renderDeepState();}
      else if(j.data.status==='done'){
        clearInterval(t);_rvDeepTask=null;
        NOTES[_revIdx]={...NOTES[_revIdx],deepReviewTaskId:taskId};
        saveState();renderDeepState();toast('深度复盘完成 🎯，点「打开报告文件夹」看完整分析');
      }else if(j.data.status==='failed'){
        clearInterval(t);_rvDeepTask=null;renderDeepState();toast('深度复盘失败：'+(j.data.error||'未知'));
      }
    }catch(e){}
  },2000);
}
function renderDeepState(){
  const box=$('#rvDeep');if(!box)return;
  const n=NOTES[_revIdx]||{};
  if(_rvDeepTask){
    box.innerHTML=`<div class="rv-deep-hd">🎯 深度复盘</div>
      <div style="font-size:13px;color:var(--coral-d);font-weight:600;margin-top:8px;line-height:1.5">${esc(_rvDeepTask.step||'处理中…')}</div>
      <div style="font-size:11px;color:var(--ink-3);margin-top:8px">对比分析通常 3-10 分钟（含逐篇下载正文），可先做别的，弹窗别关</div>`;
    return;
  }
  if(n.deepReviewTaskId){
    box.innerHTML=`<div class="rv-deep-hd">🎯 深度复盘 <span class="mini pri" style="margin-left:auto" onclick="openDeepFolder('${n.deepReviewTaskId}')">打开报告文件夹</span></div>
      <div class="rv-deep-sub">已有深度复盘报告。粘贴新对标可重新生成（会创建新任务，旧报告保留）。</div>
      <div class="rv-deep-inputs"><input id="rvBenchInput" placeholder="粘贴对标笔记链接，回车添加" onkeydown="if(event.key==='Enter')addBench()"></div>
      <div id="rvBenchList"></div>
      <div class="rv-deep-run"><button class="btn btn-coral" style="height:38px" onclick="startDeep()">🚀 重新深度分析</button><span style="font-size:11px;color:var(--ink-3)">需 ${_rvBenches.length||1}+ 条对标</span></div>`;
    afterDeepRender();return;
  }
  box.innerHTML=`<div class="rv-deep-hd">🎯 深度复盘（可选）</div>
    <div class="rv-deep-sub">粘 1-5 条同赛道、发布时间相近的对标笔记，AI 对比内容差异 + 数据归因，出深度报告</div>
    <div class="rv-deep-inputs"><input id="rvBenchInput" placeholder="粘贴对标笔记链接，回车添加" onkeydown="if(event.key==='Enter')addBench()"></div>
    <div id="rvBenchList"></div>
    <div class="rv-deep-run"><button class="btn btn-coral" style="height:38px" onclick="startDeep()">🚀 开始深度分析</button><span style="font-size:11px;color:var(--ink-3)">含逐篇下载，通常 3-10 分钟</span></div>`;
  afterDeepRender();
}
function afterDeepRender(){const box=$('#rvBenchList');if(box)renderBenchListOnly();}
function renderBenchListOnly(){
  const mine=NOTES[_revIdx],mm=mine&&mine.meta||{};
  const delta=m2=>{ if(!m2.date||!mm.date)return '';
    const d=Math.round((Date.parse(m2.date)-Date.parse(mm.date))/86400000);
    return d===0?'同日发布':(d>0?`晚 ${d} 天`:`早 ${-d} 天`); };
  const box=$('#rvBenchList');
  if(box)box.innerHTML=_rvBenches.map((b,i)=>`<div class="rv-bench-item"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(b.meta.title||'')}">${esc(b.meta.title||'(未命名)')}</span><span class="rv-bench-meta">👍${esc(b.meta.likes||'?')} ⭐${esc(b.meta.favs||'?')} · ${delta(b.meta)||'日期未知'}</span><button class="mini ghost" onclick="delBench(${i})">×</button></div>`).join('');
}
function openDeepFolder(id){
  fetch('/api/deep-review/'+id+'/folder').then(r=>r.json()).then(j=>{
    toast(j.success?'已在文件夹打开，查看 AI深度复盘-*.md':'打开失败：'+(j.error||''));
  }).catch(e=>toast('网络错误：'+e.message));
}
```

**接线（三处）：**
1. `openReview(idx)` 函数末尾（`$('#reviewModal').classList.add('open');` 之前）加：
   ```javascript
   _rvBenches=[];renderDeepState();
   ```
2. `closeReview` 不用改（状态在 modal 内自管理）。
3. 检查 `renderBench` 与 `renderBenchListOnly` 重复——实现时**只保留 `renderBenchListOnly`**，
   `addBench`/`delBench` 里改调 `renderBenchListOnly()`（计划里两版是演化痕迹，取后者）。

- [ ] **Step 2: 语法自检**

```bash
cd release/WorkBuddy && node -e "
const html=require('fs').readFileSync('自媒体工作台.html','utf8');
const m=html.match(/<script>([\s\S]*)<\/script>/);
new Function(m[1]); console.log('JS 语法 OK');"
```
预期：`JS 语法 OK`（若 HTML 有多个 script 块，取最后一个含主逻辑的）。

- [ ] **Step 3: 手动冒烟（后端起着时）**

```bash
cd release/WorkBuddy/server && npm run dev &
```
浏览器打开 `http://127.0.0.1:7788`，复盘模块：添加一篇自己笔记 → 点卡片 → 深度复盘区域粘一条对标链接 → 拉取卡片 → 开始深度分析 → 观察进度 → 完成后「打开报告文件夹」。
无 API key 时应弹「未配置 API key」提示——也算通过。

- [ ] **Step 4: 提交**

```bash
cd /Users/suntao/work/小工具/WorkBuddy工作台V3
git add "release/WorkBuddy/自媒体工作台.html"
git commit -m "feat: 复盘弹窗深度复盘区域（对标收集→异步分析→报告文件夹入口）"
```

---

### Task 6: 同步根目录开发版 + 全量回归

**背景：** 仓库是「根目录开发版 + release/WorkBuddy 交付副本」双份结构，功能要在两边一致。

- [ ] **Step 1: 同步文件到根目录开发版**

```bash
cd /Users/suntao/work/小工具/WorkBuddy工作台V3
cp release/WorkBuddy/server/src/parse.ts server/src/parse.ts
cp release/WorkBuddy/server/src/parse.test.ts server/src/parse.test.ts
cp release/WorkBuddy/server/src/routes/deep-review.ts server/src/routes/deep-review.ts
cp release/WorkBuddy/server/src/routes/deep-review.test.ts server/src/routes/deep-review.test.ts
cp release/WorkBuddy/server/src/routes/note.ts server/src/routes/note.ts
cp release/WorkBuddy/server/src/routes/note.test.ts server/src/routes/note.test.ts
cp release/WorkBuddy/server/src/app.ts server/src/app.ts
cp release/WorkBuddy/.gitignore .gitignore 2>/dev/null || true   # 根目录 .gitignore 若独立则手动加 data/deep-reviews/
mkdir -p .claude/skills/deep-review && cp release/WorkBuddy/.claude/skills/deep-review/SKILL.md .claude/skills/deep-review/SKILL.md
cp release/WorkBuddy/自媒体工作台.html 自媒体工作台.html
```

- [ ] **Step 2: 根目录跑全量测试**

```bash
cd server && npm test
```
预期：全 PASS。

- [ ] **Step 3: 提交**

```bash
cd /Users/suntao/work/小工具/WorkBuddy工作台V3
git add server/src .claude/skills/deep-review 自媒体工作台.html
git commit -m "feat: 深度复盘同步根目录开发版（双份结构一致）"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec 的 4 个 API（POST/GET folder/reparse + 复用 task 轮询）→ Task 3；meta.json 数据信号 → Task 3 ①；逐篇下载失败隔离 → Task 3 ② + collectNoteFiles；报告五部分结构 → Task 2 SKILL.md；防编造 → Task 3 fabricated；前端收集/轮询/文件夹/关联持久化 → Task 5；gitignore → Task 4。均覆盖。
- **占位符**：无 TBD/TODO；所有代码块完整可落地。
- **类型一致性**：`NoteEntry.downloaded`（Task 3 定义，分析 prompt 用 `e.downloaded` 一致）；`parseDeepReview` 返回 `DeepReview | null`（Task 1 定义，Task 3 用 `!parseDeepReview(...)` 判空一致）；前端 `deepReviewTaskId` 字段在 Task 5 写入与读取一致。

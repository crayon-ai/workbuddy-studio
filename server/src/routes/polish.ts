import type { FastifyPluginCallback } from "fastify";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill } from "../skill-runner.js";
import { getApiKey } from "../config.js";
import { taskLog } from "../log.js";
import { accountSlug } from "../account-dirs.js";

export interface PolishRoutesOpts {
  envPath: string;
  projectRoot: string;
}

/** ============================================================
 *  笔记优化：真实小红书笔记收录 → writing-dna 蒸馏 → 初稿润色
 *
 *  目录布局（data/accounts/<account>/polish/）：
 *    notes/<noteId>/正文.md + meta.json     收录的笔记（落库，跨会话保留）
 *    DNA/                                   蒸馏产物（按勾选集合指纹缓存）
 *      raw/*.md  fingerprint.json  语言DNA.md 等四件 + Writing-DNA.md
 *    runs/<taskId>/draft.md + output.md     每次优化运行
 *  ============================================================ */

function polishRoot(projectRoot: string, accountId: unknown): string {
  return path.join(projectRoot, "data", "accounts", accountSlug(accountId), "polish");
}

function notesDir(projectRoot: string, accountId: unknown): string {
  return path.join(polishRoot(projectRoot, accountId), "notes");
}

function dnaDir(projectRoot: string, accountId: unknown): string {
  return path.join(polishRoot(projectRoot, accountId), "DNA");
}

function runDir(projectRoot: string, accountId: unknown, taskId: string): string {
  return path.join(polishRoot(projectRoot, accountId), "runs", taskId);
}

function runDirRoot(projectRoot: string, accountId: unknown): string {
  return path.join(polishRoot(projectRoot, accountId), "runs");
}

interface NoteMeta {
  id: string;
  url: string;
  title: string;
  type: string;
  date: string;
  downloadedAt: string;
}

function readNoteMeta(dir: string, id: string): NoteMeta | null {
  const f = path.join(dir, id, "meta.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as NoteMeta;
  } catch {
    return null;
  }
}

function listNotes(root: string): NoteMeta[] {
  const dir = path.join(root, "notes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => existsSync(path.join(dir, n, "meta.json")))
    .map((n) => readNoteMeta(dir, n))
    .filter((x): x is NoteMeta => !!x)
    .sort((a, b) => (a.downloadedAt < b.downloadedAt ? 1 : -1));
}

/** 优化强度 / 篇幅 → 写进 prompt 的硬约束文案。 */
const STRENGTH_TEXT: Record<string, string> = {
  light: "轻润色——保持原句顺序与结构，仅替换措辞、注入作者口头禅与标点习惯，改动率控制在 20% 以内",
  align: "风格对齐——开头结尾、句式节奏、段落划分按作者风格重写，但初稿的信息点与叙事顺序保持不变",
  deep: "深度重写——按作者惯有的行文结构重组段落，可增删过渡句，输出与初稿差异可以较大，但核心信息点必须保留",
};
const LENGTH_TEXT: Record<string, string> = {
  keep: "输出字数控制在初稿的 ±10% 以内",
  short: "输出压缩到初稿的 70%~80%，优先删掉铺垫和重复表述",
};

/** 安全文件名（DNA/raw 用）：日期 + 标题。 */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, " ").trim().slice(0, 40) || "未命名";
}

/** 从 output.md 解析元数据注释与正文。 */
export function parsePolishOutput(md: string): {
  chips: string[];
  consistency: number | null;
  changes: number | null;
  text: string;
} {
  const m = md.match(/<!--\s*WB:STYLE\s*(\{[\s\S]*?\})\s*-->/);
  let chips: string[] = [];
  let consistency: number | null = null;
  let changes: number | null = null;
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      if (Array.isArray(j.chips)) chips = j.chips.filter((c: unknown) => typeof c === "string").slice(0, 6);
      if (typeof j.consistency === "number") consistency = Math.round(j.consistency);
      if (typeof j.changes === "number") changes = Math.round(j.changes);
    } catch {
      /* 元数据损坏则退化为纯文本 */
    }
  }
  const text = md.replace(/<!--\s*WB:STYLE[\s\S]*?-->/, "").trim();
  return { chips, consistency, changes, text };
}

export const polishRoutes: FastifyPluginCallback<PolishRoutesOpts> = (app, opts, done) => {
  /** 收录笔记列表（笔记库，跨会话持久） */
  app.get("/api/polish/notes", async (req) => {
    const { account } = (req.query as { account?: string }) ?? {};
    return { success: true, data: { notes: listNotes(polishRoot(opts.projectRoot, account)) }, error: null };
  });

  /** 查看单篇收录笔记的完整语料（正文 + 图片内容/口播逐字稿小节） */
  app.get("/api/polish/notes/:id/content", async (req) => {
    const { id } = (req.params as { id: string }) ?? {};
    const { account } = (req.query as { account?: string }) ?? {};
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id || "")) {
      return { success: false, data: null, error: "笔记 id 无效" };
    }
    const dir = path.join(notesDir(opts.projectRoot, account), id);
    const bodyPath = path.join(dir, "正文.md");
    if (!existsSync(bodyPath)) return { success: false, data: null, error: "笔记不存在" };
    const meta = readNoteMeta(path.join(dir, ".."), id);
    return {
      success: true,
      data: {
        title: meta?.title || readFileSync(bodyPath, "utf8").split("\n")[0] || "未命名笔记",
        type: meta?.type || "",
        date: meta?.date || "",
        content: readFileSync(bodyPath, "utf8"),
      },
      error: null,
    };
  });

  /** 删除一篇收录的笔记（连同目录） */
  app.delete("/api/polish/notes/:id", async (req) => {
    const { id } = (req.params as { id: string }) ?? {};
    const { account } = (req.query as { account?: string }) ?? {};
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id || "")) {
      return { success: false, data: null, error: "笔记 id 无效" };
    }
    const dir = path.join(notesDir(opts.projectRoot, account), id);
    if (!existsSync(dir)) return { success: false, data: null, error: "笔记不存在" };
    rmSync(dir, { recursive: true, force: true });
    return { success: true, data: { ok: true }, error: null };
  });

  /** 解析收录：下载真实笔记到 notes/<id>/（任务模式，前端轮询）。
   *  mock:true 时跳过下载，直接生成一篇风格统一的示例笔记落盘（小红书反爬拦截时的降级演示通道）。
   *  mock 笔记会用 URL 里的编号取不同内容，标题带「示例」标记，可正常参与蒸馏与润色。 */
  app.post("/api/polish/parse", async (req) => {
    const { url, accountId, mock } = (req.body ?? {}) as { url?: string; accountId?: string; mock?: boolean };
    if (mock) {
      const seq = (() => {
        const m = (url || "").match(/(\d+)\D*$/);
        return m ? Number(m[1]) % PL_MOCK_NOTES.length : Math.floor(Math.random() * PL_MOCK_NOTES.length);
      })();
      const note = writeMockNote(opts.projectRoot, accountId, seq, url || "");
      return { success: true, data: { taskId: null, note }, error: null };
    }
    if (!url || !/^https?:\/\/[^\s]*(xiaohongshu\.com|xhslink\.com)/i.test(url)) {
      return { success: false, data: null, error: "仅支持小红书笔记链接" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) return { success: false, data: null, error: "未配置 API key" };
    const taskId = createTask();
    const account = accountSlug(accountId);
    updateTask(taskId, { accountId: account, status: "running", step: "准备下载笔记…", updatedAt: Date.now() });
    runParseNote(taskId, url, apiKey, opts.projectRoot, account).catch((e) => {
      console.error(`[polish-parse:${taskId}] 编排异常：`, e);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() });
    });
    return { success: true, data: { taskId }, error: null };
  });

  /** 优化初稿（任务模式：必要时先蒸馏，再润色） */
  app.post("/api/polish", async (req) => {
    const { noteIds, draft, strength, length, accountId } = (req.body ?? {}) as {
      noteIds?: string[];
      draft?: string;
      strength?: string;
      length?: string;
      accountId?: string;
    };
    const ids = Array.isArray(noteIds) ? noteIds.filter((x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x)) : [];
    if (!ids.length) return { success: false, data: null, error: "请先勾选至少 1 篇参考笔记" };
    if (!draft || draft.replace(/\s/g, "").length < 30) {
      return { success: false, data: null, error: "初稿太短（至少 30 字）" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) return { success: false, data: null, error: "未配置 API key" };
    const taskId = createTask();
    const account = accountSlug(accountId);
    updateTask(taskId, { accountId: account, status: "running", step: "已提交，准备调用 skill…", updatedAt: Date.now() });
    runPolish(taskId, { noteIds: ids, draft, strength: strength || "align", length: length || "keep" }, apiKey, opts.projectRoot, account).catch((e) => {
      console.error(`[polish:${taskId}] 编排异常：`, e);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() });
    });
    return { success: true, data: { taskId }, error: null };
  });

  /** 优化历史（结果卡片列表） */
  app.get("/api/polish/runs", async (req) => {
    const { account } = (req.query as { account?: string }) ?? {};
    const dir = runDirRoot(opts.projectRoot, account);
    if (!existsSync(dir)) return { success: true, data: { runs: [] }, error: null };
    const runs = readdirSync(dir)
      .map((id) => readRunMeta(dir, id))
      .filter((x): x is NonNullable<ReturnType<typeof readRunMeta>> => !!x)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { success: true, data: { runs }, error: null };
  });

  /** 删除一条优化历史（连同 runs/<id>/ 目录） */
  app.delete("/api/polish/runs/:id", async (req) => {
    const { id } = (req.params as { id: string }) ?? {};
    const { account } = (req.query as { account?: string }) ?? {};
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id || "")) {
      return { success: false, data: null, error: "运行 id 无效" };
    }
    const dir = runDir(opts.projectRoot, account, id);
    if (!existsSync(dir)) return { success: false, data: null, error: "运行不存在" };
    rmSync(dir, { recursive: true, force: true });
    return { success: true, data: { ok: true }, error: null };
  });

  /** 单次优化详情（抽屉用：初稿 + 润色稿 + 元数据） */
  app.get("/api/polish/runs/:id", async (req) => {
    const { id } = (req.params as { id: string }) ?? {};
    const { account } = (req.query as { account?: string }) ?? {};
    const dir = runDir(opts.projectRoot, account, id);
    if (!existsSync(dir)) return { success: false, data: null, error: "运行不存在" };
    const meta = readRunMeta(runDirRoot(opts.projectRoot, account), id);
    const outputMd = existsSync(path.join(dir, "output.md")) ? readFileSync(path.join(dir, "output.md"), "utf8") : "";
    const draft = existsSync(path.join(dir, "draft.md")) ? readFileSync(path.join(dir, "draft.md"), "utf8") : "";
    if (!outputMd) return { success: false, data: null, error: "该运行没有产出结果" };
    const parsed = parsePolishOutput(outputMd);
    return {
      success: true,
      data: { id, meta: meta ?? { createdAt: "", chips: [], consistency: null, changes: null }, draft, ...parsed },
      error: null,
    };
  });

  done();
};

interface RunMeta {
  id: string;
  createdAt: string;
  draftExcerpt: string;
  chips: string[];
  consistency: number | null;
  changes: number | null;
  chars: number;
  noteCount: number;
  strength: string;
}

function readRunMeta(root: string, id: string): RunMeta | null {
  const f = path.join(root, id, "meta.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as RunMeta;
  } catch {
    return null;
  }
}


/** 示例笔记库（mock）：同一位虚构博主的统一风格——口语短句、emoji 点缀、结尾提问，
 *  用于小红书反爬拦截时的降级演示；落盘格式与真实笔记完全一致，可正常蒸馏/润色。 */
const PL_MOCK_NOTES: Array<{ title: string; type: string; date: string; body: string }> = [
  {
    title: "真的求你们试试这个15分钟晚餐！！", type: "图文", date: "2026-08-20",
    body: `真的求你们试试这个15分钟晚餐！！
下班回家累到不想说话，我现在的救命公式就是：一锅出＋现成酱料。

今天这顿：
意面煮 8 分钟，锅里直接倒奶油蘑菇酱，搅拌，完事。
巨香，真的，一整锅我一个人炫完。✅

关键就一句话：别学菜谱，学公式。
蛋白质＋主食＋一瓶好酱，随便组合，翻不了车。

你们下班后还做饭吗？评论区交换懒人菜谱👇
#下班快手菜 #打工人晚餐

## 图片内容
图1：成品俯拍，奶油意面在黑色深锅里冒着热气（真实感＞精致感）
图2：手写便利贴「15 分钟：煮面 8 + 酱 2 + 拌 1」，字有点歪
图3：洗碗池里只有一个锅，配文划重点「就洗这一个」`,
  },
  {
    title: "做了3个月自媒体，我悟了这3件事", type: "图文", date: "2026-08-28",
    body: `做了3个月自媒体，我悟了这3件事

一开始我天天憋大招，笔记写得跟论文一样，没人看。
后来改成"说话式"写作——就当在跟闺蜜聊天，数据反而起来了。

我的 3 个小心得：
1️⃣ 开头一定说人话，别铺垫
2️⃣ 一篇只讲一件事
3️⃣ 结尾必须留个钩子，让人想评论

真的，别端着。
你们写笔记卡在哪一步？评论区聊聊👇
#自媒体新手 #起号心得`,
  },
  {
    title: "打工人极简晚餐公式｜一锅出，巨省事", type: "视频", date: "2026-09-02",
    body: `打工人极简晚餐公式｜一锅出，巨省事

视频里这顿从开火到开吃 12 分钟，我真的没剪辑快进。🍳

公式给你们：
米饭/意面打底 ＋ 冷冻蛋白质（虾/鸡胸）＋ 一勺酱 ＋ 烫个绿叶菜

锅只用洗一次，这是它最大的优点，懂的都懂。

你们的一锅流代表作是什么？评论区交作业👇
#一锅出 #极简晚餐

## 口播逐字稿
"真别学菜谱了，听我的，记住一个公式就行——蛋白质、主食、一瓶好酱，完事。你看啊，虾下锅，不用解冻太久，冷冻的直接扔，八分钟。意面一起煮，省一锅。最后这个酱，我真的吹爆，倒进去搅两下就能开吃。锅呢？就洗这一个。真的，谁试谁知道。"`,
  },
  {
    title: "新手起号最容易犯的5个错，我都踩过", type: "图文", date: "2026-09-05",
    body: `新手起号最容易犯的5个错，我都踩过

花了 3 个月学费换来的，真的别再踩一遍：

❌ 什么都发，账号像杂货铺
❌ 开头三行还在"今天天气不错"
❌ 数据不好就删笔记（别删！）
❌ 日更把自己逼疯，质量崩了
❌ 从不看评论区，白瞎一堆选题

对的方法一句话：垂直、说人话、留钩子。
你们踩过哪个？评论区对个暗号👇
#起号避坑`,
  },
  {
    title: "我的下班充电清单，亲测有效那种", type: "图文", date: "2026-09-08",
    body: `我的下班充电清单，亲测有效那种

不是那种"读书健身早睡"的正确废话，是真的撑过我加班季的：

🔋 15 分钟"垃圾时间"：刷完就动，别让自己瘫住
🔋 一顿好晚饭：上面那个 15 分钟公式，救大命
🔋 睡前 10 分钟复盘：只写 3 行，多了写不下去

巨简单，但连续做一周你就知道差别了。

你们下班后怎么回血？评论区支支招👇
#下班生活 #打工人日常`,
  },
  {
    title: "周末2小时备菜，工作日彻底躺平", type: "图文", date: "2026-09-11",
    body: `周末 2 小时备菜，工作日彻底躺平

上周试了一次，这周已经离不开真的。🥬

就三步：
1. 周日下午列 5 天晚饭，只列"一锅出"
2. 蛋白质全腌好分装冷冻，酱料摆一排
3. 米饭一次煮 3 顿的量

工作日打开冰箱，10 分钟开饭，锅还只洗一次。

想看我一锅出的具体搭配吗？评论区扣 1，人多我出合集👇
#周末备菜 #一锅出`,
  },
];

function writeMockNote(projectRoot: string, accountId: unknown, seq: number, url: string): NoteMeta {
  const demo = PL_MOCK_NOTES[seq % PL_MOCK_NOTES.length];
  const id = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(notesDir(projectRoot, accountId), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "正文.md"), `# ${demo.title}\n\n${demo.body}`, "utf8");
  const meta: NoteMeta = {
    id,
    url: url || "mock://demo",
    title: demo.title,
    type: demo.type,
    date: demo.date,
    downloadedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

/** ---------- 解析收录（下载笔记 + meta） ---------- */
async function runParseNote(
  taskId: string,
  url: string,
  apiKey: string,
  projectRoot: string,
  account: string
): Promise<void> {
  const t0 = Date.now();
  taskLog("polish-parse", taskId, `提交：url=${url}`);
  const id = "n" + taskId.slice(-12); // 与 taskId 一一对应，可读
  const workDir = path.join(notesDir(projectRoot, account), id);
  mkdirSync(workDir, { recursive: true });

  const prompt = [
    "请完整执行以下下载任务：",
    "",
    "重要（执行方式，先读）：",
    "- 不要调用 Skill 工具加载任何 skill——你没有该工具权限。",
    `- 把小红书笔记 ${url} 的原文下载并整理到 ${workDir}/，动作一律用 Bash 执行（curl 拿 HTML 后从页面内嵌数据里解析出正文，需要的请求头自拟）。`,
    "",
    "产物要求（完成的唯一标准，两个文件都真实存在才算完成）：",
    `1. ${workDir}/正文.md —— 第一行是笔记标题；随后是完整正文文字（含小标题、分段、emoji、话题标签行）；若有置顶评论/作者评论补充也附在文末分隔线后。另外：`,
    `   - 图文笔记：${workDir}/images/ 里的每张图片必须用 Read 工具逐张读取（vision），把图中文字与关键视觉内容（清单/步骤/截图要点）整理成「## 图片内容」小节附在文末——图片常承载正文没有的信息，是文风与表达的一部分。图片一张都没下到就省略该小节。`,
    `   - 视频笔记：若 ffmpeg 可用且 http://localhost:2022/health 有响应，则下载视频 → ffmpeg 提取音轨 → 调用 whisper（localhost:2022）生成口播逐字稿，整理成「## 口播逐字稿」小节附在文末（去掉语气词、保留口语原貌）；工具不可用就写「## 口播逐字稿\n（本地未装 ffmpeg/whisper，跳过）」，不算失败。`,
    `2. ${workDir}/meta.json —— 严格 JSON：{"title":"...","date":"YYYY-MM-DD","type":"图文|视频"}（只要内容元信息，不要互动数据）。`,
    `3. 图片如有，下载到 ${workDir}/images/（下载不了可跳过，不算失败）。`,
    "",
    "纪律（必须遵守）：",
    "- 绝不允许登录任何账号，也不允许使用/驱动任何浏览器（含 playwright、headless、headful Chrome）去访问页面——只允许无凭证的 curl 抓取。",
    "- 只尝试 curl（可换 UA、带 URL 自带参数），两次仍被拦截就立即如实报告失败并停止，不要尝试其他绕行方案。",
    "- 绝不允许编造/模拟/占位数据。无法抓取就如实失败，不得虚构标题或数据。",
  ].join("\n");

  const r = await runSkill("writing-dna-skill", prompt, workDir, { apiKey, projectRoot }, (p) => {
    const cur = getTask(taskId);
    const logs = cur?.logs ? [...cur.logs] : [];
    if (p.step) updateTask(taskId, { step: p.step, logs: [...logs, p.step].slice(-30), updatedAt: Date.now() });
  });

  // 无论 agent 报告成败，以磁盘产物为准
  const metaPath = path.join(workDir, "meta.json");
  const bodyPath = path.join(workDir, "正文.md");
  if (!existsSync(metaPath) || !existsSync(bodyPath)) {
    taskLog("polish-parse", taskId, `失败：磁盘无产物（${r.ok ? "agent 结束但未落盘" : r.error}）`, t0);
    rmSync(workDir, { recursive: true, force: true });
    updateTask(taskId, {
      status: "failed",
      error: "笔记下载未产出文件（可能被平台限制），请换一篇链接重试",
      updatedAt: Date.now(),
    });
    return;
  }
  let raw: Record<string, string> = {};
  try {
    raw = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    raw = {};
  }
  const bodyFirst = readFileSync(bodyPath, "utf8").split("\n").find((l) => l.trim()) || "";
  const meta: NoteMeta = {
    id,
    url,
    title: (raw.title || bodyFirst.replace(/^#+\s*/, "").trim() || "未命名笔记").slice(0, 60),
    type: raw.type === "视频" ? "视频" : "图文",
    date: (raw.date || "").slice(0, 10),
    downloadedAt: new Date().toISOString(),
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  taskLog("polish-parse", taskId, `完成：${meta.title}`, t0);
  updateTask(taskId, { status: "done", step: "完成", result: { note: meta }, updatedAt: Date.now() });
}

/** ---------- 优化初稿（蒸馏缓存 + 润色） ---------- */
async function runPolish(
  taskId: string,
  input: { noteIds: string[]; draft: string; strength: string; length: string },
  apiKey: string,
  projectRoot: string,
  account: string
): Promise<void> {
  const t0 = Date.now();
  taskLog("polish", taskId, `提交：参考 ${input.noteIds.length} 篇，强度=${input.strength}，篇幅=${input.length}`);
  const workDir = runDir(projectRoot, account, taskId);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, "draft.md"), input.draft, "utf8");

  // ---- 阶段一：蒸馏（按勾选集合指纹缓存，命中则跳过） ----
  const nd = notesDir(projectRoot, account);
  const picked = input.noteIds
    .map((id) => ({ id, meta: readNoteMeta(nd, id) }))
    .filter((x): x is { id: string; meta: NoteMeta } => !!x.meta);
  if (!picked.length) {
    updateTask(taskId, { status: "failed", error: "勾选的笔记在笔记库中不存在（可能已被删除）", updatedAt: Date.now() });
    return;
  }
  const fingerprint = createHash("sha1").update(picked.map((x) => x.id).sort().join(",")).digest("hex");
  const dna = dnaDir(projectRoot, account);
  const dnaOk = existsSync(path.join(dna, "Writing-DNA.md")) &&
    (() => {
      try {
        return JSON.parse(readFileSync(path.join(dna, "fingerprint.json"), "utf8")).fingerprint === fingerprint;
      } catch {
        return false;
      }
    })();

  if (!dnaOk) {
    updateTask(taskId, { step: `蒸馏文风（${picked.length} 篇笔记）…`, updatedAt: Date.now() });
    // 重建语料：勾选笔记复制进 DNA/raw/
    rmSync(path.join(dna, "raw"), { recursive: true, force: true });
    mkdirSync(path.join(dna, "raw"), { recursive: true });
    for (const { meta } of picked) {
      const src = path.join(nd, meta.id, "正文.md");
      if (existsSync(src)) {
        const name = `${meta.date || "未知日期"} ${safeName(meta.title)}.md`.replace(/^\s+/, "");
        cpSync(src, path.join(dna, "raw", name));
      }
    }
    const distillPrompt = [
      "请完整执行以下蒸馏任务（不要调用 Skill 工具加载——你没有该权限；先用 Read 工具读取 .claude/skills/writing-dna-skill/SKILL.md 全文，严格按其蒸馏流程 Step 2-7 执行）：",
      "",
      `语料：${path.join(dna, "raw")}/ 下共 ${picked.length} 篇小红书笔记（同一作者本人所写，md 格式，文件名含日期与标题）。Step 1 已由外部完成（语料已就位），直接从 Step 2 开始。`,
      "",
      "适配说明：",
      "- 语料是短篇小红书笔记而非长文，篇数少于 20 篇属正常，按现有篇数做精简蒸馏，不要因此拒绝或要求更多语料。",
      "- 语料正文.md 里可能带「## 图片内容」（图文笔记的读图提取）与「## 口播逐字稿」（视频笔记转写）小节：它们和正文一样是作者表达，纳入 L1/L2 分析；L6 视觉层可据此分析配图功能与图文协作模式（无需再看图片文件）。",
      "- L1 语言、L2 结构、L5 认知框架为主；L3/L4 从简；L6 视觉层只做文字排版层面（emoji 用法、分段节奏、加粗与话题标签习惯），无需图片分析。",
      `- 产物（中文模板文件名）写到 ${dna}/ 目录：语言DNA.md、文章结构模板.md、写作视角与认知框架.md、视觉风格指南.md、Writing-DNA.md（整合文档 ≤4000 字）。`,
      "",
      `- 完成的唯一标准：${path.join(dna, "Writing-DNA.md")} 真实存在且内容完整。`,
      "- 绝不编造语料中不存在的特征。",
    ].join("\n");
    const rd = await runSkill("writing-dna-skill", distillPrompt, dna, { apiKey, projectRoot }, (p) => {
      if (p.step) updateTask(taskId, { step: `蒸馏文风：${p.step}`.slice(0, 120), updatedAt: Date.now() });
    });
    if (!existsSync(path.join(dna, "Writing-DNA.md"))) {
      taskLog("polish", taskId, `蒸馏失败：${rd.ok ? "agent 结束但无 Writing-DNA.md" : rd.error}`, t0);
      updateTask(taskId, { status: "failed", error: "文风蒸馏未产出 Writing-DNA.md，请重试", updatedAt: Date.now() });
      return;
    }
    writeFileSync(path.join(dna, "fingerprint.json"), JSON.stringify({ fingerprint, noteIds: picked.map((x) => x.id) }, null, 2), "utf8");
    taskLog("polish", taskId, `蒸馏完成（${picked.length} 篇）`, t0);
  } else {
    taskLog("polish", taskId, "蒸馏产物缓存命中，跳过", t0);
  }

  // ---- 阶段二：按 DNA 润色初稿 ----
  updateTask(taskId, { step: "按你的文风润色初稿…", updatedAt: Date.now() });
  const strengthText = STRENGTH_TEXT[input.strength] || STRENGTH_TEXT.align;
  const lengthText = LENGTH_TEXT[input.length] || LENGTH_TEXT.keep;
  const rewritePrompt = [
    "请完整执行以下润色任务（先用 Read 工具读取 .claude/skills/writing-dna-skill/SKILL.md 全文，严格按其第六节「使用蒸馏产物写作」执行）：",
    "",
    `- 蒸馏产物在 ${dna}/（语言DNA.md、文章结构模板.md、写作视角与认知框架.md、视觉风格指南.md、Writing-DNA.md，逐份读完，一份不跳）。`,
    `- raw 原文在 ${path.join(dna, "raw")}/（本次全读，校准语感后再下笔）。`,
    `- 待润色初稿：${path.join(workDir, "draft.md")}。`,
    "",
    `优化强度：${strengthText}。`,
    `篇幅约束：${lengthText}。`,
    "",
    `产出写到 ${path.join(workDir, "output.md")}，格式严格如下：`,
    '1. 文件第一行是元数据注释：<!--WB:STYLE {"chips":["风格标签1","风格标签2"],"consistency":85,"changes":6}-->',
    "   （chips 是从蒸馏产物提炼的风格标签，≤6 个、每个 ≤12 字；consistency 为润色稿与该作者风格的一致度自评 0-100 整数；changes 为主要改动处数整数）",
    "2. 注释之后是润色后的完整正文：直接可发布，不要任何解释、前言、标题说明或分隔线之外的附加内容。",
    "",
    `完成的唯一标准：${path.join(workDir, "output.md")} 存在且第一行含 WB:STYLE 元数据注释。`,
    "- 初稿的全部核心信息点必须保留，不得虚构新事实或数据。",
  ].join("\n");
  const rr = await runSkill("writing-dna-skill", rewritePrompt, workDir, { apiKey, projectRoot }, (p) => {
    if (p.step) updateTask(taskId, { step: `润色初稿：${p.step}`.slice(0, 120), updatedAt: Date.now() });
  });

  const outPath = path.join(workDir, "output.md");
  if (!existsSync(outPath)) {
    taskLog("polish", taskId, `润色失败：${rr.ok ? "agent 结束但无 output.md" : rr.error}`, t0);
    updateTask(taskId, { status: "failed", error: "润色未产出结果，请重试", updatedAt: Date.now() });
    return;
  }
  const parsed = parsePolishOutput(readFileSync(outPath, "utf8"));
  const meta: RunMeta = {
    id: taskId,
    createdAt: new Date().toISOString(),
    draftExcerpt: input.draft.replace(/\s/g, "").slice(0, 60),
    chips: parsed.chips,
    consistency: parsed.consistency,
    changes: parsed.changes,
    chars: parsed.text.replace(/\s/g, "").length,
    noteCount: picked.length,
    strength: input.strength,
  };
  writeFileSync(path.join(workDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  taskLog("polish", taskId, `完成：${meta.chars} 字，一致度 ${meta.consistency ?? "-"}`, t0);
  updateTask(taskId, {
    status: "done",
    step: "完成",
    result: { meta, text: parsed.text, draft: input.draft },
    updatedAt: Date.now(),
  });
}

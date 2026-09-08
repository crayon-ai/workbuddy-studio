import type { FastifyPluginCallback } from "fastify";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill, collectMarkdown } from "../skill-runner.js";
import { parseScriptTear, parseScriptGen, type ScriptTear, type ScriptGen } from "../parse.js";
import { getApiKey } from "../config.js";
import { taskLog } from "../log.js";
import { accountTaskDir, resolveTaskDir, accountSlug } from "../account-dirs.js";

export interface ScriptRoutesOpts {
  envPath: string;
  projectRoot: string;
}

/** 脚本工坊产物目录：data/accounts/<account>/scripts/<taskId>/ */
function scriptDir(projectRoot: string, accountId: unknown, taskId: string): string {
  return accountTaskDir(projectRoot, accountId, "scripts", taskId);
}

/** 原文库：data/accounts/<account>/sources/<sha1(url)>/（跨任务复用已下载的原文） */
export function sourceDir(projectRoot: string, accountId: unknown, url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 20);
  return path.join(projectRoot, "data", "accounts", accountSlug(accountId), "sources", hash);
}

/** teardowns 索引：url → 已拆解任务（复用其爆款原文，避免重复下载）。 */
function teardownIndexFile(projectRoot: string, accountId: unknown): string {
  return path.join(projectRoot, "data", "accounts", accountSlug(accountId), "teardowns", "index.json");
}

export function recordTeardownSource(projectRoot: string, accountId: unknown, url: string, taskId: string): void {
  try {
    const file = teardownIndexFile(projectRoot, accountId);
    let idx: Record<string, string> = {};
    if (existsSync(file)) idx = JSON.parse(readFileSync(file, "utf8"));
    idx[url] = taskId;
    writeFileSync(file, JSON.stringify(idx, null, 2));
  } catch (e) {
    console.error("[teardown-index] 记录失败：", e);
  }
}

/** 在已有爆款原文目录里定位实际的原文子目录（teardown 产物为 <dir>/爆款原文/<标题>/）。 */
function locateRawDir(base: string): string | null {
  const raw = path.join(base, "爆款原文");
  if (!existsSync(raw)) return null;
  const subs = readdirSync(raw).filter((n) => !n.startsWith("."));
  if (!subs.length) return null;
  return path.join(raw, subs[0]);
}

/**
 * 为一条素材 url 寻找可复用的已有原文目录（按优先级）：
 * 1. 前端指定的 reuseTaskId（HITS 里的 url→taskId 映射，覆盖无索引的旧任务）
 * 2. teardowns 索引（teardown 完成时记录）
 * 3. 本模块原文库 sources/<sha1(url)>/（script-tear 自己抓过）
 * 找不到返回 null（走全新抓取）。
 */
function findReusableRaw(
  projectRoot: string,
  accountId: unknown,
  url: string,
  reuseTaskId?: string
): { dir: string; from: string } | null {
  const candidates: Array<{ base: string; from: string; direct?: boolean }> = [];
  if (reuseTaskId) {
    candidates.push({
      base: resolveTaskDir(projectRoot, accountId, "teardowns", reuseTaskId),
      from: `爆款拆解任务 ${reuseTaskId}`,
    });
  }
  try {
    const file = teardownIndexFile(projectRoot, accountId);
    if (existsSync(file)) {
      const idx = JSON.parse(readFileSync(file, "utf8"));
      if (idx[url]) {
        candidates.push({
          base: resolveTaskDir(projectRoot, accountId, "teardowns", idx[url]),
          from: "爆款拆解原文库",
        });
      }
    }
  } catch { /* 索引损坏则忽略 */ }
  const src = sourceDir(projectRoot, accountId, url);
  if (existsSync(path.join(src, "正文.md")) || existsSync(path.join(src, "逐字稿.md"))) {
    candidates.push({ base: src, from: "脚本工坊原文库", direct: true });
  }
  for (const c of candidates) {
    if (!existsSync(c.base)) continue;
    if (c.direct) return { dir: c.base, from: c.from };
    const raw = locateRawDir(c.base);
    if (raw) return { dir: raw, from: c.from };
  }
  return null;
}

/** 参考生成的一条素材（前端从拆解结果直接传来，核心是素材脚本本身）。 */
export interface RefTear {
  title?: string;
  author?: string;
  /** 赛道（拆解识别） */
  track?: string;
  /** 命中的公式名（拆解匹配） */
  formula?: string;
  /** 匹配理由（拆解产出） */
  why?: string;
  /** 素材脚本全文（口播逐字稿/图文正文）——生成的核心学习材料 */
  script: string;
}

export const scriptRoutes: FastifyPluginCallback<ScriptRoutesOpts> = (app, opts, done) => {
  /** 提交素材结构拆解：读原文（正文+图片+视频+评论）→ 识别赛道 + 匹配内置公式 + 原样提取脚本 → structure.md */
  app.post("/api/script/tear", async (req) => {
    const { url, title, author, accountId, reuseTaskId, formulas } = (req.body ?? {}) as {
      url?: string;
      title?: string;
      author?: string;
      accountId?: string;
      reuseTaskId?: string;
      formulas?: Array<{ id: string; name: string }>;
    };
    if (!url || !/^https?:\/\//.test(url)) {
      return { success: false, data: null, error: "url 无效" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }
    if (!Array.isArray(formulas) || !formulas.length || formulas.some((f) => !f?.id || !f?.name)) {
      return { success: false, data: null, error: "公式清单缺失，请刷新页面后重试" };
    }
    const taskId = createTask();
    const account = accountSlug(accountId);
    updateTask(taskId, { accountId: account });
    const reuse = findReusableRaw(opts.projectRoot, account, url, reuseTaskId);
    taskLog(
      "script-tear",
      taskId,
      `提交：url=${url}（账号 ${account}）${reuse ? `，复用原文[${reuse.from}]` : ""}，公式清单 ${formulas.length} 条`
    );
    runScriptTear(taskId, { url, title, author }, formulas, apiKey, opts.projectRoot, account, reuse).catch((e) => {
      taskLog("script-tear", taskId, `编排异常：${String(e?.message ?? e)}`);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() });
    });
    return { success: true, data: { taskId } };
  });

  /** 提交脚本生成：口水话 + 方向 + 参考结构 → script.md */
  app.post("/api/script/gen", async (req) => {
    const { topic, mouth, style, form, len, refs, accountId } = (req.body ?? {}) as {
      topic?: string;
      mouth?: string;
      style?: string;
      form?: string;
      len?: string;
      refs?: RefTear[];
      accountId?: string;
    };
    const say = (mouth ?? "").trim();
    if (!say) {
      return { success: false, data: null, error: "口水话不能为空" };
    }
    if (say.length > 4000) {
      return { success: false, data: null, error: "口水话太长了（限 4000 字）" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }
    const taskId = createTask();
    const account = accountSlug(accountId);
    updateTask(taskId, { accountId: account });
    // 没带脚本的参考学不到东西，直接过滤掉；参考单选，只取第一条
    const validRefs = (Array.isArray(refs) ? refs : []).filter(
      (r): r is RefTear => !!r && typeof r.script === "string" && r.script.trim().length > 0
    ).slice(0, 1);
    taskLog("script-gen", taskId, `提交：选题=${topic ?? ""} 参考=${validRefs.length}（账号 ${account}）`);
    runScriptGen(taskId, { topic, mouth: say, style, form, len, refs: validRefs }, apiKey, opts.projectRoot, account).catch((e) => {
      taskLog("script-gen", taskId, `编排异常：${String(e?.message ?? e)}`);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() });
    });
    return { success: true, data: { taskId } };
  });

  done();
};

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

/** 拆解结果（识别+匹配式）：赛道 + 命中的公式 id + 理由 + 原文脚本。 */
interface TearResult {
  track: string;
  fId: string;
  why?: string;
  script: string;
}

/** 把 AI 返回的公式标记（id 或名称）解析成清单内的 id；不在清单内返回 null。 */
function resolveFormulaId(raw: string, formulas: Array<{ id: string; name: string }>): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const byId = formulas.find((f) => f.id.toLowerCase() === v.toLowerCase());
  if (byId) return byId.id;
  const byName = formulas.find((f) => f.name === v || v.includes(f.name));
  return byName ? byName.id : null;
}

/** 拆解素材：识别赛道 + 匹配一条内置公式 + 原样提取原文脚本（原文抓取/复用逻辑不变）。 */
async function runScriptTear(
  taskId: string,
  mat: { url: string; title?: string; author?: string },
  formulas: Array<{ id: string; name: string }>,
  apiKey: string,
  projectRoot: string,
  account: string,
  reuse?: { dir: string; from: string } | null
): Promise<void> {
  const t0 = Date.now();
  updateTask(taskId, { status: "running", step: "正在读取素材原文…", logs: [], updatedAt: t0 });
  const workDir = scriptDir(projectRoot, account, taskId);
  const prompt = reuse
    ? buildTearPromptFromExisting(mat, reuse.dir, workDir, formulas)
    : buildTearPrompt(mat, formulas, projectRoot, account, workDir);
  const r = await runSkill("script-tear", prompt, workDir, { apiKey, projectRoot }, makeProgress(taskId));

  const fail = (error: string) => {
    taskLog("script-tear", taskId, `失败：${error}`, t0);
    updateTask(taskId, { status: "failed", error, updatedAt: Date.now() });
  };

  if (!r.ok) {
    const recovered = parseScriptTear(collectMarkdown(workDir));
    if (recovered) return finishTearResult(recovered, formulas, taskId, t0, true);
    fail(r.error || "拆解失败，请重试");
    return;
  }
  const tear = parseScriptTear(r.artifacts);
  if (!tear) {
    fail("未能读取到素材原文（链接失效或平台反爬），无法识别与匹配，请换一条素材或稍后重试");
    return;
  }
  finishTearResult(tear, formulas, taskId, t0, false);
}

/** 解析结果 → 校验公式在清单内 → 落任务。公式不在清单/脚本为空都算失败，不伪装成功。 */
function finishTearResult(
  tear: ScriptTear,
  formulas: Array<{ id: string; name: string }>,
  taskId: string,
  t0: number,
  recovered: boolean
): void {
  const fId = resolveFormulaId(tear.formula, formulas);
  if (!fId) {
    taskLog("script-tear", taskId, `失败：AI 返回的公式「${tear.formula}」不在清单内`, t0);
    updateTask(taskId, { status: "failed", error: "AI 未匹配到公式清单内的公式，请重新拆解", updatedAt: Date.now() });
    return;
  }
  if (!tear.script || !tear.script.trim()) {
    taskLog("script-tear", taskId, "失败：未提取到原文脚本", t0);
    updateTask(taskId, { status: "failed", error: "未提取到原文脚本（逐字稿/正文为空），请换一条素材或稍后重试", updatedAt: Date.now() });
    return;
  }
  const result: TearResult = { track: tear.track, fId, why: tear.why, script: tear.script };
  taskLog("script-tear", taskId, `完成：赛道「${result.track}」· 公式 ${fId}${recovered ? "，磁盘恢复" : ""}`, t0);
  updateTask(taskId, { status: "done", result, step: `完成：${result.track} · ${fId}`, updatedAt: Date.now() });
}

/** 按参考骨架把口水话重组成脚本。 */
async function runScriptGen(
  taskId: string,
  input: { topic?: string; mouth: string; style?: string; form?: string; len?: string; refs: RefTear[] },
  apiKey: string,
  projectRoot: string,
  account: string
): Promise<void> {
  const t0 = Date.now();
  updateTask(taskId, { status: "running", step: "正在按参考结构重写口水话…", logs: [], updatedAt: t0 });
  const workDir = scriptDir(projectRoot, account, taskId);
  const prompt = buildGenPrompt(input, workDir);
  const r = await runSkill("script-writer", prompt, workDir, { apiKey, projectRoot }, makeProgress(taskId));

  if (!r.ok) {
    const recovered = parseScriptGen(collectMarkdown(workDir));
    if (recovered) {
      taskLog("script-gen", taskId, `skill 失败（${r.error}）但磁盘已产出脚本`, t0);
      updateTask(taskId, { status: "done", result: recovered, step: "完成（从磁盘恢复）", updatedAt: Date.now() });
      return;
    }
    taskLog("script-gen", taskId, `失败：${r.error}`, t0);
    updateTask(taskId, { status: "failed", error: r.error, updatedAt: Date.now() });
    return;
  }
  const gen = parseScriptGen(r.artifacts);
  if (!gen) {
    taskLog("script-gen", taskId, "失败：skill 结束但未产出 script.md", t0);
    updateTask(taskId, {
      status: "failed",
      error: "脚本未生成（AI 未按约定落盘），请重试",
      updatedAt: Date.now(),
    });
    return;
  }
  taskLog("script-gen", taskId, `完成：《${gen.title ?? "未命名"}》${gen.text.length} 字`, t0);
  updateTask(taskId, { status: "done", result: gen, step: "完成", updatedAt: Date.now() });
}

function buildTearPrompt(
  mat: { url: string; title?: string; author?: string },
  formulas: Array<{ id: string; name: string }>,
  projectRoot: string,
  account: string,
  workDir: string
): string {
  const libraryDir = sourceDir(projectRoot, account, mat.url);
  return [
    "请完整执行以下两步（缺一不可）：",
    "",
    "重要（执行方式，先读）：",
    "- 第一步必须先用 Read 工具读取 .claude/skills/script-tear/SKILL.md 全文，严格按其规定执行。",
    "- 直接开始执行，不要复述或介绍 skill 会做什么。",
    `- 完成的唯一标准：${workDir}/structure.md 文件真实存在。`,
    "",
    "本任务为【模式 B：全新抓取】。素材信息：",
    `- 链接：${mat.url}`,
    mat.title ? `- 标题：${mat.title}` : "",
    mat.author ? `- 作者：${mat.author}` : "",
    `- 原文库目录（把抓到的正文/图片文字/逐字稿/评论归档到这里）：${libraryDir}`,
    "",
    "1. 完整抓取原文（按 SKILL.md 的模式 B：正文 + 图片内文字 + 视频逐字稿 + 评论区，全部归档到原文库目录）。",
    "   关键钩子常在封面图或口播前几秒——图片必须逐张分析提取文字（webp/avif 先用 ffmpeg 或 sips 转成 jpg 再分析，单图失败跳过不卡死），视频必须转逐字稿。",
    "   若最终完全拿不到有效内容（平台反爬/失效），不要编造——如实说明失败原因并停止，不写 structure.md。",
    `2. 读完全部原文后做【识别与匹配】，写入 ${workDir}/structure.md（格式见下）：`,
    "   - 赛道：给这篇素材归一个赛道，只输出一个词（如 美食 / 职场 / AI工具 / 旅行 / 穿搭 / 好物种草 / 情感 / 财经…），从内容本身归纳；",
    "   - 公式：从下方公式清单里【必须且只能选一个】，在「## 公式」下输出它的 id（如 f5）；",
    "   - 匹配理由：一句话讲清为什么命中这条公式（对照它的结构特征，说具体，不许空话）；",
    "   - 脚本：把原文脚本【原样】抄进「## 脚本」——视频抄逐字稿全文，图文抄正文全文；保留原有分段与换行，不总结、不缩写、不加工、不加任何批注。",
    "",
    "【公式清单】（必须且只能从中选一个）：",
    ...formulas.map((f) => `- ${f.id}｜${f.name}`),
    "",
    "structure.md 格式（严格照此）：",
    "",
    "## 赛道",
    "<一个词>",
    "",
    "## 公式",
    "<公式 id，如 f5>",
    "",
    "## 匹配理由",
    "<一句话>",
    "",
    "## 脚本",
    "<原文脚本全文，原样>",
    "",
    "硬约束：",
    "- 公式必须来自清单，不允许自创；如果几条都像，选最接近的一条，并在匹配理由里说明取舍。",
    "- 脚本必须原样来自素材（逐字稿/正文），禁止改写、缩写、编造；脚本为空就不要写 structure.md。",
  ]
    .filter(Boolean)
    .join("\n");
}

const LEN_BUDGET: Record<string, string> = {
  "30秒": "全篇约 100 字（口播 30 秒），钩子 20 字内、主体最重",
  "60秒": "全篇约 200 字（口播 60 秒），按段落职责分配",
  不限: "不限字数，按内容需要",
};

function buildTearPromptFromExisting(
  mat: { url: string; title?: string; author?: string },
  rawDir: string,
  workDir: string,
  formulas: Array<{ id: string; name: string }>
): string {
  return [
    "请完整执行以下两步（缺一不可）：",
    "",
    "重要（执行方式，先读）：",
    "- 第一步必须先用 Read 工具读取 .claude/skills/script-tear/SKILL.md 全文，严格按其规定执行。",
    "- 直接开始执行，不要复述或介绍 skill 会做什么。",
    `- 完成的唯一标准：${workDir}/structure.md 文件真实存在。`,
    "",
    "本任务为【模式 A：复用已有原文】——素材原文之前已下载归档，**禁止任何网络请求重新下载**。素材信息：",
    `- 链接：${mat.url}`,
    mat.title ? `- 标题：${mat.title}` : "",
    `- 已有原文目录：${rawDir}`,
    "",
    `1. 用 Read 读取该目录下的全部素材（正文.md / 图片文字.md 或 逐字稿.md / 评论.md；需要看原图时逐张 Read 图片/ 目录下的图片文件），确认内容非空。`,
    "   若该目录内容为空或只有占位文件（原文实际未下载成功），才转为一句话说明情况并停止，不写 structure.md，也不要自行联网下载。",
    `2. 读完全部原文后做【识别与匹配】，写入 ${workDir}/structure.md（格式见下）：`,
    "   - 赛道：给这篇素材归一个赛道，只输出一个词（如 美食 / 职场 / AI工具 / 旅行 / 穿搭 / 好物种草 / 情感 / 财经…），从内容本身归纳；",
    "   - 公式：从下方公式清单里【必须且只能选一个】，在「## 公式」下输出它的 id（如 f5）；",
    "   - 匹配理由：一句话讲清为什么命中这条公式（对照它的结构特征，说具体，不许空话）；",
    "   - 脚本：把原文脚本【原样】抄进「## 脚本」——视频抄逐字稿全文，图文抄正文全文；保留原有分段与换行，不总结、不缩写、不加工、不加任何批注。",
    "",
    "【公式清单】（必须且只能从中选一个）：",
    ...formulas.map((f) => `- ${f.id}｜${f.name}`),
    "",
    "structure.md 格式（严格照此）：",
    "",
    "## 赛道",
    "<一个词>",
    "",
    "## 公式",
    "<公式 id，如 f5>",
    "",
    "## 匹配理由",
    "<一句话>",
    "",
    "## 脚本",
    "<原文脚本全文，原样>",
    "",
    "硬约束：",
    "- 公式必须来自清单，不允许自创；如果几条都像，选最接近的一条，并在匹配理由里说明取舍。",
    "- 脚本必须原样来自素材（逐字稿/正文），禁止改写、缩写、编造；脚本为空就不要写 structure.md。",
  ].join("\n");
}

function buildGenPrompt(
  input: { topic?: string; mouth: string; style?: string; form?: string; len?: string; refs: RefTear[] },
  workDir: string
): string {
  const main = input.refs[0]; // 参考单选：只展开第一条（前端已限制，多余传入忽略）
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  const lines: string[] = [
    "请先用 Read 工具读取 .claude/skills/script-writer/SKILL.md 全文，按其规定执行。然后用 Write 工具把最终脚本写入：",
    `${workDir}/script.md`,
    "",
    "任务：参考选定素材的脚本，学习素材脚本的情绪、结构、爆点，把用户输入的随意的一段内容，组织成一段可以直接用来口播/写大纲的内容脚本。",
    "",
  ];
  if (main) {
    lines.push(
      "【参考 · 素材脚本】（学它的写法，不是照抄它的内容）",
      `《${main.title ?? "未命名素材"}》${main.author ? `（${main.author}）` : ""}${main.track ? ` · 赛道：${main.track}` : ""}${main.formula ? ` · 命中公式：${main.formula}` : ""}`
    );
    if (main.why) lines.push(`（匹配理由：${main.why}）`);
    lines.push("素材脚本全文：", cap(main.script, 2000), "");
  } else {
    lines.push(
      "【未选定参考素材】按通用爆款节奏写——开头 3 秒留人，中段把干货排得有节奏，结尾引导互动。",
      ""
    );
  }
  lines.push(
    "【用户内容】（改写的原料，内容以它为准）",
    `选题：${input.topic ?? "（未填）"}`,
    "口水话（用户随手记的，口语化，想到啥写啥）：",
    input.mouth,
    `风格：${input.style || "不限"}｜形式：${input.form || "不限"}｜时长：${input.len || "不限"}${input.len && LEN_BUDGET[input.len] ? `（${LEN_BUDGET[input.len]}）` : ""}`,
    "",
    "【怎么用参考脚本】",
    "- 情绪：学它的语感、态度和温度（是吐槽、真诚分享还是热血），让改写后的脚本带上同款情绪；",
    "- 结构：学它怎么开场留人、怎么推进节奏、怎么收尾引互动；段数与节奏的取舍以「最适合用户这段内容」为准，不必逐段硬套；",
    "- 爆点：学它埋钩子的手法（数字反差、金句、悬念、提问、扣字互动…），在用户内容的合适位置用上；",
    "- 参考脚本里的具体内容、例子、数字不要搬进脚本；用户没给的关键信息（价格/天数/数据…）不要编造，文中用【补：需要什么】标出，让用户自己填。",
    "- 保持口水话原本的语感，像人说话，不要 AI 腔；写出来的东西要能直接拿去口播或写大纲。",
    "",
    "script.md 落盘格式（正文是完整一篇，不要分节）：",
    "",
    "## 标题",
    "<给这篇脚本起一个标题，一行>",
    "",
    "## 正文",
    "<完整脚本正文——像正常人写脚本一样自然成文：按内容自然分段、用空行控制节奏；",
    " 不要 ①②③/数字编号，不要「段名」「套用」这类小标题和批注，不要 markdown 记号；",
    " 写出来就是能直接念、直接发的整篇文案>"
  );
  return lines.join("\n");
}

export type { ScriptTear, ScriptGen };

import type { FastifyPluginCallback } from "fastify";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill, collectMarkdown } from "../skill-runner.js";
import { parseScriptTear, parseScriptGen, type ScriptTear, type ScriptGen } from "../parse.js";
import { fetchMaterialRaw } from "../tear-fetch.js";
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
  /** 提交素材结构拆解：读原文（正文+图片+视频逐字稿，不抓评论区）→ 识别赛道 + 匹配内置公式 + 原样提取脚本 → structure.md */
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

/** 拆解素材：识别赛道 + 匹配一条内置公式；原文抓取以「后端直连」为主路径，agent 只做识别与匹配。
 *  性能分工：下载/转码/whisper 转写是确定性工作，后端并行直连（分钟级 → 秒级）；
 *  后端抓不到有效内容（反爬等）才回退 agent 全流程兜底。 */
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
  const rawDir = reuse ? reuse.dir : sourceDir(projectRoot, account, mat.url);
  let fallbackFetch = false;

  if (reuse) {
    updateTask(taskId, { step: "复用已归档原文，AI 识别与匹配中…", updatedAt: Date.now() });
  } else {
    updateTask(taskId, { step: "后端直连抓取原文与媒体…", updatedAt: Date.now() });
    const fr = await fetchMaterialRaw(mat.url, rawDir, (s) =>
      updateTask(taskId, { step: s.slice(0, 120), updatedAt: Date.now() })
    );
    taskLog("script-tear", taskId, `后端抓取：${fr.note}`, t0);
    if (fr.ok) {
      updateTask(taskId, { step: "原文就绪，AI 识别与匹配中…", updatedAt: Date.now() });
    } else {
      fallbackFetch = true;
      taskLog("script-tear", taskId, "后端未获有效内容，回退 agent 全流程抓取", t0);
      updateTask(taskId, { step: "AI 抓取原文中（兜底全流程）…", updatedAt: Date.now() });
    }
  }

  const prompt = fallbackFetch
    ? buildFallbackFetchPrompt(mat, rawDir, workDir, formulas)
    : buildAnalyzePrompt(mat, rawDir, workDir, formulas, reuse ? "模式 A：复用已有原文" : "模式 A：原文已由后端抓取归档");
  const r = await runSkill("script-tear", prompt, workDir, { apiKey, projectRoot }, makeProgress(taskId));

  const fail = (error: string) => {
    taskLog("script-tear", taskId, `失败：${error}`, t0);
    updateTask(taskId, { status: "failed", error, updatedAt: Date.now() });
  };

  // agent 不再逐字抄写原文（省掉最慢的大输出段）：structure.md 缺「## 脚本」时由后端从原文库机械拼接
  appendScriptSection(workDir, rawDir);

  // 拼接完成后从磁盘统一收集产物（r.artifacts 是拼接前的快照，不能直接用）
  const artifacts = collectMarkdown(workDir);
  if (!r.ok) {
    const recovered = parseScriptTear(artifacts);
    if (recovered) return finishTearResult(recovered, formulas, taskId, t0, true);
    fail(r.error || "拆解失败，请重试");
    return;
  }
  const tear = parseScriptTear(artifacts);
  if (!tear) {
    fail("未能读取到素材原文（链接失效或平台反爬），无法识别与匹配，请换一条素材或稍后重试");
    return;
  }
  finishTearResult(tear, formulas, taskId, t0, false);
}

/** 原文脚本来源：视频优先逐字稿，图文用正文；去掉文件头部的 markdown 标题行。 */
export function chooseScriptText(rawDir: string): string | null {
  const pick = (name: string, min: number): string | null => {
    const p = path.join(rawDir, name);
    if (!existsSync(p)) return null;
    const txt = readFileSync(p, "utf8").trim();
    return txt.length >= min ? txt : null;
  };
  const src = pick("逐字稿.md", 20) ?? pick("正文.md", 20);
  if (!src) return null;
  return src.replace(/^(#[^\n]*\n+)+/, "").trim() || null;
}

/** structure.md 缺「## 脚本」节时，把原文脚本机械拼接进去（已含则不动，兼容 agent 自带脚本的产物）。 */
export function appendScriptSection(workDir: string, rawDir: string): void {
  const p = path.join(workDir, "structure.md");
  if (!existsSync(p)) return;
  const md = readFileSync(p, "utf8");
  if (/^##\s*脚本/m.test(md)) return;
  const script = chooseScriptText(rawDir);
  if (!script) return;
  writeFileSync(p, `${md.replace(/\s+$/, "")}\n\n## 脚本\n\n${script}\n`);
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

/** 识别与匹配 prompt（主路径）：原文已备好（复用或后端直连抓取），agent 零网络请求、不抄原文。 */
function buildAnalyzePrompt(
  mat: { url: string; title?: string; author?: string },
  rawDir: string,
  workDir: string,
  formulas: Array<{ id: string; name: string }>,
  modeLabel: string
): string {
  return [
    "请完整执行以下任务：爆款素材的识别与匹配。",
    "",
    "重要（分工说明，先读）：",
    `- 本任务为【${modeLabel}】——素材原文已下载归档，你**禁止任何网络请求**（不 curl、不下载任何东西）。`,
    "原文脚本（逐字稿/正文全文）由调用方从原文目录直接拼接，你不要抄写原文全文；你只负责：归赛道、匹配公式、给匹配理由，以及（仅在缺少时）识别图片内文字。",
    "",
    "素材信息：",
    `- 链接：${mat.url}`,
    mat.title ? `- 标题：${mat.title}` : "",
    mat.author ? `- 作者：${mat.author}` : "",
    `- 原文目录：${rawDir}（含 正文.md；视频素材另有 逐字稿.md；可能含 图片/ 目录）`,
    "",
    "步骤：",
    "1. 用 Read 读取原文目录下的 正文.md 与 逐字稿.md（存在哪个读哪个，都存在则都读）。",
    `2. 若原文目录存在 图片/ 目录且没有 图片文字.md：逐张 Read 图片（jpg/png 可直接读；webp/avif 先用 sips 转成 jpg 再读），把图内文字（封面钩子、图卡标题、步骤文字）整理写入 ${rawDir}/图片文字.md——封面一句话钩子往往是整篇最关键的素材；单张识别失败就跳过并在文件里注明，绝不允许编造。若已有 图片文字.md，直接 Read 它。`,
    `3. 通读全部素材（正文 + 图内文字 + 逐字稿）后，用 Write 写 ${workDir}/structure.md，只包含以下三节，格式严格照此：`,
    "",
    "## 赛道",
    "<一个词，如 美食 / 职场 / AI工具 / 旅行 / 穿搭 / 好物种草 / 情感 / 财经…，从内容本身归纳>",
    "",
    "## 公式",
    "<公式 id，如 f5>",
    "",
    "## 匹配理由",
    "<一句话，对照命中公式的结构特征说清这篇素材怎么就符合它，点出素材里的实际做法，不许空话>",
    "",
    "【公式清单】（必须且只能选一个）：",
    ...formulas.map((f) => `- ${f.id}｜${f.name}`),
    "",
    "硬约束：",
    "- 不要写「## 脚本」节（脚本由调用方拼接），不要抄写原文全文。",
    "- 公式必须来自清单，不允许自创；如果几条都像，选最接近的一条，并在匹配理由里说明取舍。",
    "- 若原文目录内容为空或只有占位元信息（无正文内容也无逐字稿），不要写 structure.md，一句话如实说明并停止。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 兜底抓取 prompt（后端直连失败时）：agent 全流程抓全量 + 识别与匹配。同样不抄脚本、不抓评论区。 */
function buildFallbackFetchPrompt(
  mat: { url: string; title?: string; author?: string },
  rawDir: string,
  workDir: string,
  formulas: Array<{ id: string; name: string }>
): string {
  return [
    "请完整执行以下两步（缺一不可）：",
    "",
    "重要（执行方式，先读）：",
    "- 用 Bash（curl，带浏览器 UA，-L 跟随跳转）抓取素材，绝不登录任何账号，不使用任何浏览器自动化。",
    `- 完成的唯一标准：${workDir}/structure.md 文件真实存在。`,
    "",
    "本任务为【模式 B：全新抓取（后端直连失败后的兜底）】。素材信息：",
    `- 链接：${mat.url}`,
    mat.title ? `- 标题：${mat.title}` : "",
    mat.author ? `- 作者：${mat.author}` : "",
    `- 原文库目录（把抓到的正文/图片文字/逐字稿归档到这里）：${rawDir}`,
    "",
    "1. 完整抓取原文（抓不到就如实说明失败并停止，不编造）：",
    "   - 抓正文文字（从页面内嵌 JSON 里提取，小红书看 __INITIAL_STATE__ 的 noteDetailMap），存 原文库目录/正文.md（开头一行标题）。",
    "   - 图片内文字：下载正文/封面图片到 原文库目录/图片/（webp/avif 先用 ffmpeg 或 sips 转成 jpg），逐张识别图片内文字（封面钩子、图卡标题、步骤文字）整理成 原文库目录/图片文字.md——钩子常在封面图上，图片文字是拆解的必备输入；单张失败跳过并注明，不编造。",
    "   - 视频逐字稿：下载视频（探索页面 API，B站可走 html5 playurl），ffmpeg 转音频（ffmpeg -i 视频.mp4 -vn -ar 16000 -ac 1 音频.wav），本机 127.0.0.1:2022 有 whisper server（OpenAI 兼容 /v1/audio/transcriptions，必须带 language=zh），转写结果存 原文库目录/逐字稿.md；whisper 不可用则如实说明并跳过。",
    "   - 评论区不抓取、不翻页、不归档（拆解只需要素材本身的内容）。",
    `2. 通读全部素材后做【识别与匹配】，用 Write 写 ${workDir}/structure.md，只包含以下三节：`,
    "",
    "## 赛道",
    "<一个词>",
    "",
    "## 公式",
    "<公式 id，如 f5>",
    "",
    "## 匹配理由",
    "<一句话，点出素材里的实际做法，不许空话>",
    "",
    "【公式清单】（必须且只能从中选一个）：",
    ...formulas.map((f) => `- ${f.id}｜${f.name}`),
    "",
    "硬约束：",
    "- 不要写「## 脚本」节（脚本由调用方从原文库拼接），不要抄写原文全文。",
    "- 公式必须来自清单，不允许自创；几条都像时选最接近的一条，并在匹配理由里说明取舍。",
    "- 抓不到有效内容（平台反爬/链接失效）时不要编造，如实说明并停止，不写 structure.md。",
  ]
    .filter(Boolean)
    .join("\n");
}

const LEN_BUDGET: Record<string, string> = {
  "30秒": "全篇约 100 字（口播 30 秒），钩子 20 字内、主体最重",
  "60秒": "全篇约 200 字（口播 60 秒），按段落职责分配",
  不限: "不限字数，按内容需要",
};

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

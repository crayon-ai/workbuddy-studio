import type { FastifyPluginCallback } from "fastify";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill } from "../skill-runner.js";
import { getApiKey, parseEnv, getProvider, resolveModelName } from "../config.js";
import { taskLog } from "../log.js";
import { accountSlug } from "../account-dirs.js";
import { fetchXhsNoteViaReader } from "../reader-fetch.js";

export interface MaterialRoutesOpts {
  envPath: string;
  projectRoot: string;
}

/** ============================================================
 *  素材库「添加素材链接」：粘贴小红书/抖音链接 → 无凭证下载解析
 *  → 产出 素材.json（标题/作者/日期/互动/摘要/值得学习的点）→ 前端存素材卡片。
 *  产物目录：data/accounts/<account>/materials/<taskId>/
 *
 *  两条通道：
 *  - 小红书：快速通道（无 Agent）。服务端代码完成 UA 轮换下载 + 内嵌 JSON
 *    提取（确定性、毫秒级），仅「摘要 + 学习点」一次直连 /v1/messages，
 *    端到端 ~15-30s（原 Agent 通道实测 ~260s，大量时间耗在子进程启动和
 *    模型反复数字数上）。直连被平台登录墙拦截时，自动降级「云端渲染读取」
 *    （reader-fetch：Firecrawl API / ChatCut MCP 桥，无凭证，取 og 元数据）。
 *  - 抖音：保留原 Agent 通道（页面结构与小红书不同，且低频，暂不改）。
 *  ============================================================ */
export function materialPlat(url: string): "xhs" | "dy" | null {
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return "xhs";
  if (/douyin\.com/i.test(url)) return "dy";
  return null;
}

interface MaterialParsed {
  title: string;
  author: string;
  date: string;
  type: string;
  like: string;
  fav: string;
  summary: string;
  points: string[];
}

export const materialRoutes: FastifyPluginCallback<MaterialRoutesOpts> = (app, opts, done) => {
  app.post("/api/material/parse", async (req) => {
    const { url, accountId } = (req.body ?? {}) as { url?: string; accountId?: string };
    if (!url || !/^https?:\/\//i.test(url)) {
      return { success: false, data: null, error: "链接无效" };
    }
    const plat = materialPlat(url);
    if (!plat) return { success: false, data: null, error: "仅支持小红书或抖音链接" };
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) return { success: false, data: null, error: "未配置 API key" };

    const taskId = createTask();
    const account = accountSlug(accountId);
    updateTask(taskId, { accountId: account, status: "running", step: "准备解析素材…", updatedAt: Date.now() });
    const run = plat === "xhs" ? runParseXhsFast : runParseMaterialAgent;
    run(taskId, url, apiKey, opts.projectRoot, opts.envPath, account).catch((e) => {
      console.error(`[material:${taskId}] 编排异常：`, e);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() });
    });
    return { success: true, data: { taskId }, error: null };
  });

  done();
};

/** 任务完成判定与产物读取（两条通道共用）。 */
async function finishWithArtifact(
  taskId: string,
  workDir: string,
  url: string,
  plat: "xhs" | "dy",
  t0: number
): Promise<void> {
  const outPath = path.join(workDir, "素材.json");
  if (!existsSync(outPath)) {
    taskLog("material", taskId, `失败：无产物文件（现场保留于 ${workDir}）`, t0);
    updateTask(taskId, {
      status: "failed",
      error: "素材解析未产出结果（可能被平台限制），请换一条链接重试",
      updatedAt: Date.now(),
    });
    return;
  }
  let parsed: MaterialParsed;
  try {
    parsed = JSON.parse(readFileSync(outPath, "utf8")) as MaterialParsed;
  } catch (e) {
    taskLog("material", taskId, `失败：素材.json 解析错误`, t0);
    updateTask(taskId, { status: "failed", error: "素材数据格式异常，请重试", updatedAt: Date.now() });
    return;
  }
  taskLog("material", taskId, `完成：${parsed.title}`, t0);
  updateTask(taskId, {
    status: "done",
    step: "完成",
    result: { material: { ...parsed, url, plat } },
    updatedAt: Date.now(),
  });
}

/* ============ 小红书快速通道（无 Agent） ============ */

const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

interface XhsNote {
  title: string;
  desc: string;
  author: string;
  timeMs: number;
  type: "normal" | "video" | string;
  like: string;
  fav: string;
}

/** 单次抓取：跟随跳转，返回最终 URL（短链 → 笔记页）与 HTML。 */
async function fetchHtml(url: string, ua: string): Promise<{ html: string; finalUrl: string }> {
  const res = await fetch(url, {
    headers: {
      "user-agent": ua,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
      referer: "https://www.xiaohongshu.com/",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: await res.text(), finalUrl: res.url || url };
}

/** 从 URL（含跳转后的最终 URL）里取笔记 id。 */
function xhsNoteId(url: string): string | null {
  const m = url.match(/(?:explore|discovery\/item)\/([0-9A-Za-z]+)/);
  return m ? m[1] : null;
}

/** 提取页面内嵌 window.__INITIAL_STATE__ 并解析为对象；失败返回 null。 */
function parseInitialState(html: string): any | null {
  const marker = html.indexOf("window.__INITIAL_STATE__");
  if (marker < 0) return null;
  const start = html.indexOf("{", marker);
  const end = html.indexOf("</script>", start);
  if (start < 0 || end < 0) return null;
  // 页面里是 JS 对象字面量而非严格 JSON：undefined 需替换后才能 JSON.parse
  const raw = html.slice(start, end).replace(/\bundefined\b/g, "null");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 从 __INITIAL_STATE__.note.noteDetailMap 里取出笔记核心字段。 */
function extractXhsNote(html: string, noteId: string | null): XhsNote | null {
  const state = parseInitialState(html);
  if (!state?.note?.noteDetailMap) return null;
  const map = state.note.noteDetailMap as Record<string, { note?: any }>;
  const entry = (noteId && map[noteId]) || Object.values(map)[0];
  const n = entry?.note;
  if (!n || (!n.title && !n.desc)) return null;
  const inter = n.interactInfo || {};
  return {
    title: String(n.title || String(n.desc || "").slice(0, 24) || "未命名笔记"),
    desc: String(n.desc || ""),
    author: String(n.user?.nickname || "未知作者"),
    timeMs: Number(n.time) || 0,
    type: String(n.type || "normal"),
    like: String(inter.likedCount ?? "0"),
    fav: String(inter.collectedCount ?? "0"),
  };
}

/** 下载策略阶梯：桌面 UA → iPhone UA → 移动端点（拿到笔记 id 后动态加入）；任一策略提取到笔记即返回。 */
async function downloadXhsNote(url: string): Promise<XhsNote> {
  const errors: string[] = [];
  const tried = new Set<string>();
  const queue: Array<{ name: string; url: string; ua: string }> = [
    { name: "桌面 UA", url, ua: UA_DESKTOP },
    { name: "iPhone UA", url, ua: UA_IPHONE },
  ];
  let noteId = xhsNoteId(url);
  for (let i = 0; i < queue.length && i < 6; i++) {
    const a = queue[i];
    const key = a.url + "|" + a.ua;
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      const { html, finalUrl } = await fetchHtml(a.url, a.ua);
      const id = xhsNoteId(finalUrl);
      if (id) noteId = noteId || id;
      const note = extractXhsNote(html, noteId);
      if (note) return note;
      errors.push(`${a.name}：页面无笔记数据`);
      // 前两个策略都拿不到数据时补移动端点策略（同一笔记 id，换 m 站路径）
      if (noteId) {
        queue.push({ name: "移动端点", url: `https://m.xiaohongshu.com/discovery/item/${noteId}`, ua: UA_IPHONE });
      }
    } catch (e: any) {
      errors.push(`${a.name}：${e?.message ?? e}`);
    }
  }
  // 直连策略全部失败（小红书已对无凭证直连上强制登录墙/指纹校验）→ 云端渲染读取兜底：
  // 经 Firecrawl（API key 或 ChatCut 桥）无凭证渲染页面，从 og 元数据取笔记信息。
  try {
    const r = await fetchXhsNoteViaReader(url);
    return {
      title: r.title,
      desc: r.desc,
      author: r.author || "未知作者",
      timeMs: r.timeMs,
      type: r.type,
      like: r.like || "0",
      fav: r.fav || "0",
    };
  } catch (e: any) {
    errors.push(`云端渲染读取：${e?.message ?? e}`);
  }
  throw new Error(`下载失败（${errors.join("；")}）`);
}

/** 一次直连 /v1/messages 生成摘要与学习点；失败返回 null（调用方降级用正文截断）。 */
async function summarizeViaLlm(
  apiKey: string,
  envPath: string,
  title: string,
  desc: string
): Promise<{ summary: string; points: string[] } | null> {
  const file = parseEnv(envPath);
  const rawBase = (process.env.ANTHROPIC_BASE_URL || file.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "");
  const url = rawBase ? `${rawBase}/v1/messages` : "https://api.anthropic.com/v1/messages";
  const model = resolveModelName(envPath) ?? "claude-sonnet-4-5";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (getProvider(envPath) === "anthropic") headers["x-api-key"] = apiKey;
  else headers.authorization = `Bearer ${apiKey}`;

  const body = desc.length > 1500 ? desc.slice(0, 1500) : desc;
  const prompt = [
    "你是内容运营助手。基于以下小红书笔记的真实内容，只输出一个严格 JSON 对象（不要 markdown 代码块、不要任何多余文字）：",
    `{"summary":"基于正文的中文摘要，60~80字，客观概述这篇笔记讲了什么","points":["值得学习的写作或选题技巧1","技巧2","技巧3"]}`,
    "要求：points 每条不超过 20 字、共 3 条，全部来自真实内容，不编造；摘要写完即止，不要反复斟酌字数。",
    "",
    `标题：${title}`,
    `正文：${body}`,
  ].join("\n");

  try {
    // glm-4.6 是思考型模型：先出 thinking 块再出 text 块，max_tokens 给足否则思考烧完额度就收不到正文
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    const text: string = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const l = text.indexOf("{");
    const r = text.lastIndexOf("}");
    if (l < 0 || r <= l) throw new Error("返回里没有 JSON");
    const parsed = JSON.parse(text.slice(l, r + 1));
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.points)) throw new Error("JSON 字段缺失");
    return { summary: parsed.summary, points: parsed.points.map((p: any) => String(p).slice(0, 30)) };
  } catch (e) {
    taskLog("material", "llm", `摘要生成降级：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 摘要超长时按句读边界裁剪，避免拦腰截断。 */
function trimSummary(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= 100) return t;
  const cut = t.slice(0, 100);
  const p = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf("，"));
  return p > 40 ? cut.slice(0, p + 1) : cut + "…";
}

async function runParseXhsFast(
  taskId: string,
  url: string,
  apiKey: string,
  projectRoot: string,
  envPath: string,
  account: string
): Promise<void> {
  const t0 = Date.now();
  taskLog("material", taskId, `提交：xhs ${url}（快速通道）`);
  const workDir = path.join(projectRoot, "data", "accounts", account, "materials", taskId);
  mkdirSync(workDir, { recursive: true });

  try {
    updateTask(taskId, { step: "正在下载笔记页面…", updatedAt: Date.now() });
    const note = await downloadXhsNote(url);

    updateTask(taskId, { step: "下载成功，正在生成摘要…", updatedAt: Date.now() });
    const llm = await summarizeViaLlm(apiKey, envPath, note.title, note.desc);
    // 降级策略：LLM 不可用时用正文截断当摘要，卡片依然可用（内容全部来自真实抓取，不编造）
    const summary = trimSummary(llm?.summary || note.desc);
    const points = llm?.points?.length ? llm.points : ["内容完整，可作参考"];

    const date = note.timeMs
      ? new Date(note.timeMs + 8 * 3600 * 1000).toISOString().slice(0, 10) // 北京时间日期
      : "";
    const parsed: MaterialParsed = {
      title: note.title,
      author: note.author,
      date,
      type: note.type === "video" ? "视频" : "图文",
      like: note.like,
      fav: note.fav,
      summary,
      points,
    };
    writeFileSync(path.join(workDir, "素材.json"), JSON.stringify(parsed, null, 2), "utf8");
    await finishWithArtifact(taskId, workDir, url, "xhs", t0);
  } catch (e: any) {
    const msg = /下载失败/.test(String(e?.message))
      ? "笔记下载失败（可能被平台限制），请稍后重试或换一条链接"
      : String(e?.message ?? e);
    taskLog("material", taskId, `失败：${msg}`, t0);
    updateTask(taskId, { status: "failed", error: msg, updatedAt: Date.now() });
  }
}

/* ============ 抖音通道（原 Agent 流程，暂未改造） ============ */

async function runParseMaterialAgent(
  taskId: string,
  url: string,
  apiKey: string,
  projectRoot: string,
  _envPath: string,
  account: string
): Promise<void> {
  const t0 = Date.now();
  taskLog("material", taskId, `提交：dy ${url}（Agent 通道）`);
  const workDir = path.join(projectRoot, "data", "accounts", account, "materials", taskId);
  mkdirSync(workDir, { recursive: true });

  const prompt = [
    `请完整执行以下任务：解析一篇抖音笔记并生成素材摘要。`,
    "",
    "重要（执行方式，先读）：",
    `- 不要调用 Skill 工具加载任何 skill。只用 Bash 无凭证 curl（-L 跟随跳转，可换浏览器 UA、用链接自带参数）抓取 ${url} 的页面数据，从页面内嵌 JSON 里提取信息。`,
    "- 下载纪律：绝不允许登录任何账号，也不允许使用/驱动任何浏览器（playwright/headless 一律禁止）。",
    "- 抓取策略（按顺序尝试，最多 4 次）：① 桌面 UA 直接抓链接；② iPhone Safari UA 抓同一路径；③ 移动端 UA 重试与桌面不同的端点；④ 分享短链形式重新请求。每次换 UA/端点/头组合。全部被拦截才如实报告失败并停止。",
    "- 绝不允许编造数据。",
    `- 摘要长度 80 字左右即可，写完即止，不要精确数字数。`,
    "",
    `产物（完成的唯一标准）：${path.join(workDir, "素材.json")} 真实存在，严格 JSON：`,
    `{"title":"笔记标题","author":"作者昵称","date":"YYYY-MM-DD","type":"图文|视频","like":"点赞数(取不到填 0)","fav":"收藏数(取不到填 0)","summary":"基于正文内容的中文摘要，80 字左右，客观概述这篇讲了什么","points":["值得学习的点1","点2","点3"]}`,
    "（points 是从内容里提炼的 3 条可学习的写作/选题技巧，每条 ≤20 字；全部来自真实内容，不编造。）",
    "",
    "抓取到正文后摘要与学习点由你直接分析完成，不需要调用外部模型。",
  ].join("\n");

  // skillName 传一个不存在的名字：runSkill 会拼「请使用 X skill」前缀，配合正文里「不要调用 Skill 工具」的指令，agent 只按正文执行解析任务
  const r = await runSkill("material-parser", prompt, workDir, { apiKey, projectRoot }, (p) => {
    const cur = getTask(taskId);
    const logs = cur?.logs ? [...cur.logs] : [];
    if (p.step) updateTask(taskId, { step: p.step.slice(0, 120), logs: [...logs, p.step].slice(-40), updatedAt: Date.now() });
    else if (p.detail) updateTask(taskId, { logs: [...logs, String(p.detail).slice(0, 200)].slice(-40), updatedAt: Date.now() });
  });
  void r;

  await finishWithArtifact(taskId, workDir, url, "dy", t0);
}

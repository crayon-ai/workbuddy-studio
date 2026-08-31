import type { FastifyPluginCallback } from "fastify";
import { exec } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

/** 任务级日志：带时间戳 + 距任务开始的相对秒数，写 server 控制台。 */
function log(taskId: string, msg: string, t0?: number): void {
  const hhmmss = new Date().toTimeString().slice(0, 8);
  const rel = t0 ? `+${((Date.now() - t0) / 1000).toFixed(1)}s` : "";
  console.log(`[${hhmmss}]${rel ? ` (${rel})` : ""} [deep-review:${taskId}] ${msg}`);
}

/** 复盘产物目录：项目内 data/deep-reviews/<taskId>/ */
function deepReviewDir(projectRoot: string, taskId: string): string {
  return path.join(projectRoot, "data", "deep-reviews", taskId);
}

interface NoteEntry {
  role: "mine" | "benchmark";
  url: string;
  meta: NoteMeta;
  downloaded: boolean;
  downloadError?: string;
}

interface SignalEntry {
  role: string;
  title: string;
  /** 藏/赞，百分比整数 */
  favLikeRatio?: number;
  /** 评/赞，百分比整数 */
  commentLikeRatio?: number;
}

/** "1.2万" → 12000；非数字 → 0。 */
function toNum(v?: string): number {
  if (v == null) return 0;
  const s = String(v).trim();
  const m = s.match(/^([\d.]+)\s*万$/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** 文件名安全化：去 Windows 非法字符，截 50 字。 */
function sanitize(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "").slice(0, 50) || "untitled";
}

/** 目录下任一文件（含一层子目录里的文件）→ 非空 map；目录不存在/为空 → 空 map。 */
function collectNoteFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    // 每条目独立 try/catch：broken symlink / 权限错误不吞掉整目录扫描结果
    try {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (readdirSync(p).length > 0) out[name] = "dir";
      } else if (st.isFile()) {
        out[name] = "file";
      }
    } catch {
      // 单条目异常：跳过该条目，继续扫描
    }
  }
  return out;
}

/** Unicode 归一化（NFKC 全角→半角等）+ 去空白，用于目录名漂移容错匹配。 */
function normDirName(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "");
}

/**
 * 定位某篇笔记的实际下载目录：agent 建目录时偶发改写标题里的全角/半角标点
 * （实测：全角 ！ 被写成半角 !），按精确路径找不到时，对 notes/ 下同级目录做
 * 「角色前缀 + 归一化标题」前缀匹配兜底。找不到返回原精确路径（由调用方判空）。
 */
function resolveNoteDir(workDir: string, label: string): string {
  const exact = path.join(workDir, "notes", label);
  if (Object.keys(collectNoteFiles(exact)).length > 0) return exact;
  const notesRoot = path.join(workDir, "notes");
  let names: string[] = [];
  try {
    names = readdirSync(notesRoot);
  } catch {
    return exact;
  }
  const want = normDirName(label);
  const hit = names.find((n) => {
    if (n === label) return false;
    const nn = normDirName(n);
    return nn === want || (nn.startsWith(normDirName(label.split("-")[0] + "-")) && nn.endsWith(want.slice(want.indexOf("-") + 1)));
  });
  return hit ? path.join(notesRoot, hit) : exact;
}

/** 同 teardown.ts 的编造检测。 */
function fabricated(artifacts: Record<string, string>): boolean {
  const flags = [
    /数据来源\*{0,2}\s*[：:]\s*\*{0,2}模拟数据/,
    /无法直接抓取原内容/,
    /这是一个示例内容/,
  ];
  return Object.values(artifacts).some((text) => flags.some((re) => re.test(text)));
}

/** 同 personalized.ts 的进度回调：step 进 logs（最近 30 条），detail 透传。 */
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

/** 跨平台打开文件夹。 */
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
    const url = (noteUrl ?? "").trim();
    const list = Array.isArray(benchmarkUrls) ? benchmarkUrls : [];
    const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u);
    if (!isHttp(url)) {
      return { success: false, data: null, error: "noteUrl 无效" };
    }
    if (list.length < 1 || list.length > 5 || !list.every(isHttp)) {
      return { success: false, data: null, error: "benchmarkUrls 需为 1-5 条合法链接" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }
    const taskId = createTask();
    log(taskId, `提交：mine=${url} benchmarks=${list.length}`);
    runDeepReview(taskId, url, list, apiKey, opts.projectRoot).catch((e) => {
      log(taskId, `编排异常：${String(e?.message ?? e)}`);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() });
    });
    return { success: true, data: { taskId } };
  });

  app.get("/api/deep-review/:id/folder", async (req) => {
    const id = (req.params as { id: string }).id;
    const dir = deepReviewDir(opts.projectRoot, id);
    if (!existsSync(dir)) {
      return { success: false, data: null, error: "目录不存在（任务可能未完成或已被清理）" };
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

/** 三段编排：① 并行抓元数据+算信号 → ② 串行逐篇下载原文 → ③ deep-review skill 出报告。 */
async function runDeepReview(
  taskId: string,
  noteUrl: string,
  benchmarkUrls: string[],
  apiKey: string,
  projectRoot: string
): Promise<void> {
  const t0 = Date.now();
  updateTask(taskId, {
    status: "running",
    step: "正在抓取笔记元数据…",
    logs: [],
    updatedAt: t0,
  });
  const workDir = deepReviewDir(projectRoot, taskId);

  // ① 元数据
  const targets = [
    { role: "mine" as const, url: noteUrl },
    ...benchmarkUrls.map((url) => ({ role: "benchmark" as const, url })),
  ];
  const settled = await Promise.allSettled(targets.map((t) => fetchNoteMeta(t.url)));
  const entries: NoteEntry[] = [];
  const dropped: { url: string; reason: string }[] = [];
  settled.forEach((r, i) => {
    const t = targets[i];
    if (r.status === "fulfilled" && r.value.title) {
      entries.push({ role: t.role, url: t.url, meta: r.value, downloaded: false });
    } else {
      dropped.push({
        url: t.url,
        reason: r.status === "rejected" ? String(r.reason?.message ?? r.reason) : "未提取到标题",
      });
    }
  });
  const mine = entries.find((e) => e.role === "mine");
  if (!mine) {
    log(taskId, `自己笔记元数据抓取失败：${dropped[0]?.reason ?? "?"}`, t0);
    updateTask(taskId, {
      status: "failed",
      error: "自己笔记元数据抓取失败：" + (dropped[0]?.reason ?? "未知原因"),
      updatedAt: Date.now(),
    });
    return;
  }
  if (!entries.some((e) => e.role === "benchmark")) {
    log(taskId, "对标笔记元数据全部抓取失败", t0);
    updateTask(taskId, {
      status: "failed",
      error: "对标笔记元数据全部抓取失败，请检查链接后重试",
      updatedAt: Date.now(),
    });
    return;
  }

  const signal = buildSignal(entries);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    path.join(workDir, "meta.json"),
    JSON.stringify(
      {
        taskId,
        createdAt: new Date().toISOString(),
        mine: { title: mine.meta.title, url: mine.url },
        notes: entries,
        signal,
        dropped,
      },
      null,
      2
    )
  );
  log(taskId, `元数据 ${entries.length} 篇成功 / ${dropped.length} 篇丢弃`, t0);
  updateTask(taskId, {
    step: `元数据就绪（${entries.length} 篇），开始下载正文…`,
    updatedAt: Date.now(),
  });

  // ② 逐篇下载
  const onProgress = makeProgress(taskId);
  const total = entries.length;
  for (let i = 0; i < total; i++) {
    const e = entries[i];
    const label = `${e.role}-${sanitize(e.meta.title ?? "untitled")}`;
    const noteDir = path.join(workDir, "notes", label);
    updateTask(taskId, {
      step: `下载正文（${i + 1}/${total}）：${e.meta.title ?? e.url}`,
      updatedAt: Date.now(),
    });
    try {
      const r = await runSkill(
        "baokuan-chaijie",
        buildDownloadPrompt(e, noteDir),
        workDir,
        { apiKey, projectRoot },
        onProgress
      );
      const actualDir = resolveNoteDir(workDir, label);
      const files = collectNoteFiles(actualDir);
      if (Object.keys(files).length > 0) {
        entries[i] = { ...e, downloaded: true };
        log(taskId, `下载成功：${label}（${Object.keys(files).length} 项）`, t0);
      } else {
        entries[i] = {
          ...e,
          downloadError: r.ok ? "下载目录为空" : (r.error ?? "下载失败"),
        };
        log(taskId, `下载失败：${label}（${entries[i].downloadError}）`, t0);
      }
    } catch (e2: any) {
      entries[i] = { ...e, downloadError: String(e2?.message ?? e2) };
      log(taskId, `下载异常：${label}（${entries[i].downloadError}）`, t0);
    }
  }

  // 下载结果回写 meta.json（下载前写的那份 downloaded 恒为 false）
  writeFileSync(
    path.join(workDir, "meta.json"),
    JSON.stringify(
      {
        taskId,
        createdAt: new Date().toISOString(),
        mine: { title: mine.meta.title, url: mine.url },
        notes: entries,
        signal: buildSignal(entries),
        dropped,
      },
      null,
      2
    )
  );

  // ③ 分析
  await analyzeAndFinish(taskId, entries, apiKey, projectRoot, workDir, onProgress, t0);
}

/** 确定性数据信号：藏/赞、评/赞（整数百分比），likes 为 0/缺时 undefined。 */
function buildSignal(entries: NoteEntry[]): SignalEntry[] {
  const mine = entries.find((e) => e.role === "mine");
  const mineDate = mine?.meta.date ? Date.parse(mine.meta.date) : NaN;
  const mineTags = new Set((mine?.meta.tags ?? []).map((t) => t.toLowerCase()));
  return entries.map((e) => {
    const likes = toNum(e.meta.likes);
    const favs = toNum(e.meta.favs);
    const comments = toNum(e.meta.comments);
    const daysDelta =
      mineDate && e.meta.date && Number.isFinite(mineDate)
        ? Math.round((Date.parse(e.meta.date) - mineDate) / 86400000)
        : undefined;
    const tagOverlap = (e.meta.tags ?? []).filter((t) => mineTags.has(t.toLowerCase())).length;
    return {
      role: e.role,
      title: e.meta.title ?? "",
      favLikeRatio: likes > 0 ? Math.round((favs / likes) * 100) : undefined,
      commentLikeRatio: likes > 0 ? Math.round((comments / likes) * 100) : undefined,
      daysDelta,
      tagOverlap,
    };
  });
}

/** ③ 分析 + 判定 done/failed（含磁盘恢复与编造检测）。 */
async function analyzeAndFinish(
  taskId: string,
  entries: NoteEntry[],
  apiKey: string,
  projectRoot: string,
  workDir: string,
  onProgress: (p: { step?: string; detail?: string }) => void,
  t0: number
): Promise<void> {
  const mine = entries.find((e) => e.role === "mine");
  const mineTitle = mine?.meta.title ?? "我的笔记";
  updateTask(taskId, { step: "正文就绪，正在深度分析…", updatedAt: Date.now() });
  const t1 = Date.now();
  const ar = await runSkill(
    "deep-review",
    buildAnalyzePrompt(entries, workDir),
    workDir,
    { apiKey, projectRoot },
    onProgress
  );
  log(taskId, `分析 skill 结束，耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s，ok=${ar.ok}`, t0);

  let result = ar.ok ? parseDeepReview(ar.artifacts) : null;
  if (!result || !ar.ok) {
    // agent 偶发完成工作后 CLI 崩溃——先看磁盘有没有已落盘的报告
    const recovered = parseDeepReview(collectMarkdown(workDir));
    if (recovered) {
      log(taskId, `报告从磁盘恢复（skill ${ar.ok ? "产物为空" : `失败：${ar.error}`}}）`, t0);
      result = recovered;
    } else if (!ar.ok) {
      updateTask(taskId, { status: "failed", error: ar.error, updatedAt: Date.now() });
      return;
    }
  }
  if (!result) {
    updateTask(taskId, {
      status: "failed",
      error: "分析未产出报告，请重试",
      updatedAt: Date.now(),
    });
    return;
  }
  // 编造检测只针对报告产物——artifacts 可能含 notes/ 下的真实正文（天然含「无法直接抓取」等字样），扫了会误杀
  const allArts = ar.ok ? ar.artifacts : collectMarkdown(workDir);
  const reportOnly = Object.fromEntries(
    Object.entries(allArts).filter(([k]) => k.startsWith("AI深度复盘"))
  );
  if (fabricated(reportOnly)) {
    updateTask(taskId, {
      status: "failed",
      error: "内容未能真实抓取（产物为编造示例），请重试",
      updatedAt: Date.now(),
    });
    return;
  }
  log(taskId, `完成，报告 ${result.reportFile}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, t0);
  updateTask(taskId, {
    status: "done",
    result,
    step: `完成：AI深度复盘-${mineTitle}`,
    updatedAt: Date.now(),
  });
}

/** ② 下载 prompt：只用 baokuan-chaijie 能力一，只下载不拆解，跳过评论区；视频必须转逐字稿。 */
function buildDownloadPrompt(e: NoteEntry, noteDir: string): string {
  return [
    "请使用 baokuan-chaijie skill 的「能力一（下载原文）」完成以下任务。",
    "",
    "重要（执行方式，先读）：",
    "- 只用能力一：只下载原文，不做任何拆解、不产出 AI拆解 文档。",
    "- 不要调用 Skill 工具来加载本 skill——你没有该工具权限，调用会被拒绝。",
    "- 明确跳过评论区：后续分析不需要评论数据，不要下载评论。",
    "- 视频类笔记必须转逐字稿（后续内容分析的核心素材）：下载视频后，",
    "  用 ffmpeg 提取 16kHz 单声道 WAV，再调本地 Whisper 服务转写，",
    "  把逐字稿写入同目录的 逐字稿.md（格式参考 .claude/skills/baokuan-chaijie/references/video-transcribe.md，",
    "  保留 [mm:ss] 时间戳，繁体转简体）。Whisper 服务地址 http://127.0.0.1:2022/v1/audio/transcriptions；",
    "  若服务不可用，如实注明「Whisper 不可用」并跳过转写，不要编造逐字稿。",
    "- 目录名必须逐字符沿用下方「下载目标目录」，不要改写标题里的全角/半角标点。",
    "- 绝不允许编造/模拟/示例数据；无法抓取时如实说明失败并停止。",
    "",
    `笔记链接：${e.url}`,
    `下载目标目录：${noteDir}`,
    "",
    `- 完成的唯一标准：${noteDir} 目录下出现正文文件（正文 + 图片/视频，视频笔记含 逐字稿.md）。在回复里描述「已下载」不算完成。`,
  ].join("\n");
}

/** ③ 分析 prompt：先读 SKILL.md 按模板，素材位置 + 笔记清单 + 硬约束。 */
function buildAnalyzePrompt(entries: NoteEntry[], workDir: string): string {
  const mine = entries.find((e) => e.role === "mine");
  const sig = buildSignal(entries);
  const sigByTitle = new Map(sig.map((s) => [s.title, s]));
  const rows = entries
    .map((e) => {
      const s = sigByTitle.get(e.meta.title ?? "");
      return [
        `### ${e.role === "mine" ? "我的笔记" : "对标笔记"}：${e.meta.title ?? "无标题"}`,
        `- 链接：${e.url}`,
        `- 数据：赞 ${e.meta.likes ?? "?"} / 藏 ${e.meta.favs ?? "?"} / 评 ${e.meta.comments ?? "?"}${e.meta.fans ? ` / 作者粉丝 ${e.meta.fans}` : ""}`,
        `- 发布日期：${e.meta.date ?? "未知"}${s?.daysDelta != null ? `（相对我的笔记 ${s.daysDelta} 天）` : ""}`,
        `- 与我的笔记共同标签数：${s?.tagOverlap ?? 0}`,
        `- 藏赞比：${s?.favLikeRatio != null ? `${s.favLikeRatio}%` : "未知"}，评赞比：${s?.commentLikeRatio != null ? `${s.commentLikeRatio}%` : "未知"}`,
        `- 正文状态：${e.downloaded ? `已下载到 notes/${e.role}-${sanitize(e.meta.title ?? "untitled")}/` : `未下载（${e.downloadError ?? "原因未知"}），请只用上方元数据分析并如实注明`}`,
      ].join("\n");
    })
    .join("\n\n");
  const mineTitle = mine?.meta.title ?? "我的笔记";
  return [
    "请使用 deep-review skill 完成以下任务。",
    "",
    "重要（执行方式，先读）：",
    "- 第一步必须先用 Read 工具读取 .claude/skills/deep-review/SKILL.md 全文，严格按其模板执行，不得自创结构。",
    "- 不要调用 Skill 工具来加载本 skill——你没有该工具权限，调用会被拒绝。",
    "- 素材已就绪，不要再下载任何内容。",
    "",
    `素材位置（绝对路径）：${workDir}`,
    `- 各篇素材：${workDir}/notes/<角色>-<标题>/ 目录及其子目录（可能在 爆款原文/<标题>/ 层级下），先用 Bash 列目录确认实际路径再 Read`,
    "- 每篇素材目录里可能有的文件，全部要读：正文.md（文案）、逐字稿.md（视频口播转写——视频笔记的核心内容）、图片（用 Read 逐张读，vision 提取图内文字）",
    "- 视频笔记的内容主体在逐字稿/视频口播里，正文.md 往往只是一句引导语——必须优先读逐字稿.md 做内容分析；没有逐字稿.md 的视频笔记如实注明「口播内容未获取」",
    `- 笔记清单与数据信号：${workDir}/meta.json`,
    "",
    "笔记清单：",
    "",
    rows,
    "",
    "硬约束：",
    "- 绝不编造：所有结论必须来自磁盘上的真实素材与上方元数据；没有的数据如实标注未知。",
    `- 完成的唯一标准：${workDir}/AI深度复盘-${mineTitle}.md 文件真实存在。在回复里输出分析内容不算完成。`,
  ].join("\n");
}

import type { FastifyPluginCallback } from "fastify";
import path from "node:path";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill, collectMarkdown } from "../skill-runner.js";
import { parseInspiration, parseProfile, type Profile } from "../parse.js";
import { fetchBloggerProfile, isXhsProfileUrl, type BloggerProfile } from "../xhs-profile.js";
import { fetchSources, type SourceItem } from "../sources.js";
import { getApiKey } from "../config.js";

/** 任务级日志：带时间戳 + 距任务开始的相对秒数，写 server 控制台（随启动脚本进 logs/server.log）。 */
function log(taskId: string, msg: string, t0?: number): void {
  const hhmmss = new Date().toTimeString().slice(0, 8);
  const rel = t0 ? `+${((Date.now() - t0) / 1000).toFixed(1)}s` : "";
  console.log(`[${hhmmss}]${rel ? ` (${rel})` : ""} [personalized:${taskId}] ${msg}`);
}

export interface PersonalizedRoutesOpts {
  envPath: string;
  projectRoot: string;
}

/** 个性化灵感产物目录：项目内 data/personalized/<taskId>/ */
function personalizedDir(projectRoot: string, taskId: string): string {
  return path.join(projectRoot, "data", "personalized", taskId);
}

export const personalizedRoutes: FastifyPluginCallback<PersonalizedRoutesOpts> = (
  app,
  opts,
  done
) => {
  app.post("/api/inspiration/personalized", async (req) => {
    const { profileUrl } = (req.body ?? {}) as { profileUrl?: string };
    const url = (profileUrl ?? "").trim();
    if (!url || !isXhsProfileUrl(url)) {
      return { success: false, data: null, error: "暂只支持小红书主页链接" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }
    const taskId = createTask();
    log(taskId, `提交：profileUrl=${url}`);
    runPersonalized(taskId, url, apiKey, opts.projectRoot).catch((e) => {
      log(taskId, `编排异常：${String(e?.message ?? e)}`);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() });
    });
    return { success: true, data: { taskId } };
  });

  done();
};

/**
 * 三段编排：① Node 抓主页首屏笔记 → ② blogger-profile skill 产画像
 * → ③ inspiration-radar skill 按画像关键词抓灵感。全程一个 taskId。
 */
async function runPersonalized(
  taskId: string,
  profileUrl: string,
  apiKey: string,
  projectRoot: string
): Promise<void> {
  const t0 = Date.now();
  updateTask(taskId, {
    status: "running",
    step: "正在抓取你的主页笔记…",
    logs: [],
    updatedAt: t0,
  });

  // ① 抓主页（确定性工作，纯 Node 不花 token）
  let profile: BloggerProfile;
  try {
    profile = await fetchBloggerProfile(profileUrl);
  } catch (e: any) {
    log(taskId, `主页抓取失败：${e?.message ?? String(e)}`, t0);
    updateTask(taskId, {
      status: "failed",
      error: e?.message ?? String(e),
      updatedAt: Date.now(),
    });
    return;
  }
  log(taskId, `主页抓取成功：${profile.nickname ?? "?"} ${profile.notes.length} 条笔记`, t0);
  updateTask(taskId, {
    step: `已抓到 ${profile.notes.length} 条近期笔记，正在分析…`,
    updatedAt: Date.now(),
  });

  const workDir = personalizedDir(projectRoot, taskId);
  const onProgress = makeProgress(taskId);

  // ② 画像分析
  const t1 = Date.now();
  const profileRun = await runSkill(
    "blogger-profile",
    buildProfilePrompt(profile, workDir),
    workDir,
    { apiKey, projectRoot },
    onProgress
  );
  log(taskId, `画像 skill 结束，耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s，ok=${profileRun.ok}`, t0);
  if (!profileRun.ok) {
    // agent 偶发完成工作后 CLI 崩溃（exit 1）——先看磁盘上有没有已落盘的画像
    const recovered = parseProfile(collectMarkdown(workDir));
    if (!recovered) {
      log(taskId, `画像 skill 失败（${profileRun.error}）且磁盘无可用产物`, t0);
      updateTask(taskId, { status: "failed", error: profileRun.error, updatedAt: Date.now() });
      return;
    }
    log(taskId, `画像 skill 失败（${profileRun.error}）但磁盘恢复成功，继续`, t0);
    finishWith(radarAndParse(taskId, recovered, apiKey, projectRoot, workDir, onProgress, t0));
    return;
  }
  // 先解析落盘产物；agent 偶发只输出不落盘时，从最终回复文本兜底提取
  const parsed: Profile | null =
    parseProfile(profileRun.artifacts) ?? parseProfile({ "profile.md": profileRun.text });
  if (!parsed) {
    log(taskId, "画像解析为空（产物与文本均无有效字段）", t0);
    updateTask(taskId, {
      status: "failed",
      error: "画像分析失败，请重试",
      updatedAt: Date.now(),
    });
    return;
  }
  log(taskId, `画像解析成功：track=${parsed.track ?? "?"} keywords=${parsed.keywords.length} 个`, t0);

  finishWith(radarAndParse(taskId, parsed, apiKey, projectRoot, workDir, onProgress, t0));
}

/** ③ 画像关键词驱动灵感抓取 + 解析落盘。失败时尝试从磁盘恢复已落盘产物。 */
async function radarAndParse(
  taskId: string,
  parsed: Profile,
  apiKey: string,
  projectRoot: string,
  workDir: string,
  onProgress: (p: { step?: string; detail?: string }) => void,
  t0: number
): Promise<void> {
  // 后端直连并行抓取原始素材（不经过 agent）
  const kw = parsed.keywords.join(" ");
  let items: SourceItem[] = [];
  try {
    items = await fetchSources(kw);
  } catch (e: any) {
    log(taskId, `抓取失败：${e?.message ?? String(e)}`, t0);
  }
  log(taskId, `抓取完成，${items.length} 条原始素材`, t0);

  const t1 = Date.now();
  const radarRun = await runSkill(
    "inspiration-radar",
    buildRadarPrompt(parsed, workDir, items),
    workDir,
    { apiKey, projectRoot },
    onProgress
  );
  log(taskId, `灵感 skill 结束，耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s，ok=${radarRun.ok}`, t0);
  let insp = radarRun.ok ? parseInspiration(radarRun.artifacts) : [];
  if (!radarRun.ok || insp.length === 0) {
    // CLI 崩溃 / 产物收集为空时，agent 往往已完成工作并落盘——从磁盘恢复
    const fromDisk = parseInspiration(collectMarkdown(workDir));
    if (fromDisk.length > 0) {
      log(
        taskId,
        `灵感恢复：radar ${radarRun.ok ? "产物为空" : `失败（${radarRun.error}）`}，从磁盘恢复 ${fromDisk.length} 条`,
        t0
      );
      insp = fromDisk;
    } else if (!radarRun.ok) {
      log(taskId, `灵感 skill 失败（${radarRun.error}）且磁盘无产物`, t0);
      updateTask(taskId, { status: "failed", error: radarRun.error, updatedAt: Date.now() });
      return;
    }
  }
  log(taskId, `完成，抓到 ${insp.length} 条，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, t0);
  updateTask(taskId, {
    status: "done",
    result: insp,
    step: `完成，抓到 ${insp.length} 条个性化灵感`,
    updatedAt: Date.now(),
  });
}

/** 异步收尾：统一把异常转成 task failed，不向调用方抛出。 */
function finishWith(p: Promise<void>): void {
  p.catch((e) => {
    // radarAndParse 内部已处理业务失败；这里兜底意外异常（updateTask 本身出错等）
    console.error("[personalized] 收尾异常：", e);
  });
}

/** 同 inspiration.ts 的进度回调：step 进 logs（最近 30 条），detail 透传。 */
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

/** 画像分析 prompt：笔记清单按日期倒序的 markdown 表格 + 时间加权规则。 */
function buildProfilePrompt(p: BloggerProfile, workDir: string): string {
  const rows = p.notes
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .map((n) => `| ${n.date || "未知"} | ${n.likes ?? "?"} | ${n.title} |`)
    .join("\n");
  return [
    "请使用 blogger-profile skill 完成以下任务。",
    "",
    "重要（执行方式，先读）：",
    "- 不要调用 Skill 工具来加载本 skill——你没有该工具权限，调用会被拒绝。",
    "- skill 指令已在你的上下文里，直接开始分析。",
    `- 完成的唯一标准：用 Write 工具创建 ${workDir}/profile.md。在回复里输出分析内容不算完成。`,
    "",
    `博主：${p.nickname ?? "未知昵称"}`,
    `简介：${p.desc ?? "无"}`,
    "",
    "近期笔记清单（按日期倒序）：",
    "",
    "| 发布日期 | 点赞 | 标题 |",
    "| --- | --- | --- |",
    rows,
    "",
    `输出目录：${workDir}`,
    "",
    "严格按 blogger-profile/SKILL.md 执行：纯分析、不联网、不 curl。",
    "时间加权：近 30 天权重最高，31-90 天次之，更早只作背景参考。",
    `- 写入 ${workDir}/profile.md，严格用 SKILL.md 规定的英文 key 字段格式（- track: / - pillars: / - topics: / - shift: / - keywords:）。`,
    `- 最终必须产出 ${workDir}/profile.md 文件。`,
  ].join("\n");
}

/** 灵感抓取 prompt：素材已由后端抓好，agent 只做「按画像筛选 + 格式化落盘」。 */
function buildRadarPrompt(profile: Profile, workDir: string, items: SourceItem[]): string {
  const raw = items
    .map(
      (i) =>
        `- [${i.pfn}] ${i.title}${i.author ? `（${i.author}）` : ""}${i.heat ? ` · 热度${i.heat}` : ""}${i.pub ? ` · ${i.pub}` : ""}\n  url: ${i.url}${i.summary ? `\n  摘要: ${i.summary}` : ""}`
    )
    .join("\n");
  return [
    "请使用 inspiration-radar skill 完成以下任务。",
    "",
    "重要（执行方式，先读）：原始素材已由调用方抓取好，见下方「原始素材」。",
    "不要再用 curl / Bash 抓取任何数据源，不要调用 Skill 工具。",
    "你的唯一工作：从原始素材里按博主画像筛选 top 10，补全推荐理由与候选选题，用 Write 落盘。",
    "",
    `关键词：${profile.keywords.join("、")}`,
    `输出目录：${workDir}`,
    "",
    "博主画像（筛选与打分时参考）：",
    `- 赛道：${profile.track ?? "未知"}`,
    `- 选题偏好：${profile.topics.join("、") || "未知"}`,
    "",
    "原始素材（共 " + items.length + " 条）：",
    raw || "（无，本次未抓到任何素材）",
    "",
    "筛选与打分要求：",
    "- 从原始素材挑最多 10 条最有创作价值的。",
    "- 「匹配度」指标按内容与上述博主画像的契合度打分（不是与关键词的字面相关度）。",
    "- why（推荐理由）至少 1 条结合博主选题偏好说明为什么值得他写。",
    "- 每条必须含 url（沿用原始素材里给的原链接）。",
    `- 写入 ${workDir}/inspirations.md（pf 只能是 bili/bing/weixin/hn/douyin）。`,
    `- 最终必须产出 ${workDir}/inspirations.md 文件（即使空也要创建）。`,
    "",
    "输出格式（必须逐字段遵循，字段名只用下面这些英文 key，不要中文）：",
    "",
    "```",
    "## 1",
    "- pf: bili",
    "- pfn: B站",
    "- author: 作者名",
    "- pub: 2 天前",
    "- t: 标题",
    "- s: 1-2 句摘要",
    "- url: https://真实链接",
    "- why: 理由1 | 理由2 | 理由3",
    "- m: 热度,82,coral | 匹配,90,matcha | 可写性,85,honey",
    "- cands: op,选题1 | method,选题2 | eval,选题3",
    "",
    "## 2",
    "- pf: bing",
    "…",
    "```",
    "",
    "硬约束：",
    "- 每条以 `## N`（纯数字）分隔，绝不用标题文本做分隔。",
    "- m 里的匹配度是 0-100 整数（如 90），不是 0-10 小数。",
  ].join("\n");
}

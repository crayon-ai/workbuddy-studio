import type { FastifyPluginCallback } from "fastify";
import path from "node:path";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill, collectMarkdown } from "../skill-runner.js";
import { parseInspiration } from "../parse.js";
import { fetchSources, type SourceItem } from "../sources.js";
import { getApiKey } from "../config.js";

export interface InspirationRoutesOpts {
  envPath: string;
  projectRoot: string;
}

/** 灵感抓取产物目录：项目内 data/inspirations/<taskId>/ */
function inspirationDir(projectRoot: string, taskId: string): string {
  return path.join(projectRoot, "data", "inspirations", taskId);
}

export const inspirationRoutes: FastifyPluginCallback<InspirationRoutesOpts> = (
  app,
  opts,
  done
) => {
  app.post("/api/inspiration/refresh", async (req) => {
    const { keywords } = (req.body ?? {}) as { keywords?: string };
    if (!keywords || !keywords.trim()) {
      return { success: false, data: null, error: "关键词无效" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }
    const taskId = createTask();
    runInspiration(taskId, keywords.trim(), apiKey, opts.projectRoot).catch((e) => {
      console.error(`[inspiration:${taskId}] 编排异常：`, e);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() });
    });
    return { success: true, data: { taskId } };
  });

  done();
};

/** 走 inspiration-radar skill（agent 用 curl 抓 5 源 + 整理成 inspirations.md）。 */
async function runInspiration(
  taskId: string,
  keywords: string,
  apiKey: string,
  projectRoot: string
): Promise<void> {
  const t0 = Date.now();
  const log = (msg: string) =>
    console.log(`[${new Date().toTimeString().slice(0, 8)}] (+${((Date.now() - t0) / 1000).toFixed(1)}s) [inspiration:${taskId}] ${msg}`);
  log(`提交关键词：${keywords}`);
  updateTask(taskId, {
    status: "running",
    step: "已提交，准备抓取灵感…",
    logs: [],
    updatedAt: t0,
  });

  const workDir = inspirationDir(projectRoot, taskId);
  log(`开始抓取 5 源（并行直连）…`);

  // 后端直连并行抓取（不经过 agent，几秒完成）
  let items: Awaited<ReturnType<typeof fetchSources>> = [];
  try {
    items = await fetchSources(keywords);
  } catch (e: any) {
    log(`抓取失败：${e?.message ?? String(e)}`);
  }
  log(`抓取完成，${items.length} 条原始素材`);

  const prompt = buildPrompt(keywords, workDir, items);

  const r = await runSkill("inspiration-radar", prompt, workDir, { apiKey, projectRoot }, (p) => {
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
  });
  log(`skill 结束，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，ok=${r.ok}`);

  if (!r.ok) {
    // agent 偶发完成工作后 CLI 崩溃（exit 1）——先从磁盘恢复已落盘的 inspirations.md
    const recovered = parseInspiration(collectMarkdown(workDir));
    if (recovered.length > 0) {
      log(`skill 失败（${r.error}）但磁盘恢复 ${recovered.length} 条`);
      updateTask(taskId, {
        status: "done",
        result: recovered,
        step: `完成，抓到 ${recovered.length} 条灵感`,
        updatedAt: Date.now(),
      });
      return;
    }
    updateTask(taskId, { status: "failed", error: r.error, updatedAt: Date.now() });
    return;
  }
  const insp = parseInspiration(r.artifacts);
  log(`完成，抓到 ${insp.length} 条`);
  updateTask(taskId, {
    status: "done",
    result: insp,
    step: `完成，抓到 ${insp.length} 条灵感`,
    updatedAt: Date.now(),
  });
}

function buildPrompt(keywords: string, workDir: string, items: SourceItem[]): string {
  const raw = items
    .map(
      (i) =>
        `- [${i.pfn}] ${i.title}${i.author ? `（${i.author}）` : ""}${i.heat ? ` · 热度${i.heat}` : ""}${i.pub ? ` · ${i.pub}` : ""}\n  url: ${i.url}${i.summary ? `\n  摘要: ${i.summary}` : ""}`
    )
    .join("\n");
  return [
    "请使用 inspiration-radar skill 完成以下任务。",
    "",
    `关键词：${keywords}`,
    `输出目录：${workDir}`,
    "",
    "重要（执行方式，先读）：原始素材已由调用方抓取好，见下方「原始素材」。",
    "不要再用 curl / Bash 去抓取任何数据源，不要调用 Skill 工具。",
    "你的唯一工作：从原始素材里筛选 top 10，补全推荐理由与候选选题，用 Write 落盘。",
    "",
    "原始素材（共 " + items.length + " 条）：",
    raw || "（无，本次未抓到任何素材）",
    "",
    "筛选要求：",
    "- 从原始素材挑最多 10 条最有创作价值的（与关键词相关度高、有讨论度、有延展性）。",
    "- 每条必须含 url（沿用原始素材里给的原链接）。",
    `- 写入 ${workDir}/inspirations.md（pf 只能是 bili/bing/weixin/hn/douyin）。`,
    `- 最终必须产出 ${workDir}/inspirations.md 文件（即使空也要创建）。`,
    "",
    "输出格式（必须逐字段遵循，字段名只用下面这些英文 key，不要中文、不要加粗）：",
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

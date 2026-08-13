import type { FastifyPluginCallback } from "fastify";
import path from "node:path";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill } from "../skill-runner.js";
import { parseInspiration } from "../parse.js";
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
    runInspiration(taskId, keywords.trim(), apiKey, opts.projectRoot).catch((e) =>
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() })
    );
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
  updateTask(taskId, {
    status: "running",
    step: "已提交，准备抓取灵感…",
    logs: [],
    updatedAt: Date.now(),
  });

  const workDir = inspirationDir(projectRoot, taskId);
  const prompt = buildPrompt(keywords, workDir);

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

  if (!r.ok) {
    updateTask(taskId, { status: "failed", error: r.error, updatedAt: Date.now() });
    return;
  }
  const insp = parseInspiration(r.artifacts);
  updateTask(taskId, {
    status: "done",
    result: insp,
    step: `完成，抓到 ${insp.length} 条灵感`,
    updatedAt: Date.now(),
  });
}

function buildPrompt(keywords: string, workDir: string): string {
  return [
    "请使用 inspiration-radar skill 完成以下任务。",
    "",
    `关键词：${keywords}`,
    `输出目录：${workDir}`,
    "",
    "严格按 inspiration-radar/SKILL.md 执行，用 curl 抓 5 个免登录态数据源：",
    "  B站搜索 / 必应全网 / 搜狗微信公众号 / HackerNews / 抖音热搜榜。",
    "直接用 SKILL.md 里给的 curl 命令（每个源各一段），不要探索其他工具，不要尝试需要登录的平台（推特/小红书/微博/知乎/豆瓣）。",
    "",
    "要求：",
    "- 每条必须含 url（原链接，可点击回原文）。",
    "- 5 个源无需全抓，任一组合抓到 ≥6 条优质就停止、进入筛选。",
    "- 任一源失败最多重试 1 次，仍失败就跳过；绝不反复重试拖垮任务。",
    `- 写入 ${workDir}/inspirations.md，严格用 SKILL.md 规定的字段格式（pf 只能是 bili/bing/weixin/hn/douyin）。`,
    `- 最终必须产出 ${workDir}/inspirations.md 文件（即使空也要创建）。`,
  ].join("\n");
}

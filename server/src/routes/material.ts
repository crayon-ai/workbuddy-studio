import type { FastifyPluginCallback } from "fastify";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill } from "../skill-runner.js";
import { getApiKey } from "../config.js";
import { taskLog } from "../log.js";
import { accountSlug } from "../account-dirs.js";

export interface MaterialRoutesOpts {
  envPath: string;
  projectRoot: string;
}

/** ============================================================
 *  素材库「添加素材链接」：粘贴小红书/抖音链接 → agent 无凭证下载解析
 *  → 产出 素材.json（标题/作者/日期/互动/AI 摘要/值得学习的点）→ 前端存素材卡片。
 *  产物目录：data/accounts/<account>/materials/<taskId>/
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
    runParseMaterial(taskId, url, plat, apiKey, opts.projectRoot, account).catch((e) => {
      console.error(`[material:${taskId}] 编排异常：`, e);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e), updatedAt: Date.now() });
    });
    return { success: true, data: { taskId }, error: null };
  });

  done();
};

async function runParseMaterial(
  taskId: string,
  url: string,
  plat: "xhs" | "dy",
  apiKey: string,
  projectRoot: string,
  account: string
): Promise<void> {
  const t0 = Date.now();
  taskLog("material", taskId, `提交：${plat} ${url}`);
  const workDir = path.join(projectRoot, "data", "accounts", account, "materials", taskId);
  mkdirSync(workDir, { recursive: true });
  const platName = plat === "xhs" ? "小红书" : "抖音";

  const prompt = [
    `请完整执行以下任务：解析一篇${platName}笔记并生成素材摘要。`,
    "",
    "重要（执行方式，先读）：",
    `- 不要调用 Skill 工具加载任何 skill。只用 Bash 无凭证 curl（-L 跟随跳转，可换浏览器 UA、用链接自带参数）抓取 ${url} 的页面数据，从页面内嵌 JSON 里提取信息。`,
    "- 下载纪律：绝不允许登录任何账号，也不允许使用/驱动任何浏览器（playwright/headless 一律禁止）。",
    "- 抓取策略（按顺序尝试，最多 4 次）：① 桌面 UA 直接抓链接；② iPhone Safari UA 抓同一路径；③ 小红书换 m.xiaohongshu.com/discovery/item/<笔记id> 移动端点（从链接里取笔记 id）；④ 分享短链形式重新请求。每次换 UA/端点/头组合。全部被拦截才如实报告失败并停止。",
    "- 绝不允许编造数据。",
    "",
    `产物（完成的唯一标准）：${path.join(workDir, "素材.json")} 真实存在，严格 JSON：`,
    `{"title":"笔记标题","author":"作者昵称","date":"YYYY-MM-DD","type":"图文|视频","like":"点赞数(取不到填 0)","fav":"收藏数(取不到填 0)","summary":"基于正文内容的中文摘要，60~80 字，客观概述这篇讲了什么","points":["值得学习的点1","点2","点3"]}`,
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

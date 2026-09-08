import type { FastifyPluginCallback } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill } from "../skill-runner.js";
import { getApiKey } from "../config.js";
import { taskLog } from "../log.js";
import { accountTaskDir, resolveTaskDir, accountSlug } from "../account-dirs.js";

export interface PrecheckRoutesOpts {
  envPath: string;
  projectRoot: string;
}

const MIN_CHARS = 30;
const MAX_CHARS = 30000;

/** 产物目录：data/accounts/<account>/prechecks/<taskId>/ */
function precheckDir(projectRoot: string, accountId: unknown, taskId: string): string {
  return accountTaskDir(projectRoot, accountId, "prechecks", taskId);
}

/** 从任务目录读结构化自检结果（agent 落盘的 自检结果.json）。 */
function readResultJson(dir: string): Record<string, unknown> | null {
  const p = path.join(dir, "自检结果.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const precheckRoutes: FastifyPluginCallback<PrecheckRoutesOpts> = (
  app,
  opts,
  done
) => {
  app.post("/api/precheck", async (req) => {
    const { content, title, reader, accountId } = (req.body ?? {}) as {
      content?: string;
      title?: string;
      reader?: string;
      accountId?: string;
    };
    const text = (content ?? "").trim();
    if (text.length < MIN_CHARS) {
      return { success: false, data: null, error: `内容太短（至少 ${MIN_CHARS} 字），无法有效评分` };
    }
    if (text.length > MAX_CHARS) {
      return { success: false, data: null, error: `内容过长（最多 ${MAX_CHARS} 字），请拆分后分篇自检` };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }
    const taskId = createTask();
    const account = accountSlug(accountId);
    updateTask(taskId, { accountId: account });
    runPrecheck(taskId, { content: text, title, reader }, apiKey, opts.projectRoot, account).catch(
      (e) => {
        console.error(`[precheck:${taskId}] 编排异常：`, e);
        updateTask(taskId, { status: "failed", error: String(e?.message ?? e) });
      }
    );
    return { success: true, data: { taskId } };
  });

  /** 重新读取某个已完成任务的报告（刷新页面后恢复用）。 */
  app.get("/api/precheck/:id/result", async (req) => {
    const id = (req.params as { id: string }).id;
    const { account } = (req.query as { account?: string }) ?? {};
    const dir = resolveTaskDir(opts.projectRoot, account, "prechecks", id);
    const json = existsSync(dir) ? readResultJson(dir) : null;
    if (!json) {
      return { success: false, data: null, error: "未找到自检结果（任务可能未完成或已被清理）" };
    }
    return { success: true, data: json };
  });

  done();
};

async function runPrecheck(
  taskId: string,
  input: { content: string; title?: string; reader?: string },
  apiKey: string,
  projectRoot: string,
  account: string
): Promise<void> {
  const t0 = Date.now();
  taskLog("precheck", taskId, `提交：${input.content.length} 字`);
  updateTask(taskId, {
    status: "running",
    step: "已提交，准备调用 skill…",
    logs: [],
    updatedAt: Date.now(),
  });
  const workDir = precheckDir(projectRoot, account, taskId);
  const prompt = [
    "请对用户提供的小红书笔记内容做发布前自检（多维打分）。",
    "",
    "重要（执行方式，先读）：",
    "- 不要调用 Skill 工具来加载本 skill——你没有该工具权限，调用会被拒绝。",
    "- 第一步必须先用 Read 工具读取 .claude/skills/xhs-precheck/SKILL.md 全文（含「结构化输出约定」），再用 Read 读取 .claude/skills/xhs-precheck/references/风险词参考.md，严格按其 rubric 执行：六维度、权重、分档锚点不得自创或更改。",
    "- 直接开始执行，不要复述 skill 会做什么。",
    "",
    "用户输入：",
    input.title ? `- 标题：${input.title}` : "- 标题：未提供（按无标题路径评分，标题维度记 N/A 并放大其余权重）",
    input.reader ? `- 目标读者/赛道：${input.reader}` : "- 目标读者/赛道：未提供（从内容推断并标注）",
    "- 笔记内容（唯一权威输入，逐字稿/正文原文如下）：",
    "<<<CONTENT",
    input.content,
    "CONTENT>>>",
    "",
    `落盘要求（必须，缺一不可）：`,
    `1. 完整 markdown 报告写到 ${workDir}/发布前自检报告.md`,
    `2. 结构化结果写到 ${workDir}/自检结果.json（字段与 SKILL.md「结构化输出约定」完全一致，JSON 必须可解析）`,
    `完成的唯一标准：${workDir}/自检结果.json 真实存在且可解析。在回复里描述「已完成评分」不算完成。`,
    "评分要求再强调：每个扣分点必须引用原文；平均 85 分以上默认是放水，对照分档锚点评分。",
  ].join("\n");

  const r = await runSkill("xhs-precheck", prompt, workDir, { apiKey, projectRoot }, (p) => {
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

  const finishWith = (json: Record<string, unknown>, note: string) => {
    taskLog("precheck", taskId, `${note}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, t0);
    updateTask(taskId, { status: "done", result: { data: json }, step: note, updatedAt: Date.now() });
  };

  if (!r.ok) {
    // agent 偶发完成工作后 CLI 崩溃（exit 1）——先从磁盘恢复已落盘的结果
    taskLog("precheck", taskId, `skill 失败（${r.error}），尝试从磁盘恢复产物`, t0);
    const json = readResultJson(workDir);
    if (json) {
      finishWith(json, "完成（从磁盘恢复）");
      return;
    }
    taskLog("precheck", taskId, `失败，无可用产物`, t0);
    updateTask(taskId, { status: "failed", error: r.error, updatedAt: Date.now() });
    return;
  }

  const json = readResultJson(workDir);
  if (!json) {
    taskLog("precheck", taskId, `失败，skill 结束但零产物（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`, t0);
    updateTask(taskId, {
      status: "failed",
      error: "自检未产出结果（skill 未按约定落盘 自检结果.json），请重试",
      updatedAt: Date.now(),
    });
    return;
  }
  finishWith(json, "完成");
}

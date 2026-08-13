import type { FastifyPluginCallback } from "fastify";
import { runSkill } from "../skill-runner.js";
import { parseTitles } from "../parse.js";
import { getApiKey } from "../config.js";
import { createTask, updateTask, getTask } from "../task-store.js";
import path from "node:path";
import os from "node:os";

export interface TitleRoutesOpts {
  envPath: string;
  projectRoot: string;
}

export const titleRoutes: FastifyPluginCallback<TitleRoutesOpts> = (app, opts, done) => {
  app.post("/api/title", async (req) => {
    const { topic } = (req.body ?? {}) as { topic?: string };
    if (!topic || typeof topic !== "string" || topic.length > 500) {
      return { success: false, data: null, error: "topic 无效" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }

    const taskId = createTask();
    runTitle(taskId, topic, apiKey, opts.projectRoot).catch((e) =>
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e) })
    );
    return { success: true, data: { taskId } };
  });

  done();
};

async function runTitle(
  taskId: string,
  topic: string,
  apiKey: string,
  projectRoot: string
): Promise<void> {
  updateTask(taskId, { status: "running", step: "已提交，准备调用 skill…", logs: [], updatedAt: Date.now() });
  const workDir = path.join(os.tmpdir(), "wb-title", taskId);
  const prompt = [
    "为以下主题生成 5 个小红书爆款标题（每个≤20字），匹配爆款标题心理触发机制，",
    "标注每个标题的心理机制和选择理由。",
    "最后用一个 JSON 数组输出，字段：t（标题）、mech（心理机制）、reason（选择理由）。",
    "",
    `主题：${topic}`,
  ].join("\n");

  const r = await runSkill("xhs-title-psych", prompt, workDir, { apiKey, projectRoot }, (p) => {
    const cur = getTask(taskId);
    const logs = cur?.logs ? [...cur.logs] : [];
    const patch: { updatedAt: number; logs: string[]; step?: string; detail?: string } = {
      updatedAt: Date.now(),
      logs,
    };
    if (p.step) { patch.step = p.step; patch.logs = [...logs, p.step].slice(-30); }
    if (p.detail) patch.detail = p.detail;
    updateTask(taskId, patch);
  });

  if (!r.ok) {
    updateTask(taskId, { status: "failed", error: r.error, updatedAt: Date.now() });
    return;
  }
  updateTask(taskId, {
    status: "done",
    result: { titles: parseTitles(r.text), raw: r.text },
    step: "完成",
    updatedAt: Date.now(),
  });
}

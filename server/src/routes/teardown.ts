import type { FastifyPluginCallback } from "fastify";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill, collectMarkdown } from "../skill-runner.js";
import { parseTeardown } from "../parse.js";
import { getApiKey } from "../config.js";
import path from "node:path";

export interface TeardownRoutesOpts {
  envPath: string;
  projectRoot: string;
}

/** 拆解产物持久化目录：项目内 data/teardowns/<taskId>/ */
function teardownDir(projectRoot: string, taskId: string): string {
  return path.join(projectRoot, "data", "teardowns", taskId);
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

export const teardownRoutes: FastifyPluginCallback<TeardownRoutesOpts> = (
  app,
  opts,
  done
) => {
  app.post("/api/teardown", async (req) => {
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url || !/^https?:\/\//.test(url)) {
      return { success: false, data: null, error: "url 无效" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }
    const taskId = createTask();
    runTeardown(taskId, url, apiKey, opts.projectRoot).catch((e) =>
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e) })
    );
    return { success: true, data: { taskId } };
  });

  app.get("/api/teardown/:id/folder", async (req) => {
    const id = (req.params as { id: string }).id;
    const dir = teardownDir(opts.projectRoot, id);
    if (!existsSync(dir)) {
      return {
        success: false,
        data: null,
        error: "目录不存在（任务可能未完成或已被清理）",
      };
    }
    try {
      openFolder(dir);
      return { success: true, data: { ok: true } };
    } catch (e: any) {
      return { success: false, data: null, error: e?.message ?? String(e) };
    }
  });

  app.post("/api/teardown/:id/reparse", async (req) => {
    const id = (req.params as { id: string }).id;
    const dir = teardownDir(opts.projectRoot, id);
    if (!existsSync(dir)) {
      return { success: false, data: null, error: "目录不存在" };
    }
    const artifacts = collectMarkdown(dir);
    return { success: true, data: { result: parseTeardown(artifacts) } };
  });

  done();
};

async function runTeardown(
  taskId: string,
  url: string,
  apiKey: string,
  projectRoot: string
): Promise<void> {
  updateTask(taskId, {
    status: "running",
    step: "已提交，准备调用 skill…",
    logs: [],
    updatedAt: Date.now(),
  });
  const workDir = teardownDir(projectRoot, taskId);
  const prompt = [
    "请完整执行以下两步（缺一不可，不要只做第一步就停）：",
    `1. 下载原文：用此 skill 的「能力一」把链接 ${url} 的原文下载到 ${workDir}/爆款原文/<标题>/（正文 + 图片 + 评论）。`,
    `2. 拆解爆款：用此 skill 的「能力二」对刚下载的笔记做完整 9 维度拆解，把拆解报告写到 ${workDir}/AI拆解/AI爆款拆解-<标题>.md。`,
    "",
    "要求：",
    "- 图片里的文字必须用 vision 提取（用 Read 工具逐张读取每张图片），不能只看正文文字。",
    "- 视频若需转逐字稿；ffmpeg/whisper 不可用就注明并跳过该步。",
    `- 最终必须产出 ${workDir}/AI拆解/AI爆款拆解-<标题>.md 文件，含 9 个维度的完整拆解。`,
  ].join("\n");

  const r = await runSkill("baokuan-chaijie", prompt, workDir, { apiKey, projectRoot }, (p) => {
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
  updateTask(taskId, {
    status: "done",
    result: parseTeardown(r.artifacts),
    step: "完成",
    updatedAt: Date.now(),
  });
}

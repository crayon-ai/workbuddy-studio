import type { FastifyPluginCallback } from "fastify";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { createTask, updateTask, getTask } from "../task-store.js";
import { runSkill, collectMarkdown } from "../skill-runner.js";
import { parseTeardown } from "../parse.js";
import { getApiKey } from "../config.js";
import { taskLog } from "../log.js";
import { accountTaskDir, resolveTaskDir, accountSlug } from "../account-dirs.js";

export interface TeardownRoutesOpts {
  envPath: string;
  projectRoot: string;
}

/** 拆解产物持久化目录：data/accounts/<account>/teardowns/<taskId>/（3.0 按账号隔离） */
function teardownDir(projectRoot: string, accountId: unknown, taskId: string): string {
  return accountTaskDir(projectRoot, accountId, "teardowns", taskId);
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
    const { url, accountId } = (req.body ?? {}) as { url?: string; accountId?: string };
    if (!url || !/^https?:\/\//.test(url)) {
      return { success: false, data: null, error: "url 无效" };
    }
    const apiKey = getApiKey(opts.envPath);
    if (!apiKey) {
      return { success: false, data: null, error: "未配置 API key" };
    }
    const taskId = createTask();
    const account = accountSlug(accountId);
    updateTask(taskId, { accountId: account });
    runTeardown(taskId, url, apiKey, opts.projectRoot, account).catch((e) => {
      console.error(`[teardown:${taskId}] 编排异常：`, e);
      updateTask(taskId, { status: "failed", error: String(e?.message ?? e) });
    });
    return { success: true, data: { taskId } };
  });

  app.get("/api/teardown/:id/folder", async (req) => {
    const id = (req.params as { id: string }).id;
    const { account } = (req.query as { account?: string }) ?? {};
    const dir = resolveTaskDir(opts.projectRoot, account, "teardowns", id);
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
    const { account } = (req.query as { account?: string }) ?? {};
    const dir = resolveTaskDir(opts.projectRoot, account, "teardowns", id);
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
  projectRoot: string,
  account: string
): Promise<void> {
  const t0 = Date.now();
  taskLog("teardown", taskId, `提交：url=${url}`);
  updateTask(taskId, {
    status: "running",
    step: "已提交，准备调用 skill…",
    logs: [],
    updatedAt: Date.now(),
  });
  const workDir = teardownDir(projectRoot, account, taskId);
  const prompt = [
    "请完整执行以下两步（缺一不可，不要只做第一步就停）：",
    "",
    "重要（执行方式，先读）：",
    "- 不要调用 Skill 工具来加载本 skill——你没有该工具权限，调用会被拒绝。",
    "- 第一步必须先用 Read 工具读取 .claude/skills/baokuan-chaijie/SKILL.md 全文，严格按其规定执行（尤其「九维度拆解模板」的固定章节与顺序），不得自创拆解结构。",
    "- 直接开始执行，不要复述或介绍 skill 会做什么。",
    `- 完成的唯一标准：${workDir}/AI拆解/AI爆款拆解-<标题>.md 文件真实存在。在回复里描述「已启动 skill」不算完成。`,
    "",
    `1. 下载原文：用此 skill 的「能力一」把链接 ${url} 的原文下载到 ${workDir}/爆款原文/<标题>/（正文 + 图片 + 评论），下载动作一律用 Bash 执行。`,
    `2. 拆解爆款：用此 skill 的「能力二」对刚下载的笔记做完整 9 维度拆解，把拆解报告写到 ${workDir}/AI拆解/AI爆款拆解-<标题>.md。`,
    "",
    "要求：",
    "- 图片里的文字必须用 vision 提取（用 Read 工具逐张读取每张图片），不能只看正文文字。",
    "- 视频若需转逐字稿；ffmpeg/whisper 不可用就注明并跳过该步。",
    "- 绝不允许编造/模拟/示例数据：若确实无法抓取真实内容（如平台限制），直接如实说明失败原因并停止，不得虚构标题、数据或用占位示例交差。",
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
    // agent 偶发完成工作后 CLI 崩溃（exit 1）——先从磁盘恢复已落盘的拆解产物
    taskLog("teardown", taskId, `skill 失败（${r.error}），尝试从磁盘恢复产物`, t0);
    const recovered = parseTeardown(collectMarkdown(workDir));
    if (!recovered.reportFile) {
      taskLog("teardown", taskId, `失败，无可用产物`, t0);
      updateTask(taskId, { status: "failed", error: r.error, updatedAt: Date.now() });
      return;
    }
    taskLog("teardown", taskId, `完成（磁盘恢复 ${recovered.reportFile}）`, t0);
    updateTask(taskId, {
      status: "done",
      result: recovered,
      step: "完成（从磁盘恢复）",
      updatedAt: Date.now(),
    });
    return;
  }
  const result = parseTeardown(r.artifacts);
  if (!result.reportFile) {
    // agent 偶发「介绍 skill 即宣布完成」零产物（实测抖音链接）：不伪装成 done
    taskLog("teardown", taskId, `失败，skill 结束但零产物（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`, t0);
    updateTask(taskId, {
      status: "failed",
      error: "拆解未产出报告（下载或拆解未实际执行），请重试",
      updatedAt: Date.now(),
    });
    return;
  }
  if (fabricatedArtifacts(r.artifacts)) {
    // agent 偶发编造「示例内容/模拟数据」交差（实测抖音 8c93dd73）：假成功比失败更糟
    taskLog("teardown", taskId, `失败，产物为编造示例`, t0);
    updateTask(taskId, {
      status: "failed",
      error: "内容未能真实抓取（agent 未获取到原文，产物为编造示例），请重试",
      updatedAt: Date.now(),
    });
    return;
  }
  taskLog("teardown", taskId, `完成，报告 ${result.reportFile}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, t0);
  updateTask(taskId, {
    status: "done",
    result,
    step: "完成",
    updatedAt: Date.now(),
  });
}

/**
 * 检测产物是否为编造的示例内容：agent 抓不到原文时会自述
 * 「数据来源：模拟数据」「无法直接抓取原内容」等标志（正常拆解不会写这种话）。
 */
function fabricatedArtifacts(artifacts: Record<string, string>): boolean {
  const flags = [
    /数据来源\*{0,2}\s*[：:]\s*\*{0,2}模拟数据/,
    /无法直接抓取原内容/,
    /这是一个示例内容/,
  ];
  return Object.values(artifacts).some((text) =>
    flags.some((re) => re.test(text))
  );
}

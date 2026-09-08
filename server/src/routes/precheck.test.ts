import { describe, it, expect, beforeEach, vi } from "vitest";

// mock runSkill：按用例需要把产物真实落盘到 workDir（与 teardown.test 同款模式）
vi.mock("../skill-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skill-runner.js")>();
  return { collectMarkdown: actual.collectMarkdown, runSkill: vi.fn() };
});

const { buildApp } = await import("../app.js");
const { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const envPath = "./.env.precheck.test";
const JSON_RESULT = {
  title: "测试笔记自检",
  reader: "推断读者：职场新手",
  type: "经验分享",
  words: 120,
  total: 65,
  grade: "C",
  gradeLabel: "C · 需要大改",
  gate: false,
  conclusion: "最大的问题是说明书腔。",
  dims: [
    { name: "标题", score: 55, weight: "20%", na: false, line: "模板词多", good: "主题清晰", bads: [{ q: "干货分享", f: "换成人话" }] },
    { name: "风险合规", score: 100, weight: "15%", na: false, line: "未检出风险词", ok: true, note: "已排查六类，均未命中" },
  ],
  risks: [],
  riskNote: null,
  riskSummary: { high: 0, mid: 0, low: 0, warn: null },
  opts: [{ name: "开场换钩子", dims: ["钩子"], now: "大家好", fix: "用痛点开场" }],
  rewrite: null,
  rewriteOmitted: true,
};

function seedWorkDir(projectRoot: string, taskId: string, withJson = true, withMd = true): string {
  const dir = join(projectRoot, "data", "accounts", "default", "prechecks", taskId);
  mkdirSync(dir, { recursive: true });
  if (withMd) writeFileSync(join(dir, "发布前自检报告.md"), "# 发布前自检报告-测试\n\n（报告正文）");
  if (withJson) writeFileSync(join(dir, "自检结果.json"), JSON.stringify(JSON_RESULT));
  return dir;
}

async function waitDone(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: "GET", url: `/api/task/${taskId}` });
    const body = JSON.parse(r.body);
    if (body.data?.status === "done" || body.data?.status === "failed") return body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("任务未在超时内完成");
}

describe("POST /api/precheck", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    rmSync(envPath, { force: true });
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("立即返回 taskId", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/precheck",
      payload: { content: "这是一篇足够长的测试内容，用来通过最小长度校验，字数必须超过三十个字才可以。" },
    });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.taskId).toBe("string");
    await app.close();
  });

  it("内容太短 / 过长返回失败", async () => {
    const app = await buildApp({ envPath });
    const short = await app.inject({ method: "POST", url: "/api/precheck", payload: { content: "太短" } });
    expect(JSON.parse(short.body).success).toBe(false);
    const long = await app.inject({
      method: "POST",
      url: "/api/precheck",
      payload: { content: "长".repeat(30001) },
    });
    expect(JSON.parse(long.body).success).toBe(false);
    await app.close();
  });

  it("未配置 key 返回失败", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/precheck",
      payload: { content: "这是一篇足够长的测试内容，用来通过最小长度校验，字数必须超过三十个字才可以。" },
    });
    expect(JSON.parse(r.body).error).toBe("未配置 API key");
    await app.close();
  });

  it("skill 完成并落盘 json 后，任务 done 且结果可取回", async () => {
    const { runSkill } = await import("../skill-runner.js");
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-precheck-test-"));
    vi.mocked(runSkill).mockImplementationOnce(async (_s, _p, workDir: string) => {
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "自检结果.json"), JSON.stringify(JSON_RESULT));
      writeFileSync(join(workDir, "发布前自检报告.md"), "# 报告");
      return { ok: true, text: "done", artifacts: {} };
    });
    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/precheck",
      payload: { content: "这是一篇足够长的测试内容，用来通过最小长度校验，字数必须超过三十个字才可以。", title: "测试标题", reader: "职场新手" },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    expect(body.data.result.data.total).toBe(65);
    expect(body.data.result.data.dims).toHaveLength(2);
    // 产物目录在账号空间
    expect(existsSync(join(projectRoot, "data", "accounts", "default", "prechecks", taskId, "自检结果.json"))).toBe(true);
    // GET result 也能取回
    const g = await app.inject({ method: "GET", url: `/api/precheck/${taskId}/result` });
    expect(JSON.parse(g.body).data.conclusion).toContain("说明书腔");
    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("CLI 崩溃但磁盘已有 json 时，从磁盘恢复", async () => {
    const { runSkill } = await import("../skill-runner.js");
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-precheck-test-"));
    vi.mocked(runSkill).mockImplementationOnce(async (_s, _p, workDir: string) => {
      // agent 已完成落盘，但 CLI 收尾 exit 1
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "自检结果.json"), JSON.stringify(JSON_RESULT));
      return { ok: false, text: "", artifacts: {}, error: "Claude Code process exited with code 1" };
    });
    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/precheck",
      payload: { content: "这是一篇足够长的测试内容，用来通过最小长度校验，字数必须超过三十个字才可以。" },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    expect(body.data.step).toContain("磁盘恢复");
    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("skill 成功但零产物时，任务转 failed", async () => {
    const { runSkill } = await import("../skill-runner.js");
    vi.mocked(runSkill).mockImplementationOnce(async () => ({
      ok: true,
      text: "我已经完成了评分",
      artifacts: {},
    }));
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/precheck",
      payload: { content: "这是一篇足够长的测试内容，用来通过最小长度校验，字数必须超过三十个字才可以。" },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toContain("自检结果.json");
    await app.close();
  });

  it("GET result：目录不存在时返回 success=false", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({ method: "GET", url: "/api/precheck/nonexistent/result" });
    expect(JSON.parse(r.body).success).toBe(false);
    await app.close();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../skill-runner.js", () => ({
  runSkill: vi.fn(async () => ({
    ok: true,
    text: '[{"t":"别再用AI写稿了","mech":"反常识","reason":"戳痛点"}]',
    artifacts: {},
  })),
}));

const { buildApp } = await import("../app.js");
const { runSkill } = await import("../skill-runner.js");
const { rmSync } = await import("node:fs");

const envPath = "./.env.title.test";

async function waitDone(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: "GET", url: `/api/task/${taskId}` });
    const body = JSON.parse(r.body);
    if (body.data?.status === "done" || body.data?.status === "failed") return body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("任务未在超时内完成");
}

describe("POST /api/title", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    rmSync(envPath, { force: true });
    process.env.ANTHROPIC_API_KEY = "sk-test";
    (runSkill as any).mockImplementation(async () => ({
      ok: true,
      text: '[{"t":"别再用AI写稿了","mech":"反常识","reason":"戳痛点"}]',
      artifacts: {},
    }));
  });

  it("立即返回 taskId", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({ method: "POST", url: "/api/title", payload: { topic: "素材库" } });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.taskId).toBe("string");
    await app.close();
  });

  it("无 topic 返回失败", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({ method: "POST", url: "/api/title", payload: {} });
    expect(JSON.parse(r.body).success).toBe(false);
    await app.close();
  });

  it("未配置 key 返回失败", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const app = await buildApp({ envPath });
    const r = await app.inject({ method: "POST", url: "/api/title", payload: { topic: "x" } });
    expect(JSON.parse(r.body).success).toBe(false);
    expect(JSON.parse(r.body).error).toBe("未配置 API key");
    await app.close();
  });

  it("轮询到 done，结果含解析后的标题", async () => {
    const app = await buildApp({ envPath });
    const post = await app.inject({ method: "POST", url: "/api/title", payload: { topic: "素材库" } });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    expect(body.data.result.titles[0].t).toBe("别再用AI写稿了");
    await app.close();
  });

  it("runSkill 失败时透传 error", async () => {
    (runSkill as any).mockResolvedValueOnce({ ok: false, text: "", artifacts: {}, error: "skill 挂了" });
    const app = await buildApp({ envPath });
    const post = await app.inject({ method: "POST", url: "/api/title", payload: { topic: "x" } });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toBe("skill 挂了");
    await app.close();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../skill-runner.js", () => ({
  runSkill: vi.fn(async () => ({
    ok: true,
    text: "done",
    artifacts: {
      "inspirations.md": [
        "## 1",
        "- pf: bili",
        "- pfn: B站",
        "- author: @效率工具控",
        "- pub: 2 天前",
        "- t: 测试标题",
        "- s: 测试摘要",
        "- url: https://www.bilibili.com/video/BVxxx",
        "- why: 理由1 | 理由2 | 理由3",
        "- m: 热度,82,coral | 新颖,75,lav | 匹配,80,matcha | 可写性,88,honey",
        "- cands: op,选题1 | method,选题2 | eval,选题3",
      ].join("\n"),
    },
  })),
}));

const { buildApp } = await import("../app.js");
const { rmSync } = await import("node:fs");

const envPath = "./.env.inspiration.test";

async function waitDone(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: "GET", url: `/api/task/${taskId}` });
    const body = JSON.parse(r.body);
    if (body.data?.status === "done" || body.data?.status === "failed") return body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("任务未在超时内完成");
}

describe("POST /api/inspiration/refresh", () => {
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
      url: "/api/inspiration/refresh",
      payload: { keywords: "AI 工作台" },
    });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.taskId).toBe("string");
    expect(body.data.taskId.length).toBeGreaterThan(0);
    await app.close();
  });

  it("关键词为空白返回失败", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/inspiration/refresh",
      payload: { keywords: "   " },
    });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("关键词无效");
    await app.close();
  });

  it("无 keywords 字段返回失败", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/inspiration/refresh",
      payload: {},
    });
    expect(JSON.parse(r.body).success).toBe(false);
    expect(JSON.parse(r.body).error).toBe("关键词无效");
    await app.close();
  });

  it("未配置 key 返回失败", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/inspiration/refresh",
      payload: { keywords: "AI" },
    });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("未配置 API key");
    await app.close();
  });
});

describe("GET /api/task/:id（灵感轮询）", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("提交后轮询到 done，result 含解析的灵感（含 url）", async () => {
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/inspiration/refresh",
      payload: { keywords: "AI 工作台" },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    expect(Array.isArray(body.data.result)).toBe(true);
    expect(body.data.result).toHaveLength(1);
    expect(body.data.result[0].t).toBe("测试标题");
    expect(body.data.result[0].pf).toBe("bili");
    expect(body.data.result[0].url).toBe("https://www.bilibili.com/video/BVxxx");
    expect(body.data.result[0].why).toHaveLength(3);
    expect(body.data.result[0].cands).toHaveLength(3);
    await app.close();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../skill-runner.js", () => ({
  runSkill: vi.fn(async () => ({
    ok: true,
    text: "done",
    artifacts: {
      "笔记信息.md": [
        "# 测试笔记",
        "## 作者",
        "- 昵称：测试作者",
        "## 笔记元数据",
        "- 发布时间戳：1784876760000（2026-08）",
        "## 话题标签",
        "- #测试[话题]#",
        "## 互动数据",
        "- 点赞：100",
        "- 收藏：50",
        "- 评论：10",
      ].join("\n"),
      "AI爆款拆解-测试笔记.md": "# 测试笔记\n\n## 标题为什么吸引人\n这是拆解内容A",
    },
  })),
}));

const { buildApp } = await import("../app.js");
const { rmSync } = await import("node:fs");

const envPath = "./.env.teardown.test";

async function waitDone(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: "GET", url: `/api/task/${taskId}` });
    const body = JSON.parse(r.body);
    if (body.data?.status === "done" || body.data?.status === "failed") return body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("任务未在超时内完成");
}

describe("POST /api/teardown", () => {
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
      url: "/api/teardown",
      payload: { url: "https://www.xiaohongshu.com/explore/abc" },
    });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.taskId).toBe("string");
    expect(body.data.taskId.length).toBeGreaterThan(0);
    await app.close();
  });

  it("无效 url 返回失败", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/teardown",
      payload: { url: "not-a-url" },
    });
    expect(JSON.parse(r.body).success).toBe(false);
    await app.close();
  });

  it("未配置 key 返回失败", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/teardown",
      payload: { url: "https://x.com/a" },
    });
    expect(JSON.parse(r.body).success).toBe(false);
    expect(JSON.parse(r.body).error).toBe("未配置 API key");
    await app.close();
  });
});

describe("GET /api/task/:id（异步轮询）", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("提交后轮询到 done，结果含元数据 + 章节", async () => {
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/teardown",
      payload: { url: "https://www.xiaohongshu.com/explore/xyz" },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    expect(body.data.result.meta.title).toBe("测试笔记");
    expect(body.data.result.meta.likes).toBe("100");
    expect(body.data.result.meta.tags).toEqual(["测试"]);
    expect(body.data.result.sections["标题为什么吸引人"]).toContain("拆解内容A");
    await app.close();
  });

  it("未知 id 返回 success=false", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({ method: "GET", url: "/api/task/nonexistent" });
    expect(JSON.parse(r.body).success).toBe(false);
    await app.close();
  });
});

describe("GET /api/teardown/:id/folder", () => {
  it("目录不存在时返回 success=false", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "GET",
      url: "/api/teardown/nonexistent-id/folder",
    });
    expect(JSON.parse(r.body).success).toBe(false);
    await app.close();
  });
});

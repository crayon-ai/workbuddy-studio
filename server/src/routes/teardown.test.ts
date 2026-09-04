import { describe, it, expect, beforeEach, vi } from "vitest";

// mock runSkill：正常返回拆解产物；collectMarkdown 用真实实现（磁盘恢复依赖它）
vi.mock("../skill-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skill-runner.js")>();
  return {
    collectMarkdown: actual.collectMarkdown,
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
  };
});

const { buildApp } = await import("../app.js");
const { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

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

  // 实测故障形态（抖音链接 2026-08-23）：agent 调 Skill 工具被拒后「介绍 skill」
  // 就宣布完成，实际零产物。空产物不得伪装成 done。
  it("runSkill 成功但无拆解报告产物时，任务转 failed 而非空壳 done", async () => {
    const { runSkill } = await import("../skill-runner.js");
    vi.mocked(runSkill).mockImplementationOnce(async () => ({
      ok: true,
      text: "我已经启动了 baokuan-chaijie skill，它会自动完成下载和拆解",
      artifacts: {},
    }));
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/teardown",
      payload: { url: "https://www.douyin.com/jingxuan?modal_id=7676411206093783737" },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toContain("未产出报告");
    await app.close();
  });

  // 实测故障形态（8c93dd73）：抖音内容没抓到，agent 编造「示例内容/模拟数据」
  // 交差伪装成功。检测到自述性标志必须转 failed。
  it("产物含「模拟数据/无法直接抓取」自述时，任务转 failed 而非假成功", async () => {
    const { runSkill } = await import("../skill-runner.js");
    vi.mocked(runSkill).mockImplementationOnce(async () => ({
      ok: true,
      text: "done",
      artifacts: {
        "AI爆款拆解-抖音爆款内容示例.md":
          "# 抖音爆款内容示例\n\n## 基本信息\n- **数据来源**：模拟数据（受平台限制无法直接抓取）\n\n## 1. 内容结构分析\n...",
      },
    }));
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/teardown",
      payload: { url: "https://www.douyin.com/jingxuan?modal_id=7676411206093783737" },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toContain("未能真实抓取");
    await app.close();
  });

  it("prompt 钉死执行路径：禁调 Skill 工具 + 完成唯一标准是落盘报告", async () => {
    const { runSkill } = await import("../skill-runner.js");
    vi.mocked(runSkill).mockClear();
    const app = await buildApp({ envPath });
    await app.inject({
      method: "POST",
      url: "/api/teardown",
      payload: { url: "https://www.xiaohongshu.com/explore/abc" },
    });
    const taskId = JSON.parse(
      (await app.inject({ method: "POST", url: "/api/teardown", payload: { url: "https://www.xiaohongshu.com/explore/abc" } })).body
    ).data.taskId;
    await waitDone(app, taskId);
    const prompt = vi.mocked(runSkill).mock.calls[0]?.[1] ?? "";
    expect(prompt).toContain("不要调用 Skill 工具");
    expect(prompt).toContain("完成的唯一标准");
    await app.close();
  });

  // 实测故障形态：agent 完成拆解并落盘，但 CLI 收尾 exit 1 → runSkill ok=false。
  // 磁盘上合格的拆解报告不应被丢弃。
  it("CLI 崩溃但磁盘已有拆解产物时，从磁盘恢复结果", async () => {
    const { runSkill } = await import("../skill-runner.js");
    vi.mocked(runSkill).mockImplementationOnce(async () => {
      await new Promise((res) => setTimeout(res, 80));
      return { ok: false, text: "", artifacts: {}, error: "Claude Code process exited with code 1" };
    });
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-teardown-test-"));
    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/teardown",
      payload: { url: "https://www.xiaohongshu.com/explore/xyz" },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    // agent 已把产物写到 workDir
    const workDir = join(projectRoot, "data", "accounts", "default", "teardowns", taskId, "AI拆解");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, "AI爆款拆解-测试笔记.md"),
      "# 测试笔记\n\n## 标题为什么吸引人\n这是磁盘恢复的拆解内容"
    );
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    expect(body.data.result.sections["标题为什么吸引人"]).toContain("磁盘恢复的拆解内容");
    rmSync(projectRoot, { recursive: true, force: true });
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

// ===== 3.0 多账号：产物目录按账号隔离 =====
describe("多账号目录隔离", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("带 accountId 提交，产物落在 data/accounts/<account>/teardowns/<taskId>/，reparse 按账号解析", async () => {
    const { runSkill } = await import("../skill-runner.js");
    const artifacts = {
      "笔记信息.md": [
        "# 账号测试笔记",
        "## 作者",
        "- 昵称：账号作者",
        "## 笔记元数据",
        "- 发布时间戳：1784876760000（2026-08）",
        "## 话题标签",
        "- #账号[话题]#",
        "## 互动数据",
        "- 点赞：100",
      ].join("\n"),
      "AI爆款拆解-账号测试笔记.md": "# 账号测试笔记\n\n## 标题为什么吸引人\n账号隔离内容",
    };
    // mock 同时把产物真实落盘到 workDir，模拟 agent 写文件
    vi.mocked(runSkill).mockImplementationOnce(async (_s, _p, workDir: string) => {
      mkdirSync(workDir, { recursive: true });
      for (const [name, text] of Object.entries(artifacts)) {
        writeFileSync(join(workDir, name), text);
      }
      return { ok: true, text: "done", artifacts };
    });

    const projectRoot = mkdtempSync(join(tmpdir(), "wb-acc-"));
    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/teardown",
      payload: { url: "https://www.xiaohongshu.com/explore/acc1", accountId: "acc1" },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");

    // 产物目录落在账号空间而非 2.0 旧路径
    expect(existsSync(join(projectRoot, "data", "accounts", "acc1", "teardowns", taskId))).toBe(true);
    expect(existsSync(join(projectRoot, "data", "teardowns", taskId))).toBe(false);

    // 同账号 reparse 能解析到
    const rp = await app.inject({
      method: "POST",
      url: `/api/teardown/${taskId}/reparse?account=acc1`,
    });
    const rpBody = JSON.parse(rp.body);
    expect(rpBody.success).toBe(true);
    expect(rpBody.data.result.meta.title).toBe("账号测试笔记");

    // 换别的账号查 → 目录不存在（数据不串号）
    const rp2 = await app.inject({
      method: "POST",
      url: `/api/teardown/${taskId}/reparse?account=other`,
    });
    expect(JSON.parse(rp2.body).success).toBe(false);

    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("不带 accountId 落到 default 账号目录，2.0 旧目录记录仍可解析（回退兼容）", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-legacy-"));
    const app = await buildApp({ envPath, projectRoot });

    // 造一条 2.0 时代的旧产物（data/teardowns/<id>/）
    const legacyId = "old-legacy-task";
    const legacyDir = join(projectRoot, "data", "teardowns", legacyId);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "笔记信息.md"),
      ["# 旧记录", "## 作者", "- 昵称：旧作者", "## 笔记元数据", "- 发布时间戳：1784876760000（2026-08）", "## 互动数据", "- 点赞：1"].join("\n")
    );

    const rp = await app.inject({
      method: "POST",
      url: `/api/teardown/${legacyId}/reparse?account=default`,
    });
    const rpBody = JSON.parse(rp.body);
    expect(rpBody.success).toBe(true);
    expect(rpBody.data.result.meta.title).toBe("旧记录");

    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });
});

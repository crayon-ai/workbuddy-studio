import { describe, it, expect, beforeEach, vi } from "vitest";

// 后端直连抓取在本测试里返回固定素材（不真实联网）
vi.mock("../sources.js", () => ({
  fetchSources: vi.fn(async () => [
    {
      pf: "bili",
      pfn: "B站",
      title: "测试素材标题",
      author: "UP主",
      url: "https://www.bilibili.com/video/BV1",
      summary: "素材摘要",
      heat: "12345",
      pub: "2 天前",
    },
  ]),
}));

// mock 主页抓取模块（不依赖真实网络）
vi.mock("../xhs-profile.js", () => ({
  fetchBloggerProfile: vi.fn(async () => ({
    nickname: "测试博主",
    desc: "简介",
    notes: Array.from({ length: 20 }, (_, i) => ({
      title: `笔记${i}`,
      date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
      likes: String(10 + i),
    })),
  })),
  isXhsProfileUrl: vi.fn(
    (u: string) =>
      /^https?:\/\/(www\.)?xiaohongshu\.com\/user\/profile\//.test(u.trim())
  ),
}));

// mock runSkill：按调用的 skill 名返回不同产物；collectMarkdown 用真实实现（磁盘恢复依赖它）
vi.mock("../skill-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skill-runner.js")>();
  return {
    collectMarkdown: actual.collectMarkdown,
    runSkill: vi.fn(async (skillName: string, _prompt: string, _workDir: string) => {
    if (skillName === "blogger-profile") {
      return {
        ok: true,
        text: "done",
        artifacts: {
          "profile.md": [
            "- track: 测试赛道",
            "- pillars: a | b",
            "- topics: t1 | t2",
            "- shift: 无明显转向",
            "- keywords: 关键词1 | 关键词2 | 关键词3",
          ].join("\n"),
        },
      };
    }
    return {
      ok: true,
      text: "done",
      artifacts: {
        "inspirations.md": [
          "## 1",
          "- pf: bili",
          "- pfn: B站",
          "- author: @up",
          "- pub: 1 天前",
          "- t: 个性化测试标题",
          "- s: 摘要",
          "- url: https://www.bilibili.com/video/BV1",
          "- why: r1 | r2 | r3",
          "- m: 热度,80,coral | 匹配,92,matcha | 可写性,85,honey",
          "- cands: op,选题1 | method,选题2 | eval,选题3",
        ].join("\n"),
      },
    };
    }),
  };
});

const { buildApp } = await import("../app.js");

const envPath = "./.env.personalized.test";

async function waitDone(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: "GET", url: `/api/task/${taskId}` });
    const body = JSON.parse(r.body);
    if (body.data?.status === "done" || body.data?.status === "failed") return body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("任务未在超时内完成");
}

const VALID_URL = "https://www.xiaohongshu.com/user/profile/5ff0e6410000000001008400";

describe("POST /api/inspiration/personalized", () => {
  beforeEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    vi.mocked((await import("../xhs-profile.js")).fetchBloggerProfile).mockClear();
    vi.mocked((await import("../skill-runner.js")).runSkill).mockClear();
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("非小红书主页 URL 返回失败", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/inspiration/personalized",
      payload: { profileUrl: "https://www.bilibili.com/space/1" },
    });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("暂只支持小红书主页链接");
    await app.close();
  });

  it("未配置 key 返回失败", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/inspiration/personalized",
      payload: { profileUrl: VALID_URL },
    });
    expect(JSON.parse(r.body).error).toBe("未配置 API key");
    await app.close();
  });

  it("三段编排成功：抓主页→画像→灵感，result 含解析灵感", async () => {
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/inspiration/personalized",
      payload: { profileUrl: VALID_URL },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    expect(body.data.result[0].t).toBe("个性化测试标题");
    // 两个 skill 各被调一次
    const { runSkill } = await import("../skill-runner.js");
    const calls = vi.mocked(runSkill).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["blogger-profile", "inspiration-radar"]);
    // inspiration-radar 的 prompt 内联了输出格式契约（英文 key、0-100 匹配度），防中文字段名漂移
    const radarPrompt = vi.mocked(runSkill).mock.calls[1][1];
    expect(radarPrompt).toContain("- pf: bili");
    expect(radarPrompt).toContain("0-100");
    // 两个 prompt 都必须钉死执行路径：禁调 Skill 工具（会被权限拒绝）+ 必须 Write 落盘
    const profilePrompt = vi.mocked(runSkill).mock.calls[0][1];
    expect(profilePrompt).toContain("不要调用 Skill 工具");
    expect(profilePrompt).toContain("Write 工具");
    expect(radarPrompt).toContain("不要调用 Skill 工具");
    // 优化①：素材由后端直连抓取，agent 只筛选+格式化，prompt 不得再让 agent curl
    expect(radarPrompt).toContain("原始素材已由调用方抓取好");
    expect(radarPrompt).toContain("不要再用 curl");
    await app.close();
  });

  it("兜底：画像产物缺失时从 agent 回复文本里解析画像（防 agent 只输出不落盘）", async () => {
    const { runSkill } = await import("../skill-runner.js");
    vi.mocked(runSkill).mockImplementationOnce(async () => ({
      ok: true,
      // 实测故障形态：agent 未 Write 落盘，画像字段只出现在最终回复文本里
      text: [
        "## 分析完成",
        "",
        "- track: 文本兜底赛道",
        "- pillars: p1 | p2",
        "- topics: t1",
        "- shift: 稳定",
        "- keywords: kw1 | kw2 | kw3",
      ].join("\n"),
      artifacts: {},
    }));
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/inspiration/personalized",
      payload: { profileUrl: VALID_URL },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    // 画像兜底成功后仍应继续第三段（inspiration-radar 被调用）
    const calls = vi.mocked(runSkill).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["blogger-profile", "inspiration-radar"]);
    await app.close();
  });

  it("产物与文本都无有效画像时仍 failed（兜底失败路径）", async () => {
    const { runSkill } = await import("../skill-runner.js");
    vi.mocked(runSkill).mockImplementationOnce(async () => ({
      ok: true,
      text: "分析完成，但没有可解析的字段",
      artifacts: {},
    }));
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/inspiration/personalized",
      payload: { profileUrl: VALID_URL },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toBe("画像分析失败，请重试");
    await app.close();
  });

  // 实测故障形态（2026-08-23 915c6f82）：agent 完成抓取并落盘 inspirations.md，
  // 但 CLI 进程收尾时 exit 1 → runSkill ok=false。磁盘上合格的产物不应被丢弃。
  it("radar 阶段 CLI 崩溃但磁盘已有合格 inspirations.md 时，从磁盘恢复结果", async () => {
    const { runSkill } = await import("../skill-runner.js");
    // fetch 加真实延迟：POST 返回后给本测试时间预写磁盘文件，避免 mock 微任务跑赢写文件
    const { fetchBloggerProfile } = await import("../xhs-profile.js");
    vi.mocked(fetchBloggerProfile).mockImplementationOnce(async () => {
      await new Promise((res) => setTimeout(res, 80));
      return {
        nickname: "测试博主",
        desc: "简介",
        notes: Array.from({ length: 5 }, (_, i) => ({ title: `笔记${i}` })),
      };
    });
    // 第一次调用（blogger-profile）正常；第二次（inspiration-radar）模拟 CLI 崩溃
    vi.mocked(runSkill).mockImplementation(async (skillName: string) => {
      if (skillName === "blogger-profile") {
        return {
          ok: true,
          text: "done",
          artifacts: {
            "profile.md": "- track: t\n- keywords: k1 | k2 | k3",
          },
        };
      }
      return { ok: false, text: "", artifacts: {}, error: "Claude Code process exited with code 1" };
    });
    // workDir 指向临时目录，预置「agent 已落盘」的 inspirations.md
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-pers-test-"));
    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/inspiration/personalized",
      payload: { profileUrl: VALID_URL },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    // 画像阶段完成后、radar 崩溃前，agent 已把产物写到 workDir —— 这里在轮询到
    // radar 阶段后补写（简化：任务提交后立即写，因为 workDir 路径可预知）
    const workDir = join(projectRoot, "data", "accounts", "default", "personalized", taskId);
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, "inspirations.md"),
      [
        "## 1",
        "- pf: bili",
        "- pfn: B站",
        "- author: @up",
        "- pub: 1 天前",
        "- t: 磁盘恢复的灵感",
        "- s: 摘要",
        "- url: https://www.bilibili.com/video/BV1",
        "- why: r1 | r2 | r3",
        "- m: 匹配,90,matcha",
        "- cands: op,选题1",
      ].join("\n")
    );
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    expect(body.data.result[0].t).toBe("磁盘恢复的灵感");
    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("主页抓取抛错转 task failed 且不再调 skill", async () => {
    const { fetchBloggerProfile } = await import("../xhs-profile.js");
    vi.mocked(fetchBloggerProfile).mockRejectedValueOnce(
      new Error("主页抓取失败：未拿到足够笔记")
    );
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/inspiration/personalized",
      payload: { profileUrl: VALID_URL },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toContain("主页抓取失败");
    const { runSkill } = await import("../skill-runner.js");
    expect(vi.mocked(runSkill)).not.toHaveBeenCalled();
    await app.close();
  });

  it("画像 keywords 为空转 task failed", async () => {
    const { runSkill } = await import("../skill-runner.js");
    vi.mocked(runSkill).mockImplementationOnce(async () => ({
      ok: true,
      text: "done",
      artifacts: { "profile.md": "- track: 只有赛道没有关键词" },
    }));
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/inspiration/personalized",
      payload: { profileUrl: VALID_URL },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toBe("画像分析失败，请重试");
    await app.close();
  });
});

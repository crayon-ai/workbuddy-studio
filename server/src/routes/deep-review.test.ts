import { describe, it, expect, beforeEach, vi } from "vitest";

// mock runSkill：按 prompt 分流（下载 / 分析），collectMarkdown 用真实实现
vi.mock("../skill-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skill-runner.js")>();
  return {
    collectMarkdown: actual.collectMarkdown,
    runSkill: vi.fn(async (_skill: string, prompt: string, workDir: string) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const g = globalThis as any;
      if (prompt.includes("下载原文")) {
        if (g.__dr_failBench && prompt.includes("bench-fail")) {
          return { ok: false, error: "下载失败模拟", artifacts: {} };
        }
        // 目录名漂移模拟：agent 把标题里的全角 ！ 写成半角 !（真实故障复现）
        if (g.__dr_punctDrift) {
          const dir = join(workDir, "notes", "mine-我的笔记!");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "正文.md"), "# 我的笔记\n\n正文内容");
          return { ok: true, text: "downloaded", artifacts: {} };
        }
        const dir = join(workDir, "notes", "mine-我的笔记");
        mkdirSync(dir, { recursive: true });
        const body = g.__dr_fakeFlagWord
          ? "# 我的笔记\n\n（无法直接抓取原内容的部分已跳过）这是真实正文的其余内容。"
          : "# 我的笔记\n\n正文内容";
        writeFileSync(join(dir, "正文.md"), body);
        return { ok: true, text: "downloaded", artifacts: {} };
      }
      const md = [
        "# AI深度复盘-我的笔记",
        "",
        "## 数据对比总览",
        "| 笔记 | 赞 |",
        "| --- | --- |",
        "| 我的 | 200 |",
        "| 对标A | 20000 |",
        "",
        "## 差距归因",
        "标题钩子差距",
        "",
        "## 可执行建议",
        "1. 建议",
        "",
        "## 可复用经验候选",
        "- 经验",
      ].join("\n");
      writeFileSync(join(workDir, "AI深度复盘-我的笔记.md"), md);
      // 仿真实 runSkill：artifacts 是整个 workDir 的 md（含 notes/ 正文）
      return { ok: true, text: "done", artifacts: actual.collectMarkdown(workDir) };
    }),
  };
});

// mock global.fetch：元数据阶段返回 SSR HTML
const mkState = (title: string, likes: string) => ({
  note: {
    noteDetailMap: {
      x: {
        note: {
          title,
          noteId: "x",
          user: { nickname: "作者", fans: "1000" },
          interactInfo: { likedCount: likes, collectedCount: "50", commentCount: "10" },
          time: 1784876760000,
          tagList: [{ name: "收纳" }],
        },
      },
    },
  },
});
vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({
    text: async () =>
      `<html><script>window.__INITIAL_STATE__=${JSON.stringify(mkState("t", "1"))}</script></html>`,
  } as any))
);

const { buildApp } = await import("../app.js");
const { rmSync, readFileSync } = await import("node:fs");
const envPath = "./.env.deepreview.test";

async function waitDone(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: "GET", url: `/api/task/${taskId}` });
    const body = JSON.parse(r.body);
    if (body.data?.status === "done" || body.data?.status === "failed") return body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("任务未在超时内完成");
}

describe("POST /api/deep-review", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    rmSync(envPath, { force: true });
    rmSync("tmp-deepreview-root", { recursive: true, force: true });
    rmSync("tmp-deepreview-root2", { recursive: true, force: true });
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete (globalThis as any).__dr_failBench;
    delete (globalThis as any).__dr_fakeFlagWord;
  });

  it("无效参数：noteUrl 空 / benchmarkUrls 空 / 超 5 条 / 非法 URL 均拒绝", async () => {
    const app = await buildApp({ envPath });
    const cases = [
      { benchmarkUrls: ["https://a.com/1"] },
      { noteUrl: "https://a.com/1", benchmarkUrls: [] },
      { noteUrl: "https://a.com/1", benchmarkUrls: ["bad"] },
      { noteUrl: "https://a.com/1", benchmarkUrls: Array.from({ length: 6 }, (_, i) => `https://a.com/${i}`) },
    ];
    for (const c of cases) {
      const r = await app.inject({ method: "POST", url: "/api/deep-review", payload: c });
      expect(JSON.parse(r.body).success).toBe(false);
    }
    await app.close();
  });

  it("未配置 API key 拒绝", async () => {
    const app = await buildApp({ envPath });
    delete process.env.ANTHROPIC_API_KEY;
    const r = await app.inject({
      method: "POST",
      url: "/api/deep-review",
      payload: { noteUrl: "https://a.com/1", benchmarkUrls: ["https://a.com/2"] },
    });
    expect(JSON.parse(r.body).success).toBe(false);
    expect(JSON.parse(r.body).error).toContain("API key");
    await app.close();
  });

  it("全链路：done + meta.json 落盘 + 报告解析", async () => {
    const app = await buildApp({ envPath, projectRoot: "tmp-deepreview-root" });
    const r = await app.inject({
      method: "POST",
      url: "/api/deep-review",
      payload: {
        noteUrl: "https://www.xiaohongshu.com/explore/mine",
        benchmarkUrls: ["https://www.xiaohongshu.com/explore/bench1"],
      },
    });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(true);
    const done = await waitDone(app, body.data.taskId);
    expect(done.data.status).toBe("done");
    expect(done.data.result.reportFile).toContain("AI深度复盘");
    const meta = JSON.parse(readFileSync(`tmp-deepreview-root/data/accounts/default/deep-reviews/${body.data.taskId}/meta.json`, "utf8"));
    expect(meta.notes.length).toBe(2);
    expect(meta.notes.find((n: any) => n.role === "mine").meta.title).toBe("t");
    expect(meta.signal).toBeDefined();
    rmSync("tmp-deepreview-root", { recursive: true, force: true });
    await app.close();
  });

  it("单篇下载失败隔离：任务仍 done，meta.json 回写 downloaded=false + downloadError，分析 prompt 标注未下载", async () => {
    const { runSkill } = await import("../skill-runner.js");
    (globalThis as any).__dr_failBench = true;
    const app = await buildApp({ envPath, projectRoot: "tmp-deepreview-root" });
    const r = await app.inject({
      method: "POST",
      url: "/api/deep-review",
      payload: {
        noteUrl: "https://www.xiaohongshu.com/explore/mine",
        benchmarkUrls: ["https://www.xiaohongshu.com/explore/bench-fail"],
      },
    });
    const body = JSON.parse(r.body);
    const done = await waitDone(app, body.data.taskId);
    expect(done.data.status).toBe("done");
    expect(done.data.result.reportFile).toContain("AI深度复盘");
    const meta = JSON.parse(
      readFileSync(`tmp-deepreview-root/data/accounts/default/deep-reviews/${body.data.taskId}/meta.json`, "utf8")
    );
    const bench = meta.notes.find((n: any) => n.url.includes("bench-fail"));
    expect(bench.downloaded).toBe(false);
    expect(bench.downloadError).toContain("下载失败");
    const calls = vi.mocked(runSkill).mock.calls;
    const analyzePrompt = [...calls].reverse().find((c: any[]) => c[0] === "deep-review")?.[1] ?? "";
    expect(analyzePrompt).toMatch(/未下载|仅基于数据|只用上方元数据/);
    rmSync("tmp-deepreview-root", { recursive: true, force: true });
    await app.close();
  });

  it("真实正文含编造标志词不误判：任务仍 done", async () => {
    (globalThis as any).__dr_fakeFlagWord = true;
    const app = await buildApp({ envPath, projectRoot: "tmp-deepreview-root" });
    const r = await app.inject({
      method: "POST",
      url: "/api/deep-review",
      payload: {
        noteUrl: "https://www.xiaohongshu.com/explore/mine",
        benchmarkUrls: ["https://www.xiaohongshu.com/explore/bench1"],
      },
    });
    const body = JSON.parse(r.body);
    const done = await waitDone(app, body.data.taskId);
    expect(done.data.status).toBe("done");
    rmSync("tmp-deepreview-root", { recursive: true, force: true });
    await app.close();
  });

  it("目录名全角/半角漂移兜底：agent 把 ！ 写成 !，仍判 downloaded=true", async () => {
    (globalThis as any).__dr_punctDrift = true;
    // 元数据标题带全角叹号，agent 建目录时写成半角（真实故障场景）
    (global.fetch as any).mockImplementation(async (url: any) => ({
      text: async () =>
        `<html><script>window.__INITIAL_STATE__=${JSON.stringify(
          mkState("我的笔记！", "1")
        )}</script></html>`,
    }));
    const app = await buildApp({ envPath, projectRoot: "tmp-deepreview-root" });
    const r = await app.inject({
      method: "POST",
      url: "/api/deep-review",
      payload: {
        noteUrl: "https://www.xiaohongshu.com/explore/mine",
        benchmarkUrls: ["https://www.xiaohongshu.com/explore/bench1"],
      },
    });
    const body = JSON.parse(r.body);
    const done = await waitDone(app, body.data.taskId);
    expect(done.data.status).toBe("done");
    const meta = JSON.parse(
      readFileSync(`tmp-deepreview-root/data/accounts/default/deep-reviews/${body.data.taskId}/meta.json`, "utf8")
    );
    const mine = meta.notes.find((n: any) => n.role === "mine");
    expect(mine.downloaded).toBe(true);
    expect(mine.downloadError).toBeUndefined();
    rmSync("tmp-deepreview-root", { recursive: true, force: true });
    await app.close();
  });

  it("元数据全失败 → task failed", async () => {
    const app = await buildApp({ envPath, projectRoot: "tmp-deepreview-root2" });
    (global.fetch as any).mockImplementation(async () => ({
      text: async () => "<html>no state</html>",
    }));
    const r = await app.inject({
      method: "POST",
      url: "/api/deep-review",
      payload: {
        noteUrl: "https://www.xiaohongshu.com/explore/m1",
        benchmarkUrls: ["https://www.xiaohongshu.com/explore/b1"],
      },
    });
    const body = JSON.parse(r.body);
    const done = await waitDone(app, body.data.taskId);
    expect(done.data.status).toBe("failed");
    rmSync("tmp-deepreview-root2", { recursive: true, force: true });
    await app.close();
  });
});

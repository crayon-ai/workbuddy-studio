import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* ({ prompt }: any) {
    yield { type: "result", subtype: "success", result: `echo:${prompt}` };
  }),
}));

const { runSkill } = await import("./skill-runner.js");
const { query } = await import("@anthropic-ai/claude-agent-sdk");

const tmpDir = "./tmp-skill-test";

describe("runSkill", () => {
  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    (query as any).mockImplementation(async function* ({ prompt }: any) {
      yield { type: "result", subtype: "success", result: `echo:${prompt}` };
    });
  });

  it("成功时返回 result 文本（含 skill 引导前缀）", async () => {
    const r = await runSkill("x", "hello", tmpDir, { apiKey: "sk", projectRoot: "." });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("echo:请使用 x skill 完成以下任务。\n\nhello");
  });

  it("设置 ANTHROPIC_AUTH_TOKEN 环境变量", async () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    await runSkill("x", "p", tmpDir, { apiKey: "sk-abc", projectRoot: "." });
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-abc");
  });

  it("读取 workDir 下 .md 作为 artifacts", async () => {
    mkdirSync(`${tmpDir}/AI拆解`, { recursive: true });
    writeFileSync(`${tmpDir}/AI拆解/AI爆款拆解-测试.md`, "# 拆解\n正文内容");
    const r = await runSkill("x", "p", tmpDir, { apiKey: "sk", projectRoot: "." });
    expect(r.artifacts["AI爆款拆解-测试.md"]).toContain("正文内容");
  });

  it("query 抛错时返回 ok=false + error", async () => {
    (query as any).mockImplementationOnce(async function* () {
      throw new Error("boom");
    });
    const r = await runSkill("x", "p", tmpDir, { apiKey: "sk", projectRoot: "." });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom");
    expect(r.artifacts).toEqual({});
  });

  it("onProgress 回调上报 assistant 文字与工具调用", async () => {
    (query as any).mockImplementationOnce(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "正在下载原文" }] } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl https://x.com" } }] } };
      yield { type: "result", subtype: "success", result: "done" };
    });
    const events: { step?: string; detail?: string }[] = [];
    await runSkill("x", "p", tmpDir, { apiKey: "sk", projectRoot: "." }, (p) => events.push(p));
    expect(events.some((e) => e.step === "正在下载原文")).toBe(true);
    expect(events.some((e) => e.detail && e.detail.includes("curl"))).toBe(true);
  });
});

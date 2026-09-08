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

  it("query 抛错时返回 ok=false + error（含堆栈与 stderr 等细节）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    (query as any).mockImplementationOnce(async function* () {
      throw Object.assign(new Error("boom"), { stderr: "CLI crashed", exitCode: 1 });
    });
    const r = await runSkill("x", "p", tmpDir, { apiKey: "sk", projectRoot: "." });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
    expect(r.error).toContain("stderr=CLI crashed");
    expect(r.error).toContain("exitCode=1");
    expect(r.artifacts).toEqual({});
    expect(spy.mock.calls.some((c) => String(c[0]).includes("调用异常"))).toBe(true);
    spy.mockRestore();
  });

  it("agent 非正常结束（subtype=error_max_turns）不再伪装成功", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    (query as any).mockImplementationOnce(async function* () {
      yield { type: "result", subtype: "error_max_turns", result: "达到轮次上限" };
    });
    const r = await runSkill("x", "p", tmpDir, { apiKey: "sk", projectRoot: "." });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("error_max_turns");
    expect(r.error).toContain("达到轮次上限");
    expect(spy.mock.calls.some((c) => String(c[0]).includes("异常结束"))).toBe(true);
    spy.mockRestore();
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

describe("authProblem（API 鉴权错误翻译）", () => {
  it("识别 DeepSeek/智谱 401 文案，给出可操作的提示", async () => {
    const { authProblem } = await import("./skill-runner.js");
    process.env.ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
    const msg = authProblem(
      'API Error: 401 {"error":{"message":"Authentication Fails, Your api key: ****c107 is invalid","type":"authentication_error"}} · Please run /login'
    );
    expect(msg).toContain("API key 无效或已过期");
    expect(msg).toContain("api.deepseek.com");
    expect(msg).toContain("AI 配置");
  });

  it("result 为 success 但内容是 401 时，runSkill 返回可读错误而非假成功", async () => {
    (query as any).mockImplementationOnce(async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: 'API Error: 401 ... Authentication Fails ... Please run /login',
      };
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runSkill("x", "p", tmpDir, { apiKey: "sk", projectRoot: "." });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("API key 无效或已过期");
    spy.mockRestore();
  });

  it("exit code 1 且 stderr 含鉴权错误时，翻译成可读提示", async () => {
    (query as any).mockImplementationOnce(async function* () {
      throw Object.assign(new Error("Claude Code process exited with code 1"), {
        stderr: "API Error: 401 Authentication Fails, api key invalid · Please run /login",
      });
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runSkill("x", "p", tmpDir, { apiKey: "sk", projectRoot: "." });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("AI 配置");
    expect(r.error).not.toContain("stderr=");
    spy.mockRestore();
  });

  it("普通错误不受影响", async () => {
    const { authProblem } = await import("./skill-runner.js");
    expect(authProblem("boom crashed")).toBeNull();
    expect(authProblem("")).toBeNull();
  });
});

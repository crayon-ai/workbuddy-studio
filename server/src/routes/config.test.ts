import { describe, it, expect, beforeEach, vi } from "vitest";

// 只 mock 两个会触碰外部环境的函数：isVideoReady（本机 ffmpeg/whisper）+ testConnection（真实网络）。
// saveConfig/getProvider/getApiKey 走真实实现 + 真 .env 文件，做端到端验证。
const { testConnMock } = vi.hoisted(() => ({ testConnMock: vi.fn() }));
vi.mock("../config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config.js")>();
  return { ...actual, isVideoReady: () => false, testConnection: testConnMock };
});

const { buildApp } = await import("../app.js");
const { rmSync, readFileSync, existsSync } = await import("node:fs");

const envPath = "./.env.route.test";

/** 极简 .env 读取（测试自用，不复用被测代码以免循环）。 */
function readEnv(): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function resetState() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  rmSync(envPath, { force: true });
}

describe("GET /api/config", () => {
  beforeEach(resetState);

  it("未配置：configured=false、provider=null、hasBaseUrl=false", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({ method: "GET", url: "/api/config" });
    expect(r.statusCode).toBe(200);
    const d = JSON.parse(r.body).data;
    expect(d.configured).toBe(false);
    expect(d.provider).toBeNull();
    expect(d.hasBaseUrl).toBe(false);
    expect(d).toHaveProperty("videoReady");
    await app.close();
  });

  it("配智谱后：configured=true、provider=zhipu、hasBaseUrl=true", async () => {
    const app = await buildApp({ envPath });
    await app.inject({
      method: "POST",
      url: "/api/config",
      payload: { provider: "zhipu", apiKey: "zhipu.key.value" },
    });
    const r = await app.inject({ method: "GET", url: "/api/config" });
    const d = JSON.parse(r.body).data;
    expect(d.configured).toBe(true);
    expect(d.provider).toBe("zhipu");
    expect(d.hasBaseUrl).toBe(true);
    await app.close();
  });
});

describe("POST /api/config", () => {
  beforeEach(resetState);

  it("zhipu 写入 .env：AUTH_TOKEN + bigmodel BASE_URL，无 API_KEY", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/config",
      payload: { provider: "zhipu", apiKey: "zhipu.key.value" },
    });
    expect(JSON.parse(r.body).success).toBe(true);
    const env = readEnv();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("zhipu.key.value");
    expect(env.ANTHROPIC_BASE_URL).toContain("bigmodel.cn");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    await app.close();
  });

  it("anthropic 写入 .env：API_KEY、无 AUTH_TOKEN/BASE_URL", async () => {
    const app = await buildApp({ envPath });
    await app.inject({
      method: "POST",
      url: "/api/config",
      payload: { provider: "anthropic", apiKey: "sk-ant-xxxxxx" },
    });
    const env = readEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxxxxx");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    await app.close();
  });

  it("custom + 合法 url 写入成功", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/config",
      payload: { provider: "custom", apiKey: "1234567890", baseUrl: "https://my.proxy/v1" },
    });
    expect(JSON.parse(r.body).success).toBe(true);
    const env = readEnv();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("1234567890");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://my.proxy/v1");
    await app.close();
  });

  it("非法 provider 拒绝，不写文件", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/config",
      payload: { provider: "deepseek", apiKey: "1234567890" },
    });
    const j = JSON.parse(r.body);
    expect(j.success).toBe(false);
    expect(j.error).toMatch(/provider/);
    expect(existsSync(envPath)).toBe(false);
    await app.close();
  });

  it("key 太短拒绝", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/config",
      payload: { provider: "zhipu", apiKey: "short" },
    });
    expect(JSON.parse(r.body).success).toBe(false);
    await app.close();
  });

  it("custom 缺 baseUrl 拒绝", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({
      method: "POST",
      url: "/api/config",
      payload: { provider: "custom", apiKey: "1234567890" },
    });
    const j = JSON.parse(r.body);
    expect(j.success).toBe(false);
    expect(j.error).toMatch(/baseUrl/);
    await app.close();
  });

  it("切换厂商不残留：zhipu → anthropic 清掉 BASE_URL/AUTH_TOKEN", async () => {
    const app = await buildApp({ envPath });
    await app.inject({
      method: "POST",
      url: "/api/config",
      payload: { provider: "zhipu", apiKey: "zhipu.key.value" },
    });
    expect(readEnv().ANTHROPIC_BASE_URL).toContain("bigmodel.cn");

    await app.inject({
      method: "POST",
      url: "/api/config",
      payload: { provider: "anthropic", apiKey: "sk-ant-xxxxxx" },
    });
    const env = readEnv();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxxxxx");
    await app.close();
  });
});

describe("POST /api/config/test", () => {
  beforeEach(() => {
    testConnMock.mockClear();
    testConnMock.mockResolvedValue({ ok: true, status: "ok", message: "连接成功" });
  });

  it("返回 testConnection 结果，透传 envPath", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({ method: "POST", url: "/api/config/test" });
    const j = JSON.parse(r.body);
    expect(j.success).toBe(true);
    expect(j.data.ok).toBe(true);
    expect(testConnMock).toHaveBeenCalledWith(envPath);
    await app.close();
  });
});

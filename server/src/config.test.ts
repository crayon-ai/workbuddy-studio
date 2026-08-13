import { describe, it, expect, beforeEach, vi } from "vitest";

// mock execSync 让 isVideoReady 可控（不依赖本机是否装了 ffmpeg/whisper）
const execSyncMock = vi.fn(() => { throw new Error("not installed"); });
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

const {
  getApiKey,
  saveApiKey,
  saveConfig,
  getProvider,
  testConnection,
  isVideoReady,
  parseEnv,
} = await import("./config.js");
const { rmSync } = await import("node:fs");

const envPath = "./.env.test";

/** 每个用例前：清掉所有鉴权相关 env + 删测试 .env，避免互相污染。 */
function resetEnv() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  rmSync(envPath, { force: true });
  vi.unstubAllGlobals();
}

describe("config", () => {
  beforeEach(() => {
    resetEnv();
    execSyncMock.mockClear();
    execSyncMock.mockImplementation(() => { throw new Error("not installed"); });
  });

  it("getApiKey 优先读环境变量", () => {
    process.env.ANTHROPIC_API_KEY = "sk-env";
    expect(getApiKey(envPath)).toBe("sk-env");
  });

  it("getApiKey 环境变量空时读 .env 文件", async () => {
    await saveApiKey("sk-file", envPath);
    expect(getApiKey(envPath)).toBe("sk-file");
  });

  it("getApiKey 都没有返回 undefined", () => {
    expect(getApiKey(envPath)).toBeUndefined();
  });

  it("isVideoReady 在 execSync 抛错时返回 false", () => {
    expect(isVideoReady()).toBe(false);
  });

  it("isVideoReady 在 ffmpeg 与 whisper 都可达时返回 true", () => {
    execSyncMock.mockImplementation(() => "ok"); // 两次 execSync（ffmpeg + curl whisper）都成功
    expect(isVideoReady()).toBe(true);
  });
});

describe("saveConfig", () => {
  beforeEach(resetEnv);

  it("zhipu: 写 AUTH_TOKEN + BASE_URL，不写 API_KEY", async () => {
    await saveConfig({ provider: "zhipu", apiKey: "zhipu.key" }, envPath);
    const env = parseEnv(envPath);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("zhipu.key");
    expect(env.ANTHROPIC_BASE_URL).toContain("bigmodel.cn");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("anthropic: 写 API_KEY，不写 AUTH_TOKEN/BASE_URL", async () => {
    await saveConfig({ provider: "anthropic", apiKey: "sk-ant-xxx" }, envPath);
    const env = parseEnv(envPath);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("custom: 写 AUTH_TOKEN + 用户 BASE_URL", async () => {
    await saveConfig({ provider: "custom", apiKey: "k", baseUrl: "https://my.proxy/v1" }, envPath);
    const env = parseEnv(envPath);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("k");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://my.proxy/v1");
  });

  it("切换厂商时清除旧变量（zhipu → anthropic 不残留 BASE_URL）", async () => {
    await saveConfig({ provider: "zhipu", apiKey: "zhipu.key" }, envPath);
    expect(parseEnv(envPath).ANTHROPIC_BASE_URL).toContain("bigmodel.cn");

    await saveConfig({ provider: "anthropic", apiKey: "sk-ant-xxx" }, envPath);
    const env = parseEnv(envPath);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined(); // 关键：切换不残留
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
  });
});

describe("getProvider", () => {
  beforeEach(resetEnv);

  it("智谱配置推断为 zhipu", async () => {
    await saveConfig({ provider: "zhipu", apiKey: "k" }, envPath);
    expect(getProvider(envPath)).toBe("zhipu");
  });

  it("官方 key 无 BASE_URL 推断为 anthropic", async () => {
    await saveConfig({ provider: "anthropic", apiKey: "sk-ant-x" }, envPath);
    expect(getProvider(envPath)).toBe("anthropic");
  });

  it("custom 推断为 custom", async () => {
    await saveConfig({ provider: "custom", apiKey: "k", baseUrl: "https://x.io" }, envPath);
    expect(getProvider(envPath)).toBe("custom");
  });

  it("未配置返回 undefined", () => {
    expect(getProvider(envPath)).toBeUndefined();
  });
});

describe("testConnection", () => {
  beforeEach(resetEnv);

  it("未配置 key 返回 auth_error", async () => {
    const r = await testConnection(envPath);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("auth_error");
  });

  it("200 返回 ok", async () => {
    await saveConfig({ provider: "zhipu", apiKey: "k" }, envPath);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const r = await testConnection(envPath);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ok");
  });

  it("401 返回 auth_error", async () => {
    await saveConfig({ provider: "zhipu", apiKey: "k" }, envPath);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const r = await testConnection(envPath);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("auth_error");
  });

  it("403 返回 forbidden", async () => {
    await saveConfig({ provider: "anthropic", apiKey: "sk-ant-x" }, envPath);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const r = await testConnection(envPath);
    expect(r.status).toBe("forbidden");
  });

  it("网络错误返回 network", async () => {
    await saveConfig({ provider: "zhipu", apiKey: "k" }, envPath);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const r = await testConnection(envPath);
    expect(r.status).toBe("network");
  });
});

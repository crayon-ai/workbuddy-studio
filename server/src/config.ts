import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

export type Provider = "zhipu" | "anthropic" | "custom";

export interface SaveConfigInput {
  provider: Provider;
  apiKey: string;
  /** custom 时由用户填写；zhipu/anthropic 忽略此字段。 */
  baseUrl?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  status: "ok" | "auth_error" | "forbidden" | "network" | "unknown";
  message: string;
}

/** 智谱 GLM 的 Anthropic 兼容端点。 */
export const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

/** .env 里鉴权相关变量名（切换厂商时整体清理，避免残留）。 */
const AUTH_VARS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;

/** 解析 .env 文件为 {KEY: VAL}（不覆盖系统环境变量）。 */
export function parseEnv(envPath = "./.env"): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** 把 .env 变量加载进 process.env（不覆盖已有的系统变量）。 */
export function loadEnv(envPath = "./.env"): void {
  for (const [k, v] of Object.entries(parseEnv(envPath))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function serializeEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

/**
 * 读取 API token：环境变量优先（智谱/custom 用 AUTH_TOKEN，Anthropic 用 API_KEY），其次 .env。
 * 两种 key 格式都支持：
 *  - Anthropic: sk-ant-...
 *  - 智谱（通过 open.bigmodel.cn/api/anthropic 兼容端点）: <id>.<secret>
 */
export function getApiKey(envPath = "./.env"): string | undefined {
  const file = parseEnv(envPath);
  return (
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    file.ANTHROPIC_AUTH_TOKEN ||
    file.ANTHROPIC_API_KEY
  );
}

/**
 * 按 provider 整体重写 .env 的鉴权变量（先清后写，避免切换厂商残留），并同步 process.env，
 * 让运行中的后端即时生效。保留文件内既有的非鉴权变量。
 *
 * - zhipu：写 AUTH_TOKEN + BASE_URL(智谱端点)
 * - anthropic：写 API_KEY，不写 BASE_URL（走默认 api.anthropic.com）
 * - custom：写 AUTH_TOKEN + 用户 BASE_URL
 */
export async function saveConfig(input: SaveConfigInput, envPath = "./.env"): Promise<void> {
  const env = parseEnv(envPath);
  for (const k of AUTH_VARS) delete env[k];

  if (input.provider === "anthropic") {
    env.ANTHROPIC_API_KEY = input.apiKey;
  } else if (input.provider === "custom") {
    env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
    if (input.baseUrl) env.ANTHROPIC_BASE_URL = input.baseUrl;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
    env.ANTHROPIC_BASE_URL = ZHIPU_BASE_URL;
  }

  writeFileSync(envPath, serializeEnv(env), { mode: 0o600 });

  // 同步 process.env：先清旧值再写新值，让运行中的后端即时生效
  for (const k of AUTH_VARS) delete process.env[k];
  for (const k of AUTH_VARS) {
    if (env[k] !== undefined) process.env[k] = env[k];
  }
}

/**
 * @deprecated 改用 saveConfig。保留向后兼容：按 custom 写入，保留既有 BASE_URL。
 */
export async function saveApiKey(key: string, envPath = "./.env"): Promise<void> {
  const existingBaseUrl = parseEnv(envPath).ANTHROPIC_BASE_URL;
  await saveConfig({ provider: "custom", apiKey: key, baseUrl: existingBaseUrl }, envPath);
}

/**
 * 推断当前配置的厂商（env 优先于文件）：
 *  - BASE_URL 含 bigmodel.cn → zhipu
 *  - 有 API_KEY（且 BASE_URL 为空或指向 anthropic.com）→ anthropic
 *  - 有 AUTH_TOKEN → custom
 *  - 都没有 → undefined
 */
export function getProvider(envPath = "./.env"): Provider | undefined {
  const file = parseEnv(envPath);
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || file.ANTHROPIC_BASE_URL || "").trim();
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || file.ANTHROPIC_API_KEY);
  const hasAuthToken = !!(process.env.ANTHROPIC_AUTH_TOKEN || file.ANTHROPIC_AUTH_TOKEN);

  if (baseUrl.includes("bigmodel.cn")) return "zhipu";
  if (hasApiKey && (!baseUrl || baseUrl.includes("anthropic.com"))) return "anthropic";
  if (hasAuthToken) return "custom";
  return undefined;
}

/**
 * 解析当前厂商调用子进程时应显式传给 SDK 的模型名。
 * - zhipu：glm-4.6（智谱端点不认 claude-* 模型名，400 modelCode 不存在）
 * - deepseek：deepseek-v4-pro（不传则 SDK 默认 claude-*，DeepSeek 静默降级成
 *   弱模型 deepseek-v4-flash，跑不动爆款拆解这类多步复杂 skill，表现为一直卡在执行）
 * - 其他（anthropic / 非 deepseek 的 custom）：不传，走 SDK 默认
 */
export function resolveModelName(envPath = "./.env"): string | undefined {
  const baseUrl = (
    process.env.ANTHROPIC_BASE_URL || parseEnv(envPath).ANTHROPIC_BASE_URL || ""
  )
    .trim()
    .toLowerCase();
  if (getProvider(envPath) === "zhipu") return "glm-4.6";
  if (baseUrl.includes("deepseek.com")) return "deepseek-v4-pro";
  return undefined;
}

/**
 * 用当前 .env 配置打一个最小 /v1/messages，验证 key + url 是否可用。
 * 不依赖 Claude Agent SDK，仅做鉴权/连通性探测。
 */
export async function testConnection(envPath = "./.env"): Promise<ConnectionTestResult> {
  const file = parseEnv(envPath);
  const apiKey = getApiKey(envPath);
  if (!apiKey) {
    return { ok: false, status: "auth_error", message: "未配置 API key" };
  }

  const rawBase = (process.env.ANTHROPIC_BASE_URL || file.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "");
  const url = rawBase ? `${rawBase}/v1/messages` : "https://api.anthropic.com/v1/messages";
  const provider = getProvider(envPath);
  // 用和真实 skill 调用一致的模型名（DeepSeek 需 deepseek-v4-pro，否则会被静默降级）
  const model = resolveModelName(envPath) ?? "claude-sonnet-4-5";
  const useApiKeyHeader = provider === "anthropic";

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (useApiKeyHeader) headers["x-api-key"] = apiKey;
  else headers.authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true, status: "ok", message: "连接成功" };
    if (res.status === 401) return { ok: false, status: "auth_error", message: "API key 无效或已过期" };
    if (res.status === 403) return { ok: false, status: "forbidden", message: "被拒绝（可能是区域限制，如官方需翻墙）" };
    return { ok: false, status: "unknown", message: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, status: "network", message: `网络错误：${e?.message ?? String(e)}` };
  }
}

/** 探测视频拆解工具是否就绪：ffmpeg 可用 且 whisper.cpp server（:2022）可达。 */
export function isVideoReady(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    execSync(
      'curl -s -o /dev/null -w "%{http_code}" http://localhost:2022/health',
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

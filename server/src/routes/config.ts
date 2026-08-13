import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import {
  getApiKey,
  getProvider,
  saveConfig,
  testConnection,
  isVideoReady,
  parseEnv,
  type Provider,
} from "../config.js";

export interface ConfigRoutesOpts {
  envPath: string;
  projectRoot: string;
}

const PROVIDERS: readonly Provider[] = ["zhipu", "anthropic", "custom"];

function isProvider(p: unknown): p is Provider {
  return typeof p === "string" && (PROVIDERS as readonly string[]).includes(p);
}

function currentBaseUrl(envPath: string): string {
  return (process.env.ANTHROPIC_BASE_URL || parseEnv(envPath).ANTHROPIC_BASE_URL || "").trim();
}

export const configRoutes: FastifyPluginCallback<ConfigRoutesOpts> = (
  app,
  opts,
  done
) => {
  app.get("/api/config", async () => {
    const key = getApiKey(opts.envPath);
    return {
      success: true,
      data: {
        configured: !!key,
        provider: getProvider(opts.envPath) ?? null,
        hasBaseUrl: !!currentBaseUrl(opts.envPath),
        videoReady: isVideoReady(),
      },
    };
  });

  app.post("/api/config", async (req) => {
    const { provider, apiKey, baseUrl } = (req.body ?? {}) as {
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
    };

    if (!isProvider(provider)) {
      return { success: false, data: null, error: "provider 无效（需为 zhipu/anthropic/custom）" };
    }
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
      return { success: false, data: null, error: "apiKey 无效（至少 10 位）" };
    }
    if (provider === "custom") {
      try {
        const u = new URL(baseUrl ?? "");
        if (!/^https?:$/.test(u.protocol)) throw new Error("非 http(s)");
      } catch {
        return { success: false, data: null, error: "baseUrl 无效（custom 需提供合法 http(s) URL）" };
      }
    }

    await saveConfig(
      {
        provider,
        apiKey: apiKey.trim(),
        baseUrl: provider === "custom" ? (baseUrl as string).trim() : undefined,
      },
      opts.envPath
    );
    return { success: true, data: { ok: true } };
  });

  app.post("/api/config/test", async () => {
    const result = await testConnection(opts.envPath);
    return { success: true, data: result };
  });

  done();
};

declare module "fastify" {
  interface FastifyInstance {
    // 预留：后续 task 注入其他路由时扩展
  }
}

export type _FastifyInstance = FastifyInstance;

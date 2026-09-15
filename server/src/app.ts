import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getLanToken, isLoopback, tokenEquals, tokenFromRequest } from "./lan.js";
import { configRoutes } from "./routes/config.js";
import { lanRoutes } from "./routes/lan.js";
import { titleRoutes } from "./routes/title.js";
import { teardownRoutes } from "./routes/teardown.js";
import { precheckRoutes } from "./routes/precheck.js";
import { noteRoutes } from "./routes/note.js";
import { inspirationRoutes } from "./routes/inspiration.js";
import { personalizedRoutes } from "./routes/personalized.js";
import { deepReviewRoutes } from "./routes/deep-review.js";
import { scriptRoutes } from "./routes/script.js";
import { polishRoutes } from "./routes/polish.js";
import { materialRoutes } from "./routes/material.js";
import { taskRoutes } from "./routes/task.js";
import { healthzRoutes } from "./routes/healthz.js";
import { syncRoutes } from "./routes/sync.js";

export interface BuildAppOpts {
  /** API key 落地的 .env 路径，默认 ./.env（相对 server 工作目录） */
  envPath?: string;
  /** 项目根（用于 skill-runner 的 cwd），默认推导到 server 上级 */
  projectRoot?: string;
}

/**
 * 构建未挂载静态资源的 Fastify 实例（供测试 inject）。
 */
export async function buildApp(opts: BuildAppOpts = {}): Promise<FastifyInstance> {
  const app = Fastify();
  const routeOpts = {
    envPath: opts.envPath ?? "./.env",
    projectRoot: opts.projectRoot ?? defaultProjectRoot(),
  };
  app.addHook("onRequest", lanAuthHook(routeOpts.projectRoot));
  await app.register(configRoutes, routeOpts);
  await app.register(titleRoutes, routeOpts);
  await app.register(teardownRoutes, routeOpts);
  await app.register(precheckRoutes, routeOpts);
  await app.register(noteRoutes, routeOpts);
  await app.register(inspirationRoutes, routeOpts);
  await app.register(personalizedRoutes, routeOpts);
  await app.register(deepReviewRoutes, routeOpts);
  await app.register(scriptRoutes, routeOpts);
  await app.register(polishRoutes, routeOpts);
  await app.register(materialRoutes, routeOpts);
  await app.register(taskRoutes);
  await app.register(healthzRoutes);
  await app.register(syncRoutes, routeOpts);
  await app.register(lanRoutes, routeOpts);
  return app;
}

const LAN_COOKIE = "wb_lan";

/** 解析 Cookie 头里的 wb_lan 值（手写解析，免引 @fastify/cookie）。 */
function cookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return "";
}

/** 手机端被拒时看到的提示页（手输 IP 没带 token 的场景）。 */
function lanDeniedHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkBuddy · 需要授权</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#FBF6EE;color:#2A2018;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{max-width:420px;text-align:center;background:#fff;border-radius:20px;padding:36px 28px;box-shadow:0 10px 40px rgba(42,32,24,.08)}
h1{font-size:20px;margin:0 0 10px}p{font-size:14px;line-height:1.8;color:#7A6F63;margin:0}
.step{display:flex;gap:10px;align-items:flex-start;text-align:left;font-size:13.5px;color:#4A4238;margin-top:12px;line-height:1.6}
.no{flex:none;width:22px;height:22px;border-radius:50%;background:#F4633C;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:2px}
</style></head><body><div class="box"><h1>🔒 这是 WorkBuddy 的专属入口</h1>
<p>手机访问需要授权，直接输网址进不来。请这样做：</p>
<div class="step"><span class="no">1</span><span>回到<strong>电脑端</strong>工作台，点左侧「设置 → 手机访问」</span></div>
<div class="step"><span class="no">2</span><span>用手机<strong>扫描弹窗里的二维码</strong>（需和电脑连同一个 WiFi）</span></div>
<div class="step"><span class="no">3</span><span>扫完即自动授权，可「添加到主屏幕」当 App 用</span></div>
</div></body></html>`;
}

/**
 * 局域网访问门禁（onRequest，作用于所有请求）：
 * - 本机（loopback）一律放行，电脑端体验不变；
 * - 其他设备需带有效 token（?t= 查询参数 / x-wb-token 头 / wb_lan cookie）；
 *   首次用 ?t= 进入时下发 HttpOnly cookie，之后刷新、请求资源都不再带参数。
 */
export function lanAuthHook(projectRoot: string) {
  return async (req: any, reply: any) => {
    if (isLoopback(req.ip)) return;

    const token = getLanToken(projectRoot);

    // 已有 cookie：直接放行
    const cookie = cookieValue(req.headers?.cookie, LAN_COOKIE);
    if (cookie && tokenEquals(cookie, token)) return;

    // ?t= 或请求头携带 token：放行并种 cookie（一年有效，token 落盘不变）
    const presented =
      (typeof req.query === "object" && req.query ? String((req.query as Record<string, unknown>).t ?? "") : "") ||
      tokenFromRequest(req.headers ?? {}, {});
    if (presented && tokenEquals(presented, token)) {
      reply.header(
        "set-cookie",
        `${LAN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
      );
      return;
    }

    if (req.url.startsWith("/api/")) {
      return reply
        .code(401)
        .send({
          success: false,
          data: null,
          error: "WB_LAN_TOKEN_REQUIRED",
          message: "手机访问需要授权：请用电脑端工作台「手机访问」面板里的二维码进入",
        });
    }
    return reply.code(401).type("text/html; charset=utf-8").send(lanDeniedHtml());
  };
}

function defaultProjectRoot(): string {
  // src/app.ts → server/ → 项目根
  // 用 fileURLToPath 避免含中文/空格的路径被 URL percent-encode
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "../..");
}

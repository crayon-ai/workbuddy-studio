import fastifyStatic from "@fastify/static";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildApp } from "./app.js";
import { loadEnv } from "./config.js";
import { teeToFile } from "./logger.js";
import { migrateLegacyDataDirs } from "./account-dirs.js";
import { getLanToken, listLanAddresses } from "./lan.js";

const PORT = Number(process.env.PORT ?? 7788);
// 默认绑 0.0.0.0：手机等局域网设备可访问（有 token 门禁，见 app.ts lanAuthHook）。
// 只想电脑自用时设 WB_HOST=127.0.0.1。
const HOST = process.env.WB_HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  teeToFile(); // stdout/stderr 镜像到 logs/server.log（任何启动方式都落盘）
  loadEnv(); // 加载 server/.env（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL 等）
  const app = await buildApp();
  const here = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(here), "../..");

  // 3.0 多账号：2.0 的 data/<模块>/ 惰性迁移到 data/accounts/default/（幂等）
  const migrated = migrateLegacyDataDirs(projectRoot);
  if (migrated.length) {
    console.log(`[migrate] 2.0 产物目录已迁入默认账号：${migrated.join(", ")}`);
  }

  // 静态资源：只开放 assets/（头像、PWA 图标），不再整项目 wildcard，
  // 避免局域网模式下 server/.env 等敏感文件经静态路由外泄。
  await app.register(fastifyStatic, {
    root: path.join(projectRoot, "assets"),
    prefix: "/assets/",
  });

  // PWA：manifest + 图标（手机「添加到主屏幕」用；找不到文件时静默 404，不影响使用）
  app.get("/manifest.webmanifest", async (_req, reply) => {
    const file = path.join(projectRoot, "assets", "manifest.webmanifest");
    try {
      reply.type("application/manifest+json; charset=utf-8").send(readFileSync(file));
    } catch {
      reply.code(404).send({ success: false, error: "manifest 不存在" });
    }
  });

  // GET / 返回前端（项目根无 index.html，前端文件名为中文）
  // no-cache：允许缓存但每次需向服务端 revalidate，避免改版后浏览器拿旧页面
  app.get("/", async (_req, reply) => {
    const html = readFileSync(path.join(projectRoot, "自媒体工作台.html"));
    // no-store：单文件应用改版频繁，彻底禁缓存，保证刷新即最新（no-cache 无验证器时部分浏览器仍用旧缓存）
    reply.header("Cache-Control", "no-store");
    reply.type("text/html; charset=utf-8").send(html);
  });

  try {
    await app.listen({ host: HOST, port: PORT });
    console.log(`WorkBuddy 后端已启动：http://127.0.0.1:${PORT}`);
    if (HOST !== "127.0.0.1") {
      const token = getLanToken(projectRoot);
      const addrs = listLanAddresses();
      if (addrs.length) {
        console.log(`📱 手机访问（同一 WiFi，电脑端工作台「手机访问」面板可扫码）：`);
        for (const a of addrs.slice(0, 3)) {
          console.log(`   http://${a.address}:${PORT}/?t=${token}`);
        }
      } else {
        console.log(`📱 手机访问：未检测到局域网地址（未连 WiFi？），连上后重启即可`);
      }
    }
  } catch (e) {
    console.error("启动失败：", e);
    process.exit(1);
  }
}

main();

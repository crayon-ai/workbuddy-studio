import fastifyStatic from "@fastify/static";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildApp } from "./app.js";
import { loadEnv } from "./config.js";
import { teeToFile } from "./logger.js";

const PORT = Number(process.env.PORT ?? 7788);
const HOST = "127.0.0.1";

async function main(): Promise<void> {
  teeToFile(); // stdout/stderr 镜像到 logs/server.log（任何启动方式都落盘）
  loadEnv(); // 加载 server/.env（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL 等）
  const app = await buildApp();
  const here = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(here), "../..");

  // 静态资源（assets 图片等）
  await app.register(fastifyStatic, {
    root: projectRoot,
    prefix: "/",
    wildcard: true,
  });

  // GET / 返回前端（项目根无 index.html，前端文件名为中文）
  // no-cache：允许缓存但每次需向服务端 revalidate，避免改版后浏览器拿旧页面
  app.get("/", async (_req, reply) => {
    const html = readFileSync(path.join(projectRoot, "自媒体工作台.html"));
    reply.header("Cache-Control", "no-cache");
    reply.type("text/html; charset=utf-8").send(html);
  });

  try {
    await app.listen({ host: HOST, port: PORT });
    console.log(`WorkBuddy 后端已启动：http://${HOST}:${PORT}`);
  } catch (e) {
    console.error("启动失败：", e);
    process.exit(1);
  }
}

main();

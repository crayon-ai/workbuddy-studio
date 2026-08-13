import fastifyStatic from "@fastify/static";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildApp } from "./app.js";
import { loadEnv } from "./config.js";

const PORT = Number(process.env.PORT ?? 7788);
const HOST = "127.0.0.1";

async function main(): Promise<void> {
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
  app.get("/", async (_req, reply) => {
    const html = readFileSync(path.join(projectRoot, "自媒体工作台.html"));
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

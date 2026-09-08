import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { configRoutes } from "./routes/config.js";
import { titleRoutes } from "./routes/title.js";
import { teardownRoutes } from "./routes/teardown.js";
import { precheckRoutes } from "./routes/precheck.js";
import { noteRoutes } from "./routes/note.js";
import { inspirationRoutes } from "./routes/inspiration.js";
import { personalizedRoutes } from "./routes/personalized.js";
import { deepReviewRoutes } from "./routes/deep-review.js";
import { scriptRoutes } from "./routes/script.js";
import { taskRoutes } from "./routes/task.js";
import { healthzRoutes } from "./routes/healthz.js";

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
  await app.register(configRoutes, routeOpts);
  await app.register(titleRoutes, routeOpts);
  await app.register(teardownRoutes, routeOpts);
  await app.register(precheckRoutes, routeOpts);
  await app.register(noteRoutes, routeOpts);
  await app.register(inspirationRoutes, routeOpts);
  await app.register(personalizedRoutes, routeOpts);
  await app.register(deepReviewRoutes, routeOpts);
  await app.register(scriptRoutes, routeOpts);
  await app.register(taskRoutes);
  await app.register(healthzRoutes);
  return app;
}

function defaultProjectRoot(): string {
  // src/app.ts → server/ → 项目根
  // 用 fileURLToPath 避免含中文/空格的路径被 URL percent-encode
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "../..");
}

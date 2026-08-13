import type { FastifyPluginCallback } from "fastify";
import { getTask } from "../task-store.js";

export const taskRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/api/task/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const t = getTask(id);
    if (!t) return { success: false, data: null, error: "任务不存在" };
    return { success: true, data: t };
  });
  done();
};

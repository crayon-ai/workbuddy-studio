import type { FastifyPluginCallback } from "fastify";

export const healthzRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/healthz", async () => ({ success: true, data: { status: "ok" }, error: null }));
  done();
};

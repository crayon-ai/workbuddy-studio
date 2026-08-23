import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";

describe("GET /healthz", () => {
  it("返回 200 且 success=true", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { status: "ok" }, error: null });
  });
});

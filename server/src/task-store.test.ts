import { describe, it, expect } from "vitest";
import { createTask, getTask, updateTask } from "./task-store.js";

describe("task-store", () => {
  it("createTask 返回 pending 任务", () => {
    const id = createTask();
    expect(getTask(id)?.status).toBe("pending");
    expect(getTask(id)?.createdAt).toBeGreaterThan(0);
  });

  it("updateTask 流转 running → done 并带 result", () => {
    const id = createTask();
    updateTask(id, { status: "running" });
    expect(getTask(id)?.status).toBe("running");
    updateTask(id, { status: "done", result: { x: 1 } });
    expect(getTask(id)).toMatchObject({ status: "done", result: { x: 1 } });
  });

  it("updateTask failed 带 error", () => {
    const id = createTask();
    updateTask(id, { status: "failed", error: "boom" });
    expect(getTask(id)?.status).toBe("failed");
    expect(getTask(id)?.error).toBe("boom");
  });

  it("未知 id getTask 返回 undefined、updateTask 无副作用", () => {
    expect(getTask("nonexistent-id")).toBeUndefined();
    expect(() => updateTask("nonexistent-id", { status: "done" })).not.toThrow();
  });

  it("createdAt 不被 updateTask 覆盖", () => {
    const id = createTask();
    const before = getTask(id)!.createdAt;
    updateTask(id, { status: "done" });
    expect(getTask(id)!.createdAt).toBe(before);
  });
});

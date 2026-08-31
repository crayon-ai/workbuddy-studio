import { describe, expect, it, vi } from "vitest";
import { taskLog } from "./log.js";

describe("taskLog", () => {
  it("输出 [时间] [模块:taskId] 消息 格式", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    taskLog("title", "t123", "提交：主题=测试");
    const line = spy.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[title:t123\] 提交：主题=测试$/);
    spy.mockRestore();
  });

  it("传 t0 时追加 (+N.Ns) 耗时", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const t0 = Date.now() - 1500; // 1.5 秒前
    taskLog("teardown", "t456", "完成", t0);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \(\+\d+\.\d+s\) \[teardown:t456\] 完成$/);
    spy.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { teeToFile, logFilePath } from "./logger.js";

function tmpLog(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "wb-log-")), name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("teeToFile", () => {
  it("把 stdout/stderr 输出镜像追加到日志文件", () => {
    const file = tmpLog("server.log");
    teeToFile(file);
    // 直接写流（vitest 会拦截 console.*，测不到 tee；真实运行时 console 最终也走这里）
    process.stdout.write("hello 日志\n");
    process.stderr.write("boom\n");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("hello 日志");
    expect(content).toContain("boom");
    expect(content).toContain("进程启动");
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("超过 5MB 时轮转为 .old", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wb-rot-"));
    const file = path.join(dir, "server.log");
    writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));
    teeToFile(file);
    expect(existsSync(`${file}.old`)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("目录不可写时不抛异常（不影响服务启动）", () => {
    expect(() => teeToFile("/proc/不存在的目录/server.log")).not.toThrow();
  });
});

describe("logFilePath", () => {
  it("默认指向项目根 logs/server.log", () => {
    expect(logFilePath()).toMatch(/logs[/\\]server\.log$/);
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountSlug,
  accountTaskDir,
  legacyTaskDir,
  resolveTaskDir,
  migrateLegacyDataDirs,
} from "./account-dirs.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wb-accdirs-"));
}

describe("accountSlug", () => {
  it("合法 id 原样通过", () => {
    expect(accountSlug("default")).toBe("default");
    expect(accountSlug("a1b2c3")).toBe("a1b2c3");
    expect(accountSlug("my-blog_01")).toBe("my-blog_01");
  });

  it("非法/缺失/危险输入一律回落 default", () => {
    expect(accountSlug(undefined)).toBe("default");
    expect(accountSlug("")).toBe("default");
    expect(accountSlug(42)).toBe("default");
    expect(accountSlug("../evil")).toBe("default");
    expect(accountSlug("a/b")).toBe("default");
    expect(accountSlug("x".repeat(65))).toBe("default");
  });
});

describe("目录布局与读侧回退", () => {
  it("accountTaskDir / legacyTaskDir 路径形态", () => {
    const root = "/proj";
    expect(accountTaskDir(root, "acc1", "teardowns", "t1")).toBe(
      join(root, "data", "accounts", "acc1", "teardowns", "t1")
    );
    expect(legacyTaskDir(root, "teardowns", "t1")).toBe(join(root, "data", "teardowns", "t1"));
  });

  it("resolveTaskDir：账号目录存在则优先", () => {
    const root = tmpRoot();
    const accDir = accountTaskDir(root, "acc1", "teardowns", "t1");
    mkdirSync(accDir, { recursive: true });
    mkdirSync(legacyTaskDir(root, "teardowns", "t1"), { recursive: true });
    expect(resolveTaskDir(root, "acc1", "teardowns", "t1")).toBe(accDir);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolveTaskDir：非 default 账号回退到 default 账号目录（v1 备份导入场景）", () => {
    const root = tmpRoot();
    const defDir = accountTaskDir(root, "default", "teardowns", "t9");
    mkdirSync(defDir, { recursive: true });
    expect(resolveTaskDir(root, "accOther", "teardowns", "t9")).toBe(defDir);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolveTaskDir：default 账号回退到 2.0 旧目录", () => {
    const root = tmpRoot();
    const legacy = legacyTaskDir(root, "teardowns", "t2");
    mkdirSync(legacy, { recursive: true });
    expect(resolveTaskDir(root, "default", "teardowns", "t2")).toBe(legacy);
    expect(resolveTaskDir(root, undefined, "teardowns", "t2")).toBe(legacy);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolveTaskDir：都不存在时返回首选路径（调用方报「目录不存在」）", () => {
    const root = tmpRoot();
    expect(resolveTaskDir(root, "accX", "teardowns", "none")).toBe(
      accountTaskDir(root, "accX", "teardowns", "none")
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe("migrateLegacyDataDirs（启动惰性迁移）", () => {
  it("把 2.0 旧目录挪到 data/accounts/default/ 下", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "data", "teardowns", "old-task"), { recursive: true });
    writeFileSync(join(root, "data", "teardowns", "old-task", "report.md"), "x");
    mkdirSync(join(root, "data", "inspirations"), { recursive: true }); // 空目录也迁

    const moved = migrateLegacyDataDirs(root);
    expect(moved).toContain("teardowns");
    expect(moved).toContain("inspirations");
    expect(existsSync(join(root, "data", "accounts", "default", "teardowns", "old-task", "report.md"))).toBe(true);
    expect(existsSync(join(root, "data", "teardowns"))).toBe(false);

    // 幂等：再跑一次无事发生
    expect(migrateLegacyDataDirs(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("没有旧目录时不动文件系统", () => {
    const root = tmpRoot();
    expect(migrateLegacyDataDirs(root)).toEqual([]);
    expect(existsSync(join(root, "data"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

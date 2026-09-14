import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

let root: string;
let app: FastifyInstance;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "wb-syncroute-"));
  app = await buildApp({ projectRoot: root, envPath: path.join(root, ".env") });
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/sync", () => {
  it("空库返回 rev=0 的空文档", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sync" });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.success).toBe(true);
    expect(j.data.rev).toBe(0);
    expect(j.data.accounts).toEqual([]);
    expect(existsSync(path.join(root, "data", "sync.json"))).toBe(false); // GET 不落盘
  });
});

describe("POST /api/sync", () => {
  it("推送变更后 GET 能读到，账号数据嵌回 export-v2 形态", async () => {
    const push = await app.inject({
      method: "POST",
      url: "/api/sync",
      payload: {
        changes: [
          { kind: "list", accounts: [{ id: "a1", name: "深夜食堂", plat: "xhs", emoji: "🍜", bg: "c", createdAt: 1 }], currentId: "a1" },
          { kind: "suffix", accountId: "a1", suffix: "main", value: '{"topics":[{"id":1}]}' },
          { kind: "global", key: "wb_theme", value: "midnight" },
        ],
        tombs: {},
      },
    });
    expect(push.statusCode).toBe(200);
    const pj = push.json();
    expect(pj.success).toBe(true);
    expect(pj.data.rev).toBe(1);
    expect(pj.data.accounts[0].data.main).toBe('{"topics":[{"id":1}]}');
    expect(pj.data.global.wb_theme).toBe("midnight");
    expect(pj.data.currentId).toBe("a1");

    const got = await app.inject({ method: "GET", url: "/api/sync" });
    expect(got.json().data).toEqual({ ...pj.data, baseRev: undefined });
  });

  it("墓碑删除账号 + 迟到数据被拦", async () => {
    await app.inject({
      method: "POST",
      url: "/api/sync",
      payload: {
        changes: [
          { kind: "list", accounts: [{ id: "a1", name: "A", plat: "web", emoji: "🌟", bg: "", createdAt: 1 }], currentId: "a1" },
          { kind: "suffix", accountId: "a1", suffix: "main", value: "v" },
        ],
        tombs: {},
      },
    });
    const del = await app.inject({ method: "POST", url: "/api/sync", payload: { changes: [], tombs: { a1: 123 } } });
    expect(del.json().data.accounts).toEqual([]);
    const late = await app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { changes: [{ kind: "suffix", accountId: "a1", suffix: "main", value: "late" }], tombs: {} },
    });
    expect(late.json().data.accounts).toEqual([]);
    expect(late.json().data.rev).toBe(del.json().data.rev); // 全被拦下，rev 不变
  });

  it("非法输入：空变更 400；垃圾条目被丢弃后空了也 400；非法全局键被拒", async () => {
    const empty = await app.inject({ method: "POST", url: "/api/sync", payload: { changes: [], tombs: {} } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("WB_SYNC_EMPTY");

    const garbage = await app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { changes: [{ kind: "global", key: "wb_hack", value: "x" }, { kind: "suffix", accountId: "../etc", suffix: "main", value: "x" }], tombs: {} },
    });
    expect(garbage.statusCode).toBe(400);

    const meta = await app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { changes: [{ kind: "meta", accountId: "a1", account: { id: "a1", name: "x".repeat(300), plat: "wechat", emoji: "🌟", bg: "", createdAt: "abc" } }], tombs: {} },
    });
    expect(meta.statusCode).toBe(200);
    const acc = meta.json().data.accounts[0];
    expect(acc.name.length).toBeLessThanOrEqual(100);
    expect(acc.plat).toBe("web");
    expect(typeof acc.createdAt).toBe("number");
  });

  it("POST 响应携带 baseRev（推送前的 rev），空串全局值合法", async () => {
    await app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { changes: [{ kind: "global", key: "wb_theme", value: "" }], tombs: {} },
    });
    const again = await app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { changes: [{ kind: "global", key: "wb_theme", value: "midnight" }], tombs: {} },
    });
    const j = again.json();
    expect(j.data.baseRev).toBe(1); // 第二次推送前服务端已到 rev 1
    expect(j.data.rev).toBe(2);
    expect(j.data.global.wb_theme).toBe("midnight");
  });

  it("落盘文件可被下一次进程读取（持久化）", async () => {
    await app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { changes: [{ kind: "suffix", accountId: "a1", suffix: "mats", value: "[]" }], tombs: {} },
    });
    const raw = JSON.parse(readFileSync(path.join(root, "data", "sync.json"), "utf8"));
    expect(raw.data["a1|mats"]).toBe("[]");
  });
});

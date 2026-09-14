import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePolishOutput, polishRoutes } from "./polish.js";
import { buildApp } from "../app.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "polish-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parsePolishOutput", () => {
  it("解析元数据注释与正文", () => {
    const md = `<!--WB:STYLE {"chips":["短句为主","爱用口头禅"],"consistency":88,"changes":6}-->\n\n润色后的正文第一段。\n第二段。`;
    const r = parsePolishOutput(md);
    expect(r.chips).toEqual(["短句为主", "爱用口头禅"]);
    expect(r.consistency).toBe(88);
    expect(r.changes).toBe(6);
    expect(r.text).toBe("润色后的正文第一段。\n第二段。");
  });

  it("元数据缺失/损坏时退化为纯文本", () => {
    expect(parsePolishOutput("<!--WB:STYLE {坏的 json}-->正文").text).toBe("正文");
    const r = parsePolishOutput("没有注释的正文");
    expect(r.chips).toEqual([]);
    expect(r.consistency).toBeNull();
    expect(r.text).toBe("没有注释的正文");
  });

  it("chips 超量截断到 6 个", () => {
    const md = `<!--WB:STYLE {"chips":["1","2","3","4","5","6","7","8"]}-->x`;
    expect(parsePolishOutput(md).chips.length).toBe(6);
  });
});

describe("GET /api/polish/notes", () => {
  it("空目录返回空列表", async () => {
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({ method: "GET", url: "/api/polish/notes" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.notes).toEqual([]);
  });

  it("列出已落库的笔记（按下载时间倒序）", async () => {
    const dir = path.join(root, "data/accounts/default/polish/notes");
    mkdirSync(path.join(dir, "n1"), { recursive: true });
    mkdirSync(path.join(dir, "n2"), { recursive: true });
    writeFileSync(path.join(dir, "n1/meta.json"), JSON.stringify({ id: "n1", url: "https://www.xiaohongshu.com/a", title: "旧的一篇", type: "图文", likes: "10", date: "2026-09-01", downloadedAt: "2026-09-01T00:00:00Z" }));
    writeFileSync(path.join(dir, "n2/meta.json"), JSON.stringify({ id: "n2", url: "https://www.xiaohongshu.com/b", title: "新的一篇", type: "视频", likes: "20", date: "2026-09-02", downloadedAt: "2026-09-02T00:00:00Z" }));
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({ method: "GET", url: "/api/polish/notes" });
    const notes = res.json().data.notes;
    expect(notes.map((n: any) => n.id)).toEqual(["n2", "n1"]);
  });
});

describe("DELETE /api/polish/notes/:id", () => {
  it("删除存在的笔记目录", async () => {
    const dir = path.join(root, "data/accounts/default/polish/notes/n1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), "{}");
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({ method: "DELETE", url: "/api/polish/notes/n1" });
    expect(res.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/polish/notes" });
    expect(after.json().data.notes).toEqual([]);
  });

  it("非法 id 拒绝（防路径穿越）", async () => {
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({ method: "DELETE", url: "/api/polish/notes/..%2F..%2Fetc" });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
  });
});

describe("GET /api/polish/runs（历史卡片）", () => {
  it("列出 meta.json 并按时间倒序", async () => {
    const dir = path.join(root, "data/accounts/default/polish/runs");
    mkdirSync(path.join(dir, "t1"), { recursive: true });
    mkdirSync(path.join(dir, "t2"), { recursive: true });
    writeFileSync(path.join(dir, "t1/meta.json"), JSON.stringify({ id: "t1", createdAt: "2026-09-01T00:00:00Z", chars: 100, chips: ["a"] }));
    writeFileSync(path.join(dir, "t2/meta.json"), JSON.stringify({ id: "t2", createdAt: "2026-09-02T00:00:00Z", chars: 200, chips: ["b"] }));
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({ method: "GET", url: "/api/polish/runs" });
    expect(res.json().data.runs.map((r: any) => r.id)).toEqual(["t2", "t1"]);
  });

  it("run 详情返回初稿与润色稿", async () => {
    const dir = path.join(root, "data/accounts/default/polish/runs/t1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "draft.md"), "这是初稿");
    writeFileSync(path.join(dir, "output.md"), '<!--WB:STYLE {"chips":["x"],"consistency":90,"changes":3}-->这是润色稿');
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: "t1", createdAt: "2026-09-01T00:00:00Z", chars: 5, chips: ["x"] }));
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({ method: "GET", url: "/api/polish/runs/t1" });
    const d = res.json().data;
    expect(d.draft).toBe("这是初稿");
    expect(d.text).toBe("这是润色稿");
    expect(d.chips).toEqual(["x"]);
  });
});

describe("POST /api/polish 参数校验", () => {
  it("无勾选笔记 / 初稿过短 / 非 xhs 链接直接拒绝", async () => {
    const app = await buildApp({ projectRoot: root });
    const r1 = await app.inject({ method: "POST", url: "/api/polish", payload: { noteIds: [], draft: "x".repeat(50) } });
    expect(r1.json().success).toBe(false);
    const r2 = await app.inject({ method: "POST", url: "/api/polish", payload: { noteIds: ["a"], draft: "短" } });
    expect(r2.json().success).toBe(false);
    const r3 = await app.inject({ method: "POST", url: "/api/polish/parse", payload: { url: "https://www.baidu.com/x" } });
    expect(r3.json().success).toBe(false);
  });
});

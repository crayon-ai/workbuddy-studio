import { describe, it, expect, beforeEach, vi } from "vitest";

// mock global.fetch：返回含 noteDetailMap 的假 SSR HTML
const FAKE_STATE: any = {
  note: {
    noteDetailMap: {
      abc: {
        note: {
          title: "测试笔记",
          noteId: "abc",
          user: { nickname: "测试作者" },
          interactInfo: {
            likedCount: "100",
            collectedCount: "50",
            commentCount: "10",
            shareCount: "5",
          },
          time: 1784876760000,
          tagList: [{ name: "标签1" }, { name: "标签2" }],
        },
      },
    },
  },
};
const FAKE_HTML = `<html><script>window.__INITIAL_STATE__=${JSON.stringify(FAKE_STATE)}</script></html>`;

vi.stubGlobal("fetch", vi.fn(async () => ({ text: async () => FAKE_HTML } as any)));

const { buildApp } = await import("../app.js");

describe("POST /api/note（直接 curl 解析，不走 skill）", () => {
  beforeEach(() => {
    (global.fetch as any).mockImplementation(async () => ({
      text: async () => FAKE_HTML,
    }));
  });

  it("提取笔记元数据（标题/作者/赞藏评/时间/标签）", async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/note",
      payload: { url: "https://www.xiaohongshu.com/explore/abc?xsec_token=t" },
    });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(true);
    expect(body.data.meta.title).toBe("测试笔记");
    expect(body.data.meta.author).toBe("测试作者");
    expect(body.data.meta.likes).toBe("100");
    expect(body.data.meta.favs).toBe("50");
    expect(body.data.meta.comments).toBe("10");
    expect(body.data.meta.shares).toBe("5");
    expect(body.data.meta.tags).toEqual(["标签1", "标签2"]);
    expect(body.data.meta.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await app.close();
  });

  it("无效 url 返回失败", async () => {
    const app = await buildApp();
    const r = await app.inject({ method: "POST", url: "/api/note", payload: { url: "bad" } });
    expect(JSON.parse(r.body).success).toBe(false);
    await app.close();
  });

  it("页面无 __INITIAL_STATE__ 返回失败", async () => {
    (global.fetch as any).mockResolvedValueOnce({ text: async () => "<html>no data</html>" } as any);
    const app = await buildApp();
    const r = await app.inject({ method: "POST", url: "/api/note", payload: { url: "https://x.com/a" } });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain("__INITIAL_STATE__");
    await app.close();
  });

  it("noteDetailMap 为空返回失败", async () => {
    const empty = `<html><script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: {} } })}</script></html>`;
    (global.fetch as any).mockResolvedValueOnce({ text: async () => empty } as any);
    const app = await buildApp();
    const r = await app.inject({ method: "POST", url: "/api/note", payload: { url: "https://x.com/a" } });
    const body = JSON.parse(r.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain("noteDetailMap");
    await app.close();
  });
});

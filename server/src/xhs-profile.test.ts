import { describe, it, expect, beforeEach, vi } from "vitest";

/** 按 spike 实测结构构造假的 user.notes 嵌套数组。 */
function fakeNotes(count: number): any[] {
  const inner = Array.from({ length: count }, (_, i) => ({
    noteCard: {
      displayTitle: `笔记标题${i}`,
      time: 1750000000000 - i * 86400000,
      interactInfo: { likedCount: String(10 + i) },
    },
  }));
  return [inner, [], [], [], []];
}

function fakeHtml(notes: any[]): string {
  const state = {
    user: {
      notes,
      userPageData: {
        basicInfo: { nickname: "测试博主", desc: "测试简介" },
      },
    },
  };
  return `<html><script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script></html>`;
}

const { fetchBloggerProfile, isXhsProfileUrl } = await import("./xhs-profile.js");

describe("isXhsProfileUrl", () => {
  it("接受标准主页链接（含 www、http、带 query）", () => {
    expect(isXhsProfileUrl("https://www.xiaohongshu.com/user/profile/5ff0e641")).toBe(true);
    expect(isXhsProfileUrl("http://xiaohongshu.com/user/profile/abc")).toBe(true);
    expect(isXhsProfileUrl("https://www.xiaohongshu.com/user/profile/abc?xsec_token=t")).toBe(true);
  });
  it("拒绝非主页链接", () => {
    expect(isXhsProfileUrl("https://www.xiaohongshu.com/explore/abc")).toBe(false);
    expect(isXhsProfileUrl("https://www.bilibili.com/space/123")).toBe(false);
    expect(isXhsProfileUrl("不是链接")).toBe(false);
    expect(isXhsProfileUrl("")).toBe(false);
  });
});

describe("fetchBloggerProfile", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ text: async () => fakeHtml(fakeNotes(30)) } as any))
    );
  });

  it("提取博主昵称/简介和首屏笔记（标题/日期/点赞）", async () => {
    const p = await fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/5ff0e641");
    expect(p.nickname).toBe("测试博主");
    expect(p.desc).toBe("测试简介");
    expect(p.notes).toHaveLength(30);
    expect(p.notes[0].title).toBe("笔记标题0");
    expect(p.notes[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.notes[0].likes).toBe("10");
  });

  it("容错 SSR JSON 里的 undefined 字面量", async () => {
    const html = `<script>window.__INITIAL_STATE__={user:{notes:[[{noteCard:{displayTitle:"x",time:1750000000000,interactInfo:{likedCount:undefined}}},{noteCard:{displayTitle:"y",time:1750000000000,interactInfo:{likedCount:undefined}}},{noteCard:{displayTitle:"z",time:1750000000000,interactInfo:{likedCount:"3"}}}],[]],userPageData:{basicInfo:{nickname:undefined,desc:"d"}}}}</script>`;
    vi.stubGlobal("fetch", vi.fn(async () => ({ text: async () => html } as any)));
    const p = await fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/5ff0e641");
    expect(p.notes[0].likes).toBeUndefined();
    expect(p.desc).toBe("d");
  });

  it("日期按北京时间格式化（1750000000000 = 2025-06-15 23:06 北京 → 2025-06-15）", async () => {
    const p = await fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/5ff0e641");
    expect(p.notes[0].date).toBe("2025-06-15");
  });

  it("time 非法时 date 为 undefined 且不抛错", async () => {
    const html = fakeHtml([
      [
        { noteCard: { displayTitle: "a", time: "not-a-date", interactInfo: { likedCount: "1" } } },
        { noteCard: { displayTitle: "b", time: "not-a-date", interactInfo: { likedCount: "2" } } },
        { noteCard: { displayTitle: "c", time: "not-a-date", interactInfo: { likedCount: "3" } } },
      ],
      [],
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ text: async () => html } as any)));
    const p = await fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/5ff0e641");
    expect(p.notes[0].date).toBeUndefined();
    expect(p.notes).toHaveLength(3);
  });

  it("网络请求失败时包装为主页请求失败错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    await expect(
      fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/5ff0e641")
    ).rejects.toThrow("主页请求失败");
  });

  it("无 __INITIAL_STATE__ 时抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ text: async () => "<html>empty</html>" } as any)));
    await expect(
      fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/5ff0e641")
    ).rejects.toThrow("页面无 __INITIAL_STATE__");
  });

  it("首屏笔记 < 3 条时抛带指引的错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ text: async () => fakeHtml(fakeNotes(2)) } as any))
    );
    await expect(
      fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/5ff0e641")
    ).rejects.toThrow("主页抓取失败");
  });

  it("非小红书主页 URL 直接抛错（不发请求）", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchBloggerProfile("https://www.bilibili.com/space/1")).rejects.toThrow(
      "暂只支持小红书主页链接"
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

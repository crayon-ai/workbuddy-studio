import { describe, it, expect, beforeEach, vi } from "vitest";
import { fetchSources, type SourceItem } from "./sources.js";

/** 按 URL 分发返回假数据。 */
function mockFetchByUrl(handlers: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = String(input);
      for (const [key, body] of Object.entries(handlers)) {
        if (url.includes(key)) return { text: async () => body } as any;
      }
      throw new Error("no handler for " + url);
    })
  );
}

const BILI_JSON = JSON.stringify({
  data: {
    result: [
      {
        result_type: "video",
        data: [
          {
            type: "video",
            title: "测试<em class=\"keyword\">关键词</em>视频标题",
            author: "UP主A",
            play: 12345,
            pubdate: 1750000000,
            bvid: "BV1test",
          },
        ],
      },
    ],
  },
});

const BING_HTML = `<html><li class="b_algo"><h2><a href="https://zhuanlan.zhihu.com/p/1">知乎文章标题</a></h2><p>这是摘要文本内容</p></li></html>`;

const SOGOU_HTML = `<html><div class="tit"><a href="https://mp.weixin.qq.com/s/abc">公众号文章标题</a></div><p class="txt-info">公众号摘要</p></html>`;

const HN_JSON = JSON.stringify({
  hits: [
    {
      title: "Show HN: 测试项目",
      author: "hacker",
      points: 301,
      created_at: "2025-06-01T00:00:00Z",
      url: "https://example.com/project",
      objectID: "123",
    },
  ],
});

const DOUYIN_JSON = JSON.stringify({
  word_list: [{ word: "热点词", hot_value: 9999 }],
});

describe("fetchSources（后端直连 5 源，并行 + 降级）", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("并行抓取 5 个源并解析为扁平 SourceItem 列表", async () => {
    mockFetchByUrl({
      "api.bilibili.com": BILI_JSON,
      "cn.bing.com": BING_HTML,
      "weixin.sogou.com": SOGOU_HTML,
      "hn.algolia.com": HN_JSON,
      "iesdouyin.com": DOUYIN_JSON,
    });
    const items = await fetchSources("关键词");
    const pfs = new Set(items.map((i) => i.pf));
    expect(pfs).toEqual(new Set(["bili", "bing", "weixin", "hn", "douyin"]));

    const bili = items.find((i) => i.pf === "bili")!;
    expect(bili.title).toBe("测试关键词视频标题"); // <em> 已剥离
    expect(bili.author).toBe("UP主A");
    expect(bili.url).toBe("https://www.bilibili.com/video/BV1test");

    const bing = items.find((i) => i.pf === "bing")!;
    expect(bing.url).toBe("https://zhuanlan.zhihu.com/p/1");
    expect(bing.summary).toBe("这是摘要文本内容");

    const hn = items.find((i) => i.pf === "hn")!;
    expect(hn.url).toBe("https://example.com/project");
    expect(hn.heat).toContain("301");

    const douyin = items.find((i) => i.pf === "douyin")!;
    expect(douyin.url).toBe("https://www.douyin.com/search/" + encodeURIComponent("热点词"));
  });

  it("单个源失败不影响其他源（降级）", async () => {
    mockFetchByUrl({
      "hn.algolia.com": HN_JSON,
    });
    const items = await fetchSources("关键词");
    expect(items.map((i) => i.pf)).toEqual(["hn"]);
  });

  it("全部源失败返回空数组（不抛错）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const items = await fetchSources("关键词");
    expect(items).toEqual([]);
  });
});

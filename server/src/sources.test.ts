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

// 真实线上结构：h2 带 class 属性，标题含 <strong> 高亮，摘要在 b_caption 内含实体
const BING_HTML = `<html><ol><li class="b_algo" data-id iid="SERP.5342"><link rel="stylesheet" href="/rp/x.css"/><h2 class=""><a target="_blank" href="https://zhuanlan.zhihu.com/p/1" h="ID=SERP,5129.2">知乎<strong>关键词</strong>文章标题</a></h2><div class="b_caption"><p class="b_lineclamp2" data-rslinkclamp-iid="">2026年5月20日&ensp;&#0183;&ensp;这是摘要文本内容</p></div></li></ol></html>`;

// 真实线上结构：结果在 <li id="sogou_vr_*_box_N"> 内，文章是 /link?url= 相对跳转链
// （href 含 &amp; 实体），摘要 p.txt-info，作者 span.all-time-y2，时间藏于 timeConvert
const sogouTs = Math.floor(Date.now() / 1000) - 5 * 86400; // 5 天前（relDays 断言稳定）
const SOGOU_HTML = `<html><body>
<nav><a href="http://www.sogou.com/web?query=x">网页</a><a href="https://pic.sogou.com/pics?query=x">图片</a></nav>
<ul>
<li id="sogou_vr_11002601_box_0" d="ab1"><div class="txt-box">
<h3><a target="_blank" href="/link?url=dn9a_-gY295K0Rci&amp;type=2&amp;query=%E5%85%B3%E9%94%AE%E8%AF%8D" uigs="article_title_0">公众号<em><!--red_beg-->关键词<!--red_end--></em>文章标题</a></h3>
<p class="txt-info" id="sogou_vr_11002601_summary_0">公众号<em>关键词</em>摘要</p>
<div class="s-p"><span class="all-time-y2">作者公众号A</span><span class="s2"><script>document.write(timeConvert('${sogouTs}'))</script></span></div>
</div></li>
<li id="sogou_vr_11002601_box_1" d="ab2"><div class="txt-box">
<h3><a target="_blank" href="https://mp.weixin.qq.com/s/abc" uigs="article_title_1">绝对链接文章</a></h3>
</div></li>
</ul></body></html>`;

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
    expect(bing.title).toBe("知乎关键词文章标题"); // h2 带属性 + <strong> 高亮
    expect(bing.url).toBe("https://zhuanlan.zhihu.com/p/1");
    expect(bing.summary).toBe("2026年5月20日 · 这是摘要文本内容"); // &ensp;/&#0183; 实体解码

    const sogouItems = items.filter((i) => i.pf === "weixin");
    expect(sogouItems.map((i) => i.title)).toEqual([
      "公众号关键词文章标题",
      "绝对链接文章",
    ]); // 导航链接（网页/图片）不进入结果
    const wx = sogouItems[0];
    expect(wx.author).toBe("作者公众号A");
    expect(wx.summary).toBe("公众号关键词摘要");
    expect(wx.pub).toBe("5 天前"); // timeConvert 时间戳 → 相对时间
    expect(wx.url).toBe("https://weixin.sogou.com/link?url=dn9a_-gY295K0Rci&type=2&query=%E5%85%B3%E9%94%AE%E8%AF%8D"); // 相对链补全 + &amp; 解码
    expect(sogouItems[1].url).toBe("https://mp.weixin.qq.com/s/abc"); // 绝对链原样保留

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

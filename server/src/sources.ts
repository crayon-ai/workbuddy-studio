/**
 * 灵感抓取数据源：后端直连 5 个免登录态数据源（并行 curl，不经过 agent）。
 * 从「用 agent 跑 curl」优化而来——curl 是确定性工作，无需 AI 判断，
 * 后端并行直连可把「抓取」这步从几十秒压到几秒，agent 只做最后的筛选+格式化。
 *
 * 5 个源：B站搜索 / 必应全网 / 搜狗微信公众号 / HackerNews / 抖音热搜榜。
 * 任一源失败降级为空，不阻塞其他源（与 SKILL.md 旧约定一致）。
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface SourceItem {
  /** 平台 key：bili/bing/weixin/hn/douyin */
  pf: string;
  /** 平台显示名 */
  pfn: string;
  title: string;
  author: string;
  url: string;
  summary: string;
  /** 原始热度数值字符串（B站 play / HN points / 抖音 hot_value），无则空 */
  heat: string;
  /** 相对时间（如 "2 天前"），无则空 */
  pub: string;
}

/** 并行抓取 5 个源，扁平合并，任一源失败不影响其他。 */
export async function fetchSources(keywords: string): Promise<SourceItem[]> {
  const kw = encodeURIComponent(keywords);
  const settled = await Promise.allSettled([
    fetchBili(kw),
    fetchBing(kw),
    fetchSogouWeixin(kw),
    fetchHackerNews(kw),
    fetchDouyin(),
  ]);
  const out: SourceItem[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") out.push(...r.value);
  }
  return out.filter((i) => i.title && i.url);
}

/** 通用 GET text，带浏览器 UA。 */
async function getText(url: string, referer?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/json,application/xhtml+xml,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      ...(referer ? { Referer: referer } : {}),
    },
  });
  return res.text();
}

/** 剥离 <em> 等标签，还原纯文本标题。 */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

/** 秒级时间戳 → 相对时间（"N 天前" / "今天"）。 */
function relDays(sec: number): string {
  const days = Math.floor((Date.now() / 1000 - sec) / 86400);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return `${days} 天前`;
}

/** 源 1：B站搜索（JSON）。取 video 结果。 */
async function fetchBili(kw: string): Promise<SourceItem[]> {
  const json = await getText(
    `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${kw}&page=1&page_size=15`,
    "https://www.bilibili.com/"
  );
  const data = JSON.parse(json).data ?? {};
  const out: SourceItem[] = [];
  for (const block of data.result ?? []) {
    const list = block?.data ?? [];
    for (const item of list) {
      if (item?.type !== "video" || !item?.bvid) continue;
      out.push({
        pf: "bili",
        pfn: "B站",
        title: stripTags(item.title ?? ""),
        author: item.author ?? "",
        url: `https://www.bilibili.com/video/${item.bvid}`,
        summary: "",
        heat: item.play != null ? String(item.play) : "",
        pub: item.pubdate ? relDays(item.pubdate) : "",
      });
    }
  }
  return out;
}

/** 源 2：必应全网搜索（HTML）。提取 .b_algo 结果。 */
async function fetchBing(kw: string): Promise<SourceItem[]> {
  const html = await getText(`https://cn.bing.com/search?q=${kw}&count=15`);
  const out: SourceItem[] = [];
  const algoRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  for (const block of html.match(algoRe) ?? []) {
    const a = block.match(/<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({
      pf: "bing",
      pfn: "全网",
      title: stripTags(a[2]),
      author: "",
      url: a[1],
      summary: p ? stripTags(p[1]) : "",
      heat: "",
      pub: "",
    });
  }
  return out;
}

/** 源 3：搜狗微信公众号搜索（HTML）。提取含 weixin 链接的标题。 */
async function fetchSogouWeixin(kw: string): Promise<SourceItem[]> {
  const html = await getText(`https://weixin.sogou.com/weixin?type=2&query=${kw}&ie=utf8`);
  const out: SourceItem[] = [];
  const aRe = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html)) !== null) {
    const href = m[1];
    const title = stripTags(m[2]);
    if (!title || !/weixin|mp\.weixin|sogou/.test(href)) continue;
    out.push({
      pf: "weixin",
      pfn: "微信",
      title,
      author: "",
      url: href,
      summary: "",
      heat: "",
      pub: "",
    });
  }
  return out;
}

/** 源 4：HackerNews Algolia 搜索（JSON）。 */
async function fetchHackerNews(kw: string): Promise<SourceItem[]> {
  const json = await getText(
    `https://hn.algolia.com/api/v1/search?query=${kw}&tags=story&hitsPerPage=10`
  );
  const hits = JSON.parse(json).hits ?? [];
  return hits.map((h: any) => ({
    pf: "hn",
    pfn: "HackerNews",
    title: h.title ?? "",
    author: h.author ?? "",
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    summary: "",
    heat: h.points != null ? String(h.points) : "",
    pub: h.created_at ? relDays(Date.parse(h.created_at) / 1000) : "",
  }));
}

/** 源 5：抖音热搜榜（JSON，非关键词，当下大众热点）。 */
async function fetchDouyin(): Promise<SourceItem[]> {
  const json = await getText("https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/");
  const words = JSON.parse(json).word_list ?? [];
  return words.map((w: any) => ({
    pf: "douyin",
    pfn: "抖音",
    title: w.word ?? "",
    author: "",
    url: `https://www.douyin.com/search/${encodeURIComponent(w.word ?? "")}`,
    summary: "",
    heat: w.hot_value != null ? String(w.hot_value) : "",
    pub: "",
  }));
}

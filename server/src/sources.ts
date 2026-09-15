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

/** 常见 HTML 实体解码（必应摘要的 &ensp;/&#0183;、搜狗链接的 &amp; 等）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch {
        return _;
      }
    })
    .replace(/&(nbsp|ensp|emsp|thinsp);/gi, " ")
    .replace(/&middot;/gi, "·")
    .replace(/&hellip;/gi, "…")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&ldquo;/gi, "“")
    .replace(/&rdquo;/gi, "”")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rsquo;/gi, "’")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** 剥离 <em>/<strong>/HTML 注释等标签，解码实体，压缩空白，还原纯文本标题。 */
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
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
    // 线上 h2 带属性（如 <h2 class="">），不能假定 <h2><a 紧邻
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    // 摘要优先取 b_caption 容器内的段落，取不到再退回块内任意 <p>
    const p =
      block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({
      pf: "bing",
      pfn: "全网",
      title: stripTags(a[2]),
      author: "",
      url: decodeEntities(a[1]),
      summary: p ? stripTags(p[1]) : "",
      heat: "",
      pub: "",
    });
  }
  return out;
}

/** 源 3：搜狗微信公众号搜索（HTML）。
 *  每条结果是一个 <li id="sogou_vr_*_box_N">：h3 内是文章跳转链（/link?url=… 相对路径，
 *  302 到 mp.weixin.qq.com，需补全域名），p.txt-info 是摘要，span.all-time-y2 是公众号名。
 *  站内导航链接（资讯/网页/知乎等）不在结果 li 内，按块解析天然排除。 */
async function fetchSogouWeixin(kw: string): Promise<SourceItem[]> {
  const html = await getText(`https://weixin.sogou.com/weixin?type=2&query=${kw}&ie=utf8`);
  const out: SourceItem[] = [];
  const liRe = /<li[^>]*id="sogou_vr[^"]*box_\d+"[^>]*>([\s\S]*?)<\/li>/g;
  for (const [, body] of html.matchAll(liRe)) {
    const a = body.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const href = decodeEntities(a[1]);
    // 只收文章链：/link?url=… 跳转链或 mp.weixin 绝对链，防误收站内链接
    if (!/^\/link\?url=|^https?:\/\/[^/]*weixin\./.test(href)) continue;
    const p = body.match(/<p class="txt-info"[^>]*>([\s\S]*?)<\/p>/);
    const author = body.match(/<span class="all-time-y2">([^<]*)<\/span>/);
    // 发布时间藏在 timeConvert('秒级时间戳') 里
    const ts = body.match(/timeConvert\('(\d+)'\)/);
    out.push({
      pf: "weixin",
      pfn: "微信",
      title: stripTags(a[2]),
      author: author ? stripTags(author[1]) : "",
      url: href.startsWith("/") ? `https://weixin.sogou.com${href}` : href,
      summary: p ? stripTags(p[1]) : "",
      heat: "",
      pub: ts ? relDays(Number(ts[1])) : "",
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

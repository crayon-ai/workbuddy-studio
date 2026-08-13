import type { FastifyPluginCallback } from "fastify";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface NoteMeta {
  title?: string;
  author?: string;
  date?: string;
  likes?: string;
  favs?: string;
  comments?: string;
  shares?: string;
  tags?: string[];
  noteId?: string;
  url?: string;
}

/**
 * 直接 curl 笔记页 HTML，从 __INITIAL_STATE__.note.noteDetailMap 提取元数据。
 * 不走 skill、不调 LLM、不下载媒体——有效链接 SSR 本就含数据，几秒返回。
 */
async function fetchNoteMeta(url: string): Promise<NoteMeta> {
  const html: string = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: "https://www.xiaohongshu.com/",
    },
  }).then((r) => r.text());

  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) throw new Error("页面无 __INITIAL_STATE__（链接失效或被反爬）");

  let state: any;
  try {
    // SSR 的 JSON 可能含 JS 字面量 undefined，替换为 null 再 parse
    state = JSON.parse(
      m[1].replace(/:\s*undefined/g, ":null").replace(/,\s*undefined/g, ",null")
    );
  } catch (e: any) {
    throw new Error("解析页面数据失败: " + (e?.message ?? e));
  }

  const map = state?.note?.noteDetailMap || {};
  const ids = Object.keys(map);
  if (!ids.length) throw new Error("noteDetailMap 为空（笔记可能已失效或需登录）");

  const n = map[ids[0]].note || map[ids[0]];
  const inter = n.interactInfo || {};
  const date = n.time ? new Date(n.time).toISOString().slice(0, 10) : undefined;

  return {
    title: n.title,
    author: n.user?.nickname,
    date,
    likes: inter.likedCount != null ? String(inter.likedCount) : undefined,
    favs: inter.collectedCount != null ? String(inter.collectedCount) : undefined,
    comments: inter.commentCount != null ? String(inter.commentCount) : undefined,
    shares: inter.shareCount != null ? String(inter.shareCount) : undefined,
    tags: Array.isArray(n.tagList)
      ? n.tagList.map((t: any) => t?.name).filter(Boolean)
      : [],
    noteId: n.noteId,
    url,
  };
}

export const noteRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post("/api/note", async (req) => {
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url || !/^https?:\/\//.test(url)) {
      return { success: false, data: null, error: "url 无效" };
    }
    try {
      const meta = await fetchNoteMeta(url);
      if (!meta.title) {
        return {
          success: false,
          data: null,
          error: "未提取到笔记标题（链接失效或非笔记页？）",
        };
      }
      return { success: true, data: { meta } };
    } catch (e: any) {
      return { success: false, data: null, error: e?.message ?? String(e) };
    }
  });
  done();
};
